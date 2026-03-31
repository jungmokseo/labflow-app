/**
 * 미니브레인 (Lab Memory) Routes — 4층 기억 구조 (메타기억 포함) + 의도 분류 + 멀티홉 질의 체이닝
 *
 * POST   /api/brain/chat              → 미니브레인 대화 (4층 기억 + 멀티홉 DB 조회)
 * GET    /api/brain/channels           → 사용자 채널 목록
 * POST   /api/brain/channels           → 새 채널 생성
 * GET    /api/brain/channels/:id       → 채널 메시지 목록
 * DELETE /api/brain/channels/:id       → 채널 삭제
 * POST   /api/brain/memo               → 메모 저장 (수동)
 * GET    /api/brain/search             → Lab Memory 자연어 검색
 * GET    /api/brain/stale/:labId       → 오래된 정보 목록 (confidence < threshold)
 * POST   /api/brain/verify/:memoryId   → 정보 최신 확인 처리
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import { aiRateLimiter } from '../middleware/rate-limiter.js';
import { env } from '../config/env.js';
import { generateEmbedding, searchPapers } from '../services/embedding-service.js';

// ══════════════════════════════════════════════════════
//  LAYER 4: METAMEMORY — 신뢰도 계산 & 접근 추적
// ══════════════════════════════════════════════════════

/**
 * 메타기억 신뢰도 계산
 * - 시간 경과에 따라 confidence가 감소 (반감기: 6개월)
 * - 자주 조회되는 정보는 감소 속도가 느림 (accessCount로 보정)
 * - lastVerified가 있으면 그 시점부터 감소 시작
 */
function calculateConfidence(record: {
  confidence: number;
  createdAt: Date;
  lastVerified?: Date | null;
  accessCount: number;
  lastAccessed?: Date | null;
}): number {
  const now = Date.now();
  const baseDate = record.lastVerified?.getTime() || record.createdAt.getTime();
  const daysSinceBase = (now - baseDate) / (1000 * 60 * 60 * 24);

  // 반감기: 180일 (6개월). 자주 조회되면 반감기가 늘어남
  // accessCount 10회 → 반감기 2배 (360일), 50회 → 반감기 3배 (540일)
  const accessBoost = 1 + Math.log10(Math.max(record.accessCount, 1));
  const halfLife = 180 * accessBoost;

  // 지수 감쇠: confidence = base * 2^(-days/halfLife)
  const decayFactor = Math.pow(2, -daysSinceBase / halfLife);
  const computed = record.confidence * decayFactor;

  return Math.max(0, Math.min(1, Number(computed.toFixed(3))));
}

/**
 * 오래된 정보에 대한 경고 메시지 생성
 */
function getStaleWarning(confidence: number, createdAt: Date, lastVerified?: Date | null): string | null {
  if (confidence >= 0.7) return null;

  const refDate = lastVerified || createdAt;
  const monthsAgo = Math.floor((Date.now() - refDate.getTime()) / (1000 * 60 * 60 * 24 * 30));

  if (confidence < 0.3) {
    return `⚠️ 이 정보는 ${monthsAgo}개월 전에 등록되었으며, 신뢰도가 매우 낮습니다 (${(confidence * 100).toFixed(0)}%). 최신 정보인지 반드시 확인해 주세요.`;
  }
  if (confidence < 0.5) {
    return `⚠️ 이 정보는 ${monthsAgo}개월 전에 등록되었습니다. 최신 정보인지 확인이 필요할 수 있습니다 (신뢰도 ${(confidence * 100).toFixed(0)}%).`;
  }
  return `ℹ️ 이 정보는 ${monthsAgo}개월 전 기준입니다 (신뢰도 ${(confidence * 100).toFixed(0)}%).`;
}

/**
 * Lab Memory 항목 조회 시 accessCount/lastAccessed 업데이트 (비동기, fire-and-forget)
 */
async function trackAccess(table: 'memo' | 'labMember' | 'project' | 'publication', ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const now = new Date();
  try {
    // Prisma에서 테이블별로 updateMany는 where.id.in 지원
    const updatePromises = ids.map(id =>
      (prisma as any)[table].update({
        where: { id },
        data: {
          accessCount: { increment: 1 },
          lastAccessed: now,
        },
      }).catch(() => {}) // 개별 실패 무시
    );
    await Promise.all(updatePromises);
  } catch {
    // 접근 추적 실패는 무시
  }
}

// ── Schemas ─────────────────────────────────────────
const chatSchema = z.object({
  channelId: z.string().optional(),
  message: z.string().min(1),
  fileId: z.string().optional(),  // 업로드된 파일 참조 (brain/upload의 fileId)
  tool: z.enum([
    'general',       // 기본 대화 (intent 자동 분류 + 즉시 액션 포함)
    'email',         // 📧 이메일 브리핑 (영구 세션)
    'papers',        // 📚 논문 검색/알림 (영구 세션)
    'meeting',       // 🎙️ 미팅 관련 (영구 세션)
    'calendar',      // 📅 캘린더/일정 (영구 세션)
  ]).default('general'),
});

const createChannelSchema = z.object({
  type: z.enum(['BRAIN', 'MEETING', 'PAPER', 'EMAIL']).default('BRAIN'),
  name: z.string().optional(),
});

const memoSchema = z.object({
  content: z.string().min(1),
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
  source: z.string().default('manual'),
});

const searchSchema = z.object({
  query: z.string().min(1),
  type: z.enum(['all', 'memo', 'project', 'publication', 'member', 'meeting']).default('all'),
});

// ══════════════════════════════════════════════════════
//  INTENT CLASSIFICATION — multi_hop 포함
// ══════════════════════════════════════════════════════

type Intent =
  | 'query_project' | 'query_publication' | 'query_member' | 'query_meeting'
  | 'multi_hop'     // 복합 질의 (여러 DB 조합)
  | 'query_stale'   // 오래된/신뢰도 낮은 정보 조회 (메타기억)
  | 'save_memo' | 'search_memory' | 'general_chat' | 'add_dict'
  | 'capture_create' | 'capture_list' | 'capture_complete'
  | 'daily_brief'   // /today — 오늘 우선순위 브리핑
  | 'emerge'        // /emerge — 숨겨진 연결 발견
  | 'weekly_review'  // /weekly — 주간 리뷰
  | 'fallback_search'; // Intent 분류 실패 시 DB 범용 검색

interface ClassifiedIntent {
  intent: Intent;
  entities: Record<string, string>;
  // multi_hop 전용: 어떤 엔티티 체인이 필요한지
  hops?: Array<{
    step: number;
    source: 'member' | 'project' | 'publication' | 'memo' | 'dict';
    lookup: string;  // 검색할 키워드/이름
    extract: string; // 추출할 필드 (name, email, pm, funder, etc)
  }>;
}

async function classifyIntent(message: string): Promise<ClassifiedIntent> {
  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const prompt = `사용자 메시지의 의도를 분류하세요. JSON으로만 응답하세요.

의도 목록:
- query_project: 단순 과제 질문 (과제 목록, 특정 과제 정보)
- query_publication: 단순 논문 질문 (논문 수, 저널 등)
- query_member: 단순 구성원 질문 (연락처, 역할 등)
- query_meeting: 미팅 관련 질문
- multi_hop: **복합 질의** — 두 종류 이상의 DB를 조합해야 답할 수 있는 질문. 예:
  - "김태영이 참여 중인 과제" (구성원→과제)
  - "TIPS 과제 학생들 이메일" (과제→구성원→이메일)
  - "Nature Communications 논문 저자 연락처" (논문→저자→구성원→연락처)
  - "hemostatic hydrogel 담당자 연락처" (키워드→과제→PM→구성원)
- save_memo: 메모 저장 요청
- search_memory: 과거 정보 검색
- add_dict: 용어 교정 등록
- query_stale: 오래된 정보, 업데이트 필요한 정보, 신뢰도 낮은 정보 질문 (예: "오래된 정보 보여줘", "업데이트 필요한 거 있어?", "확인이 필요한 정보", "신뢰도 낮은 정보")
- capture_create: 빠른 캡처 생성 (메모/태스크/아이디어 기록 요청). 예: "이거 메모해줘", "할 일 추가", "아이디어 저장"
- capture_list: 캡처 목록 조회 요청. 예: "캡처 보여줘", "할 일 목록", "아이디어 뭐 있어?"
- capture_complete: 캡처 완료 처리. 예: "이거 완료", "다 했어", "태스크 끝"
- daily_brief: 오늘 브리핑/우선순위 요청. 예: "오늘 할 일", "today", "오늘 브리핑", "오늘 뭐해야 해?"
- emerge: 숨겨진 연결/패턴 발견 요청. 예: "아이디어 연결 찾아줘", "패턴 찾아", "emerge", "숨겨진 연결", "연구 교차점"
- weekly_review: 주간 리뷰/정리 요청. 예: "이번 주 정리", "주간 리뷰", "이번주 뭐 했지?", "weekly"
- general_chat: 일반 대화

multi_hop인 경우 "hops" 배열을 추가하세요:
- step: 순서 (1, 2, 3)
- source: 조회할 DB (member, project, publication, memo, dict)
- lookup: 검색 키워드
- extract: 추출할 필드

사용자 메시지: "${message}"

응답 예시:
단순: {"intent": "query_member", "entities": {"name": "김태영"}}
복합: {"intent": "multi_hop", "entities": {"query": "TIPS 과제 학생 이메일"}, "hops": [
  {"step": 1, "source": "project", "lookup": "TIPS", "extract": "pm"},
  {"step": 2, "source": "member", "lookup": "(step1 결과의 pm)", "extract": "email"}
]}`;

    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    const match = text.match(/\{.*\}/s);
    if (match) {
      return JSON.parse(match[0]);
    }
  } catch (err) {
    console.warn('Intent classification failed:', err);
  }
  // Intent 분류 실패 시 DB 범용 검색 우선 시도 (할루시네이션 방지)
  return { intent: 'fallback_search', entities: { query: '' } };
}

// ══════════════════════════════════════════════════════
//  MULTI-HOP QUERY CHAINING ENGINE
// ══════════════════════════════════════════════════════

interface HopResult {
  step: number;
  source: string;
  found: boolean;
  data: any[];
  summary: string;
}

async function executeMultiHopQuery(
  message: string,
  entities: Record<string, string>,
  hops: ClassifiedIntent['hops'],
  labId: string,
): Promise<string> {
  // 모든 데이터를 미리 로드 (소규모 연구실이므로 전량 로드가 효율적)
  const [members, projects, publications, memos] = await Promise.all([
    prisma.labMember.findMany({ where: { labId, active: true } }),
    prisma.project.findMany({ where: { labId } }),
    prisma.publication.findMany({ where: { labId } }),
    prisma.memo.findMany({ where: { labId }, orderBy: { createdAt: 'desc' }, take: 50 }),
  ]);

  const lab = await prisma.lab.findUnique({ where: { id: labId } });

  // 텍스트에서 엔티티를 퍼지 매칭하는 헬퍼
  const fuzzy = (text: string, keyword: string) =>
    text.toLowerCase().includes(keyword.toLowerCase());

  // 멀티홉이 명시적 hops를 갖고 있으면 그대로 실행, 아니면 AI 분석 결과로 체이닝
  // 여기서는 메시지를 직접 분석하여 관계를 추적하는 범용 체이닝 엔진을 구현

  const chainResults: HopResult[] = [];
  const queryLower = message.toLowerCase();

  // ── 1단계: 메시지에서 참조되는 모든 엔티티 식별 ──
  const mentionedMembers = members.filter(m => fuzzy(message, m.name));
  const mentionedProjects = projects.filter(p =>
    fuzzy(message, p.name) ||
    (p.funder && fuzzy(message, p.funder)) ||
    (p.number && fuzzy(message, p.number))
  );
  const mentionedPubs = publications.filter(p =>
    fuzzy(message, p.title) ||
    (p.journal && fuzzy(message, p.journal))
  );

  // ── 2단계: 관계 체이닝 ──

  // 패턴 A: 구성원 → 과제 ("김태영이 참여 중인 과제")
  if (mentionedMembers.length > 0 && (queryLower.includes('과제') || queryLower.includes('프로젝트'))) {
    for (const member of mentionedMembers) {
      const relatedProjects = projects.filter(p =>
        p.pm?.includes(member.name) ||
        p.pm?.includes(member.name.slice(1)) // 성 제거 매칭 (태영, 수아 등)
      );
      chainResults.push({
        step: 1, source: 'member→project', found: relatedProjects.length > 0,
        data: relatedProjects,
        summary: relatedProjects.length > 0
          ? `${member.name}님이 담당(PM)인 과제:\n` +
            relatedProjects.map(p => `📋 ${p.name}\n  지원기관: ${p.funder || '미등록'}\n  기간: ${p.period || '미등록'}`).join('\n\n')
          : `${member.name}님이 PM으로 등록된 과제가 없습니다.`,
      });
    }
  }

  // 패턴 B: 과제 → 구성원/PM ("TIPS 과제 담당자/학생")
  if (mentionedProjects.length > 0 && (queryLower.includes('담당') || queryLower.includes('학생') || queryLower.includes('PM') || queryLower.includes('이메일') || queryLower.includes('연락처'))) {
    for (const proj of mentionedProjects) {
      const pmNames = (proj.pm || '').split(/[/,]/).map(s => s.trim()).filter(Boolean);
      const pmMembers = pmNames.flatMap(name =>
        members.filter(m => m.name.includes(name) || name.includes(m.name.slice(1)))
      );
      chainResults.push({
        step: 1, source: 'project→member', found: pmMembers.length > 0,
        data: pmMembers,
        summary: pmMembers.length > 0
          ? `📋 **${proj.name}** 담당자:\n` +
            pmMembers.map(m => `👤 ${m.name} (${m.role})\n  이메일: ${m.email || '미등록'}\n  연락처: ${m.phone || '미등록'}`).join('\n\n')
          : `📋 **${proj.name}**의 PM: ${proj.pm || '미등록'}\n(구성원 DB에서 상세 정보를 찾지 못했습니다)`,
      });
    }
  }

  // 패턴 C: 논문 → 저자/구성원 ("Nature Communications 논문 저자")
  if (mentionedPubs.length > 0 && (queryLower.includes('저자') || queryLower.includes('교신') || queryLower.includes('누구') || queryLower.includes('이메일') || queryLower.includes('연락처'))) {
    for (const pub of mentionedPubs) {
      const authorNames = (pub.authors || '').split(/[,&]/).map(s => s.trim()).filter(Boolean);
      const authorMembers = authorNames.flatMap(name =>
        members.filter(m => name.includes(m.name) || m.name.includes(name))
      );
      chainResults.push({
        step: 1, source: 'publication→member', found: true,
        data: authorMembers,
        summary: `📄 **${pub.title}**\n저널: ${pub.journal || '미등록'} (${pub.year || ''})\n저자: ${pub.authors || '미등록'}\n` +
          (authorMembers.length > 0
            ? '\n연구실 소속 저자:\n' + authorMembers.map(m =>
                `👤 ${m.name} (${m.role})\n  이메일: ${m.email || '미등록'}\n  연락처: ${m.phone || '미등록'}`
              ).join('\n')
            : ''),
      });
    }
  }

  // 패턴 D: 키워드 → 과제 → PM → 연락처 (가장 복잡한 체이닝)
  if (chainResults.length === 0 && (queryLower.includes('담당') || queryLower.includes('연락') || queryLower.includes('이메일'))) {
    // 키워드로 과제 검색
    const keyword = entities.query || entities.lookup || message.replace(/[의의에서로를]/g, ' ').trim();
    const matchedProjects = projects.filter(p =>
      fuzzy(p.name, keyword) || (p.funder && fuzzy(p.funder, keyword))
    );

    if (matchedProjects.length > 0) {
      const allPmNames = matchedProjects.flatMap(p =>
        (p.pm || '').split(/[/,]/).map(s => s.trim()).filter(Boolean)
      );
      const uniquePmMembers = [...new Set(allPmNames)].flatMap(name =>
        members.filter(m => m.name.includes(name) || name.includes(m.name.slice(1)))
      );

      chainResults.push({
        step: 1, source: 'keyword→project→member', found: uniquePmMembers.length > 0,
        data: uniquePmMembers,
        summary: matchedProjects.map(p =>
          `📋 **${p.name}**\n  PM: ${p.pm || '미등록'}`
        ).join('\n') + '\n\n' +
          (uniquePmMembers.length > 0
            ? '담당자 연락처:\n' + uniquePmMembers.map(m =>
                `👤 ${m.name} (${m.role})\n  이메일: ${m.email || '미등록'}\n  연락처: ${m.phone || '미등록'}`
              ).join('\n')
            : ''),
      });
    }
  }

  // 패턴 E: 사사 문구 질의 — 빈 프로필 유도형 응답
  if (queryLower.includes('사사') || queryLower.includes('acknowledgment')) {
    const projsWithAck = projects.filter(p => p.acknowledgment);
    if (projsWithAck.length > 0) {
      chainResults.push({
        step: 1, source: 'project.acknowledgment', found: true,
        data: projsWithAck,
        summary: projsWithAck.map(p =>
          `📋 **${p.name}**\n사사 문구: ${p.acknowledgment}`
        ).join('\n\n'),
      });
    } else {
      // 유도형 응답 — 등록을 제안
      const labAck = lab?.acknowledgment;
      if (labAck) {
        chainResults.push({
          step: 1, source: 'lab.acknowledgment', found: true,
          data: [{ acknowledgment: labAck }],
          summary: `연구실 기본 사사 문구:\n"${labAck}"\n\n개별 과제 사사 문구는 아직 등록되지 않았습니다. 과제별 사사 문구를 등록하시겠어요?`,
        });
      } else {
        return '등록된 사사 문구가 없습니다. 연구실 기본 사사 문구나 개별 과제 사사 문구를 등록하시겠어요?\n\n예시: "NRF 과제 사사 문구는 This work was supported by..."라고 알려주시면 저장해 드립니다.';
      }
    }
  }

  // 패턴 F: KnowledgeGraph 기반 관계 조회 ("XX 과제에 누가 참여해?")
  if (chainResults.length === 0) {
    const queryLower2 = message.toLowerCase();
    if (queryLower2.includes('참여') || queryLower2.includes('관계') || queryLower2.includes('연결')) {
      const userId = (await prisma.lab.findUnique({ where: { id: labId } }))?.ownerId;
      if (userId) {
        const edges = await prisma.knowledgeEdge.findMany({
          where: { relation: 'participates_in' },
          include: { fromNode: true, toNode: true },
        });
        // 질문에 언급된 프로젝트의 참여자 찾기
        for (const proj of mentionedProjects) {
          const projEdges = edges.filter(e => e.toNode.name === proj.name || e.toNode.entityId === proj.id);
          if (projEdges.length > 0) {
            chainResults.push({
              step: 1, source: 'knowledge_graph', found: true,
              data: projEdges,
              summary: `📋 **${proj.name}** 참여자 (Knowledge Graph):\n` +
                projEdges.map(e => `👤 ${e.fromNode.name}`).join('\n'),
            });
          }
        }
      }
    }
  }

  // ── 결과 종합 ──
  if (chainResults.length > 0) {
    return chainResults.map(r => r.summary).join('\n\n---\n\n');
  }

  // 어떤 패턴에도 매칭 안 됨 — 범용 검색 시도
  return await fallbackCrossSearch(message, labId, members, projects, publications, memos);
}

// 범용 교차 검색 (패턴 매칭 실패 시)
async function fallbackCrossSearch(
  message: string,
  labId: string,
  members: any[],
  projects: any[],
  publications: any[],
  memos: any[],
): Promise<string> {
  const words = message.replace(/[?？을를이가에서의]/g, ' ').split(/\s+/).filter(w => w.length > 1);
  const results: string[] = [];

  for (const word of words) {
    const matchedM = members.filter(m => m.name.includes(word));
    const matchedP = projects.filter(p =>
      p.name.includes(word) || p.funder?.includes(word) || p.pm?.includes(word)
    );
    const matchedPub = publications.filter(p =>
      p.title.includes(word) || p.journal?.includes(word) || p.authors?.includes(word)
    );
    const matchedMemo = memos.filter(m => m.content.includes(word));

    if (matchedM.length) results.push(`👤 구성원: ${matchedM.map(m => `${m.name}(${m.role})`).join(', ')}`);
    if (matchedP.length) results.push(`📋 과제: ${matchedP.map(p => p.name.slice(0, 40)).join(', ')}`);
    if (matchedPub.length) results.push(`📄 논문: ${matchedPub.map(p => p.title.slice(0, 40)).join(', ')}`);
    if (matchedMemo.length) {
      // Source별 분류하여 표시
      const faqMatches = matchedMemo.filter(m => m.source === 'faq');
      const regMatches = matchedMemo.filter(m => m.source === 'regulation');
      const otherMatches = matchedMemo.filter(m => !['faq', 'regulation'].includes(m.source));
      if (faqMatches.length) results.push(`❓ FAQ: ${faqMatches.map(m => m.title || m.content.slice(0, 30)).join(', ')}`);
      if (regMatches.length) results.push(`📖 규정: ${regMatches.map(m => m.title || m.content.slice(0, 30)).join(', ')}`);
      if (otherMatches.length) results.push(`💡 메모: ${otherMatches.length}개 관련 메모`);
    }
  }

  if (results.length > 0) {
    return '관련 정보를 찾았습니다:\n\n' + results.join('\n');
  }

  return ''; // 빈 문자열 = DB에 관련 정보 없음
}

// ══════════════════════════════════════════════════════
//  SINGLE-HOP DB QUERY (기존 로직 유지 + 유도형 응답)
// ══════════════════════════════════════════════════════

async function handleDbQuery(intent: Intent, entities: Record<string, string>, labId: string, userId: string, message: string): Promise<string | null> {
  switch (intent) {
    case 'query_project': {
      const projects = await prisma.project.findMany({ where: { labId } });
      if (projects.length === 0) return '등록된 과제가 없습니다. 과제 정보를 등록하시겠어요? "OO 과제 추가해줘"라고 말씀해 주세요.';

      const keyword = entities.projectName || entities.query || '';
      if (keyword) {
        const matched = projects.filter(p =>
          p.name.toLowerCase().includes(keyword.toLowerCase()) ||
          (p.funder && p.funder.toLowerCase().includes(keyword.toLowerCase())) ||
          (p.number && p.number.includes(keyword))
        );
        if (matched.length > 0) {
          // 메타기억: 접근 추적 + 신뢰도 경고
          trackAccess('project', matched.map(p => p.id)).catch(() => {});
          return matched.map(p => {
            const conf = calculateConfidence(p);
            const warning = getStaleWarning(conf, p.createdAt, p.lastVerified);
            return `📋 **${p.name}**\n  과제번호: ${p.number || '미등록'}\n  지원기관: ${p.funder || '미등록'}\n  기간: ${p.period || '미등록'}\n  PM: ${p.pm || '미등록'}\n  사사문구: ${p.acknowledgment || '미등록 — 등록하시겠어요?'}` +
              (warning ? `\n  ${warning}` : '');
          }).join('\n\n');
        }
        return `"${keyword}"에 해당하는 과제를 찾지 못했습니다. 등록된 과제 ${projects.length}건 중에 해당 키워드가 없습니다.`;
      }
      trackAccess('project', projects.map(p => p.id)).catch(() => {});
      return `총 ${projects.length}개 과제가 등록되어 있습니다:\n\n` +
        projects.map(p => `• ${p.name} (${p.funder || '미등록'}) [${p.status}]`).join('\n');
    }

    case 'query_publication': {
      const pubs = await prisma.publication.findMany({ where: { labId }, orderBy: { year: 'desc' } });
      if (pubs.length === 0) return '등록된 논문이 없습니다. 논문 정보를 등록하시겠어요?';

      const keyword = entities.query || '';
      if (keyword) {
        const matched = pubs.filter(p =>
          p.title.toLowerCase().includes(keyword.toLowerCase()) ||
          (p.journal && p.journal.toLowerCase().includes(keyword.toLowerCase())) ||
          (p.authors && p.authors.toLowerCase().includes(keyword.toLowerCase()))
        );
        if (matched.length > 0) {
          trackAccess('publication', matched.map(p => p.id)).catch(() => {});
          return matched.map(p => {
            const conf = calculateConfidence(p);
            const warning = getStaleWarning(conf, p.createdAt, p.lastVerified);
            return `📄 **${p.title}**\n  저널: ${p.journal || '미등록'} (${p.year || ''})\n  저자: ${p.authors || '미등록'}\n  DOI: ${p.doi || '미등록'}` +
              (warning ? `\n  ${warning}` : '');
          }).join('\n\n');
        }
        return `"${keyword}"에 해당하는 논문을 찾지 못했습니다. 등록된 논문 ${pubs.length}편 중에 해당 키워드가 없습니다.`;
      }
      return `총 ${pubs.length}편의 논문이 등록되어 있습니다.\n\n` +
        pubs.slice(0, 10).map(p => `• ${p.title} (${p.journal || ''}, ${p.year || ''})`).join('\n');
    }

    case 'query_member': {
      const members = await prisma.labMember.findMany({ where: { labId, active: true } });
      if (members.length === 0) return '등록된 구성원이 없습니다. 구성원 정보를 등록하시겠어요?';

      const rawName = entities.name || entities.query || '';
      // "김민수 학생" → "김민수" 로 정제 (역할 접미사 제거)
      const name = rawName.replace(/\s*(학생|교수|박사|석사|연구원|인턴|포닥)$/, '').trim();
      if (name) {
        const matched = members.filter(m =>
          m.name.includes(name) || name.includes(m.name) || (m.email && m.email.includes(name))
        );
        if (matched.length > 0) {
          trackAccess('labMember', matched.map(m => m.id)).catch(() => {});
          return matched.map(m => {
            const conf = calculateConfidence(m);
            const warning = getStaleWarning(conf, m.createdAt, m.lastVerified);
            return `👤 **${m.name}** (${m.role})\n  이메일: ${m.email || '미등록'}\n  연락처: ${m.phone || '미등록'}` +
              (warning ? `\n  ${warning}` : '');
          }).join('\n\n');
        }
        return `"${name}"에 해당하는 구성원을 찾지 못했습니다. 등록하시겠어요? "${name} 학생 추가해줘"라고 말씀해 주세요.`;
      }
      return `총 ${members.length}명의 구성원이 등록되어 있습니다:\n\n` +
        members.map(m => `• ${m.name} (${m.role}) — ${m.email || '이메일 미등록'}`).join('\n');
    }

    case 'query_meeting': {
      const meetings = await prisma.meeting.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 5,
      });
      if (meetings.length === 0) return '저장된 미팅 기록이 없습니다. 미팅을 녹음하고 정리해 보시겠어요?';
      return meetings.map(m =>
        `🎙️ **${m.title}** (${m.createdAt.toLocaleDateString('ko-KR')})\n  ${m.summary?.slice(0, 200) || '요약 없음'}...`
      ).join('\n\n');
    }

    case 'query_stale': {
      // 메타기억: 오래되거나 신뢰도 낮은 정보 목록
      const [memos, members, projects, pubs] = await Promise.all([
        prisma.memo.findMany({ where: { labId } }),
        prisma.labMember.findMany({ where: { labId, active: true } }),
        prisma.project.findMany({ where: { labId } }),
        prisma.publication.findMany({ where: { labId } }),
      ]);

      type StaleItem = { type: string; name: string; confidence: number; ageMonths: number; id: string };
      const staleItems: StaleItem[] = [];

      for (const m of memos) {
        const conf = calculateConfidence(m);
        if (conf < 0.7) {
          const ageMonths = Math.floor((Date.now() - m.createdAt.getTime()) / (1000 * 60 * 60 * 24 * 30));
          staleItems.push({ type: '메모', name: m.title || m.content.slice(0, 40), confidence: conf, ageMonths, id: m.id });
        }
      }
      for (const p of projects) {
        const conf = calculateConfidence(p);
        if (conf < 0.7) {
          const ageMonths = Math.floor((Date.now() - p.createdAt.getTime()) / (1000 * 60 * 60 * 24 * 30));
          staleItems.push({ type: '과제', name: p.name, confidence: conf, ageMonths, id: p.id });
        }
      }
      for (const p of pubs) {
        const conf = calculateConfidence(p);
        if (conf < 0.7) {
          const ageMonths = Math.floor((Date.now() - p.createdAt.getTime()) / (1000 * 60 * 60 * 24 * 30));
          staleItems.push({ type: '논문', name: p.title.slice(0, 50), confidence: conf, ageMonths, id: p.id });
        }
      }

      staleItems.sort((a, b) => a.confidence - b.confidence);

      if (staleItems.length === 0) {
        return '🟢 모든 Lab Memory 정보가 최신 상태입니다! 업데이트가 필요한 항목이 없습니다.';
      }

      return `🔍 **업데이트가 필요한 정보 (${staleItems.length}건)**\n\n` +
        staleItems.slice(0, 20).map((item, i) =>
          `${i + 1}. [${item.type}] **${item.name}**\n   신뢰도: ${(item.confidence * 100).toFixed(0)}% | ${item.ageMonths}개월 전 등록`
        ).join('\n') +
        '\n\n💡 정보를 확인하셨다면 "OO 정보 최신 확인" 이라고 말씀해 주세요.';
    }

    case 'search_memory': {
      // 메모/FAQ/계정정보 등 범용 메모리 검색
      const keyword = entities.query || entities.keyword || message.replace(/[?？을를이가에서의로는은해줘줘요알려]/g, ' ').trim();
      const words = keyword.split(/\s+/).filter(w => w.length > 1);

      // OR 검색: 각 단어가 title 또는 content에 포함
      const memos = await prisma.memo.findMany({
        where: {
          userId,
          OR: words.flatMap(w => [
            { title: { contains: w, mode: 'insensitive' as const } },
            { content: { contains: w, mode: 'insensitive' as const } },
            { tags: { has: w } },
          ]),
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });

      if (memos.length > 0) {
        return memos.map((m, i) =>
          `${i + 1}. [${m.source || '메모'}] **${m.title || '(제목없음)'}**\n${m.content.substring(0, 300)}`
        ).join('\n\n');
      }

      // Memo에서 못 찾으면 다른 DB도 검색
      const members = await prisma.labMember.findMany({ where: { labId, active: true } });
      const matchedMembers = members.filter(m => words.some(w => m.name.includes(w)));
      if (matchedMembers.length > 0) {
        return matchedMembers.map(m => `👤 ${m.name} (${m.role}) — ${m.email || ''}`).join('\n');
      }

      return null;
    }

    case 'fallback_search': {
      // Intent 분류 실패 시 DB 범용 검색 우선 시도
      const words = message.replace(/[?？을를이가에서의로는은해줘줘요알려정보]/g, ' ').split(/\s+/).filter(w => w.length > 1);
      const results: string[] = [];

      // Memo 검색 (가장 많은 데이터)
      const memos = await prisma.memo.findMany({
        where: {
          userId,
          OR: words.flatMap(w => [
            { title: { contains: w, mode: 'insensitive' as const } },
            { content: { contains: w, mode: 'insensitive' as const } },
          ]),
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
      });
      if (memos.length > 0) {
        results.push(...memos.map(m => `💡 [${m.source || '메모'}] **${m.title}**\n${m.content.substring(0, 200)}`));
      }

      // 구성원/과제 검색
      const allMembers = await prisma.labMember.findMany({ where: { labId, active: true } });
      const allProjects = await prisma.project.findMany({ where: { labId } });

      for (const word of words) {
        const matchedM = allMembers.filter(m => m.name.includes(word));
        const matchedP = allProjects.filter(p => p.name.includes(word) || p.funder?.includes(word));
        if (matchedM.length) results.push(`👤 구성원: ${matchedM.map(m => `${m.name}(${m.role})`).join(', ')}`);
        if (matchedP.length) results.push(`📋 과제: ${matchedP.map(p => p.name).join(', ')}`);
      }

      if (results.length > 0) {
        return `다음과 관련된 정보를 찾았습니다:\n\n${results.join('\n\n')}`;
      }
      // DB에서도 못 찾으면 null → general_chat으로 이동
      return null;
    }

    default:
      return null;
  }
}

// ══════════════════════════════════════════════════════
//  3-LAYER CONTEXT BUILDER
// ══════════════════════════════════════════════════════

async function build3LayerContext(channelId: string, labId: string | null): Promise<string> {
  let context = '';

  const summaries = await prisma.channelSummary.findMany({
    where: { channelId },
    orderBy: { createdAt: 'desc' },
    take: 3,
  });
  if (summaries.length > 0) {
    context += '## 이전 대화 요약\n';
    context += summaries.map(s => s.summaryText).join('\n---\n');
    context += '\n\n';
  }

  if (labId) {
    const lab = await prisma.lab.findUnique({
      where: { id: labId },
      include: {
        members: { where: { active: true }, take: 20 },
        projects: { where: { status: 'active' }, take: 10 },
        domainDict: { take: 50 },
      },
    });

    if (lab) {
      context += '## Lab Profile (영구 기억)\n';
      context += `연구실: ${lab.name}\n`;
      context += `소속: ${lab.institution || '미등록'} ${lab.department || ''}\n`;
      context += `연구 분야: ${lab.researchFields.join(', ') || '미등록'}\n`;
      if (lab.members.length > 0) {
        context += `구성원 (${lab.members.length}명): ${lab.members.map(m => `${m.name}(${m.role})`).join(', ')}\n`;
      }
      if (lab.projects.length > 0) {
        context += `진행 과제: ${lab.projects.map(p => `${p.name}[PM:${p.pm || '미지정'}]`).join(', ')}\n`;
      }
      if (lab.domainDict.length > 0) {
        context += `전문용어 사전: ${lab.domainDict.slice(0, 20).map(d => `${d.wrongForm}→${d.correctForm}`).join(', ')}\n`;
      }

      // L3+ Memo source별 컨텍스트 (FAQ/규정은 항상 참조 가능)
      const sharedMemos = await prisma.memo.findMany({
        where: { labId, shared: true, source: { in: ['faq', 'regulation'] } },
        take: 30,
        orderBy: { accessCount: 'desc' },
      });
      if (sharedMemos.length > 0) {
        const faqMemos = sharedMemos.filter(m => m.source === 'faq');
        const regMemos = sharedMemos.filter(m => m.source === 'regulation');
        if (faqMemos.length > 0) {
          context += `FAQ (${faqMemos.length}건): ${faqMemos.slice(0, 10).map(m => m.title || m.content.slice(0, 30)).join(', ')}\n`;
        }
        if (regMemos.length > 0) {
          context += `규정/매뉴얼 (${regMemos.length}건): ${regMemos.slice(0, 10).map(m => m.title || m.content.slice(0, 30)).join(', ')}\n`;
        }
      }
      context += '\n';
    }
  }

  return context;
}

// ══════════════════════════════════════════════════════
//  SESSION SUMMARY & AUTO EXTRACT (기존 유지)
// ══════════════════════════════════════════════════════

async function maybeGenerateSummary(channelId: string): Promise<void> {
  const messageCount = await prisma.message.count({ where: { channelId } });
  if (messageCount < 30) return;

  const lastSummary = await prisma.channelSummary.findFirst({
    where: { channelId },
    orderBy: { createdAt: 'desc' },
  });

  const newMessages = await prisma.message.findMany({
    where: {
      channelId,
      createdAt: lastSummary ? { gt: lastSummary.createdAt } : undefined,
    },
    orderBy: { createdAt: 'asc' },
  });

  if (newMessages.length < 20) return;

  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const conversationText = newMessages.map(m => `${m.role}: ${m.content}`).join('\n');
    const result = await model.generateContent(
      `다음 대화를 간결하게 요약하세요. 핵심 정보를 중심으로 200단어 이내로:\n\n${conversationText}`
    );

    await prisma.channelSummary.create({
      data: {
        channelId,
        summaryText: result.response.text(),
        messageRange: `${newMessages[0].id} ~ ${newMessages[newMessages.length - 1].id}`,
      },
    });
  } catch (err) {
    console.warn('Session summary generation failed:', err);
  }
}

async function autoExtractInfo(message: string, response: string, labId: string): Promise<void> {
  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const prompt = `다음 대화에서 연구실 관련 새 정보가 있는지 확인하세요.
추출: 과제-논문 연결, 새 용어, 새 인원, 새 과제 정보
새 정보 없으면 빈 배열: []

사용자: ${message}
AI: ${response}

JSON 배열: [{"type": "dict"|"memo", "data": {...}}]`;

    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    const match = text.match(/\[.*\]/s);
    if (match) {
      const items = JSON.parse(match[0]);
      for (const item of items) {
        if (item.type === 'dict' && item.data?.wrongForm && item.data?.correctForm) {
          await prisma.domainDict.upsert({
            where: { labId_wrongForm: { labId, wrongForm: item.data.wrongForm } },
            create: { labId, wrongForm: item.data.wrongForm, correctForm: item.data.correctForm, autoAdded: true },
            update: { correctForm: item.data.correctForm },
          }).catch(() => {});
        }
      }
    }
  } catch {
    // 자동 추출 실패 무시
  }
}

// ══════════════════════════════════════════════════════
//  SESSION MANAGEMENT
// ══════════════════════════════════════════════════════

/**
 * 대화 내용 기반으로 세션 제목 자동 생성 (10자 내외)
 */
async function generateSessionTitle(messages: Array<{ role: string; content: string }>, latestMessage: string): Promise<string> {
  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const context = messages.slice(-4).map(m => `${m.role}: ${m.content.slice(0, 100)}`).join('\n');
    const result = await model.generateContent(
      `다음 대화의 주제를 한국어 10자 이내로 요약하세요. 제목만 출력:\n\n${context}\nuser: ${latestMessage.slice(0, 100)}`
    );
    const title = result.response.text().trim().replace(/["']/g, '').slice(0, 30);
    return title || '새 대화';
  } catch {
    return latestMessage.slice(0, 20) || '새 대화';
  }
}

// ══════════════════════════════════════════════════════
//  TOOL-SPECIFIC HANDLERS
// ══════════════════════════════════════════════════════

type ToolName = 'email' | 'papers' | 'meeting' | 'calendar';

async function handleToolMessage(
  tool: ToolName,
  message: string,
  userId: string,
  lab: any,
  labId?: string,
): Promise<{ response: string; intent: string; metadata?: any }> {
  const labIdStr = lab?.id || labId;

  switch (tool) {
    case 'email': {
      // 이메일 브리핑 관련 대화
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

      // 최근 이메일 브리핑 데이터 로드
      const recentBriefing = await prisma.memo.findFirst({
        where: { userId, source: 'email-briefing' },
        orderBy: { createdAt: 'desc' },
      });
      const context = recentBriefing?.content?.slice(0, 3000) || '최근 이메일 브리핑 데이터 없음';

      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: message }] }],
        systemInstruction: { role: 'user', parts: [{ text: `당신은 이메일 브리핑 비서입니다. 최근 이메일 브리핑 데이터를 참고하여 답변하세요.\n\n최근 브리핑:\n${context}` }] },
      });
      return { response: result.response.text(), intent: 'email_tool' };
    }

    case 'papers': {
      // 1. 연구실 핵심 논문 (Publication + 벡터 검색)
      const publications = labIdStr ? await prisma.publication.findMany({
        where: { labId: labIdStr },
        orderBy: { year: 'desc' },
      }) : [];
      const pubList = publications.length > 0
        ? publications.map(p => `- "${p.title}" (${p.journal || '?'}, ${p.year || '?'})${p.nickname ? ` [${p.nickname}]` : ''}${p.indexed ? ' ✅' : ''}`).join('\n')
        : '';

      // 2. 벡터 검색 (인덱싱된 논문에서 관련 내용 검색)
      let ragContext = '';
      try {
        const { generateEmbedding: genEmbed, searchPapers: searchP } = await import('../services/embedding-service.js');
        const { embedding } = await genEmbed(message);
        const ragResults = await searchP(prisma, embedding, 5, 0.5);
        if (ragResults.length > 0) {
          ragContext = '\n\n[관련 논문 내용 (벡터 검색)]\n' + ragResults.map(r =>
            `"${r.title}" — ${r.chunkText.slice(0, 300)}`
          ).join('\n\n');
        }
      } catch { /* 임베딩 서비스 미설정 시 무시 */ }

      // 3. 최신 논문 알림 결과
      const alerts = labIdStr ? await prisma.paperAlertResult.findMany({
        where: { alert: { labId: labIdStr } },
        orderBy: [{ stars: 'desc' }, { createdAt: 'desc' }],
        take: 5,
      }) : [];
      const alertList = alerts.length > 0
        ? alerts.map(r => `[${r.stars === 3 ? '★★★' : r.stars === 2 ? '★★' : '★'}] ${r.title} (${r.journal})\n  ${r.aiSummary || ''}`).join('\n\n')
        : '';

      const context = [
        pubList ? `[연구실 핵심 논문 ${publications.length}편]\n${pubList}` : '',
        ragContext,
        alertList ? `\n[최신 논문 알림]\n${alertList}` : '',
      ].filter(Boolean).join('\n');

      if (!context) return { response: '등록된 논문이 없습니다. PDF를 업로드하거나 논문 알림을 설정해주세요.', intent: 'papers_tool' };

      // Opus 4.6 for paper discussion (deep understanding required)
      const systemPrompt = `당신은 연구 논문 전문 비서입니다. 연구실의 핵심 논문과 최신 동향을 참고하여 답변하세요.

핵심 규칙:
1. 핵심 논문의 별칭(예: "LM 논문", "핵심 논문 1번")이 있으면 해당 논문을 참조하세요.
2. 벡터 검색 결과가 있으면 실제 논문 내용을 기반으로 구체적으로 답변하세요.
3. 논문 비교 시: novelty, 방법론, 결과, 한계점을 체계적으로 분석하세요.
4. 추측하지 마세요. 제공된 데이터에 없는 내용은 "해당 정보가 없습니다"라고 답하세요.

${context}`;

      if (env.ANTHROPIC_API_KEY) {
        try {
          const Anthropic = (await import('@anthropic-ai/sdk')).default;
          const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
          const response = await anthropic.messages.create({
            model: 'claude-opus-4-20250514',
            max_tokens: 4096,
            temperature: 0.3,
            system: systemPrompt,
            messages: [{ role: 'user', content: message }],
          });
          const text = response.content.find(b => b.type === 'text');
          if (text && text.type === 'text') {
            return { response: text.text, intent: 'papers_tool', metadata: { publicationCount: publications.length, alertCount: alerts.length, model: 'opus' } };
          }
        } catch (err) {
          console.warn('Opus papers tool failed, fallback to Gemini:', err);
        }
      }

      // Gemini fallback
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: message }] }],
        systemInstruction: { role: 'user', parts: [{ text: systemPrompt }] },
      });
      return { response: result.response.text(), intent: 'papers_tool', metadata: { publicationCount: publications.length, alertCount: alerts.length, model: 'gemini-fallback' } };
    }

    case 'meeting': {
      // 미팅 관련
      const meetings = await prisma.meeting.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 5,
      });
      if (meetings.length === 0) return { response: '기록된 미팅이 없습니다.', intent: 'meeting_tool' };

      const meetingList = meetings.map(m =>
        `[${m.createdAt.toISOString().split('T')[0]}] ${m.title}\n  ${m.summary?.slice(0, 200) || ''}`
      ).join('\n\n');

      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: message }] }],
        systemInstruction: { role: 'user', parts: [{ text: `당신은 미팅 기록 비서입니다. 최근 미팅 기록을 참고하여 답변하세요.\n\n최근 미팅:\n${meetingList}` }] },
      });
      return { response: result.response.text(), intent: 'meeting_tool' };
    }

    case 'calendar': {
      // 캘린더 관련
      const { getTodayEvents, getWeekEvents } = await import('../services/calendar.js');
      const [todayEvents, weekEvents] = await Promise.all([
        getTodayEvents(userId),
        getWeekEvents(userId),
      ]);

      // 대기 중인 일정도 포함
      const pending = await prisma.memo.findMany({
        where: { userId, source: 'pending-event', tags: { has: 'pending' } },
        take: 5,
      });
      const pendingInfo = pending.map(m => {
        try { const e = JSON.parse(m.content); return `[대기] ${e.title} (${e.date})`; } catch { return ''; }
      }).filter(Boolean).join('\n');

      const calContext = [
        todayEvents.length > 0 ? `오늘 일정 (${todayEvents.length}건):\n${todayEvents.map(e => `- ${e.start.includes('T') ? new Date(e.start).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '종일'} ${e.title}${e.location ? ` @ ${e.location}` : ''}`).join('\n')}` : '오늘 일정 없음',
        weekEvents.length > todayEvents.length ? `\n이번주 일정 (${weekEvents.length}건):\n${weekEvents.slice(0, 10).map(e => `- ${e.start.split('T')[0]} ${e.title}`).join('\n')}` : '',
        pendingInfo ? `\n등록 대기 중 일정:\n${pendingInfo}` : '',
      ].join('\n');

      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: message }] }],
        systemInstruction: { role: 'user', parts: [{ text: `당신은 캘린더/일정 관리 비서입니다. 현재 일정 정보를 참고하여 답변하세요.\n\n${calContext}` }] },
      });
      return { response: result.response.text(), intent: 'calendar_tool', metadata: { todayCount: todayEvents.length, weekCount: weekEvents.length, pendingCount: pending.length } };
    }

    default:
      return { response: '알 수 없는 도구입니다.', intent: 'unknown_tool' };
  }
}

// ══════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════

/**
 * 30일 이상 된 자유 대화 세션을 자동 아카이브 (삭제 아님)
 */
export async function archiveOldSessions() {
  try {
    const threshold = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const result = await prisma.channel.updateMany({
      where: {
        tool: 'general',
        archived: false,
        lastMessageAt: { lt: threshold },
      },
      data: { archived: true },
    });
    if (result.count > 0) {
      console.log(`📦 Archived ${result.count} old free chat sessions`);
    }
  } catch { /* ignore */ }
}

export async function brainRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authMiddleware);
  app.addHook('onRequest', aiRateLimiter);

  // ── 파일 업로드 + AI 처리 ───────────────────────────
  app.post('/api/brain/upload', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId!;
    const data = await request.file();
    if (!data) return reply.code(400).send({ error: '파일이 필요합니다' });

    const chunks: Buffer[] = [];
    for await (const chunk of data.file as any) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    const buffer = Buffer.concat(chunks);

    if (buffer.length === 0) return reply.code(400).send({ error: '빈 파일입니다' });
    if (buffer.length > 20 * 1024 * 1024) return reply.code(413).send({ error: '파일이 너무 큽니다 (최대 20MB)' });

    const { processUploadedFile } = await import('../services/file-processor.js');
    const result = await processUploadedFile(buffer, data.filename || 'upload', data.mimetype || 'application/octet-stream');

    // 처리 결과를 Memo에 임시 저장 (chat에서 참조)
    const lab = await prisma.lab.findUnique({ where: { ownerId: userId } });
    const memo = await prisma.memo.create({
      data: {
        userId,
        labId: lab?.id || undefined,
        title: `📎 ${result.filename}`,
        content: result.text.slice(0, 10000),
        tags: ['file-upload', result.type],
        source: 'file-upload',
      },
    });

    // 파일 타입에 따른 안내 메시지 생성
    const actionMessages: Record<string, string> = {
      paper_discuss: `📄 논문이 업로드되었습니다: "${result.filename}"\n\n이 논문에 대해 질문하거나, 핵심 논문과 비교 분석을 요청할 수 있습니다.\n📚 논문 도구를 선택하면 연구 맥락에서 더 깊은 토론이 가능합니다.`,
      document_summarize: `📄 문서가 업로드되었습니다: "${result.filename}"\n\n요약, 핵심 내용 추출, 또는 특정 부분에 대해 질문해주세요.`,
      import_projects: `📋 과제 데이터가 감지되었습니다 (${result.metadata?.rowCount || 0}건)\n\n"과제 정보로 저장해줘"라고 하면 자동으로 분류 저장합니다.`,
      import_members: `👥 구성원 데이터가 감지되었습니다 (${result.metadata?.rowCount || 0}명)\n\n"구성원으로 저장해줘"라고 하면 자동으로 등록합니다.`,
      import_publications: `📄 논문 목록이 감지되었습니다 (${result.metadata?.rowCount || 0}편)\n\n"논문 목록으로 저장해줘"라고 하면 자동으로 등록합니다.`,
      import_calendar: `📅 일정 데이터가 감지되었습니다\n\n"캘린더에 등록해줘"라고 하면 확인 후 등록합니다.`,
      receipt_process: `🧾 영수증이 감지되었습니다\n\n회의록 양식에 필요한 정보를 자동 추출했습니다. "회의록 만들어줘"라고 하면 진행합니다.`,
      image_memo: `🖼️ 이미지가 업로드되었습니다\n\n내용을 분석했습니다. 질문하거나 "메모로 저장해줘"라고 하세요.`,
      document_review: `📝 문서가 업로드되었습니다: "${result.filename}"\n\n교정, 요약, 또는 특정 부분에 대해 질문해주세요.`,
      data_review: `📊 데이터 파일이 업로드되었습니다 (${result.metadata?.rowCount || 0}행)\n\n어떻게 처리할지 알려주세요.`,
    };

    return reply.send({
      success: true,
      fileId: memo.id,
      type: result.type,
      filename: result.filename,
      suggestedAction: result.suggestedAction,
      message: actionMessages[result.suggestedAction] || `파일이 업로드되었습니다: ${result.filename}`,
      preview: result.text.slice(0, 500),
      structured: result.structured,
      metadata: result.metadata,
    });
  });

  // ── Chat (도구별 영구 세션 + 3층 기억 + 멀티홉) ──────
  app.post('/api/brain/chat', async (request: FastifyRequest, reply: FastifyReply) => {
    const { channelId: inputChannelId, message, fileId, tool } = chatSchema.parse(request.body);
    const userId = request.userId!;

    // ── 파일 컨텍스트 주입 (fileId가 있으면) ──────────
    let fileContext = '';
    if (fileId) {
      const fileMemo = await prisma.memo.findFirst({
        where: { id: fileId, userId, source: 'file-upload' },
      });
      if (fileMemo) {
        fileContext = `\n\n[업로드된 파일: ${fileMemo.title}]\n${fileMemo.content.slice(0, 5000)}`;
      }
    }

    // ── 도구별 영구 세션 관리 ────────────────────────
    // 각 도구는 유저당 1개의 영구 세션을 가짐
    // 'general'은 여러 세션 가능 (자유 대화)
    let channelId = inputChannelId;
    let isNewSession = false;

    if (tool !== 'general') {
      // 4개 도구별 영구 세션: 기존 세션 찾기 or 생성
      const TOOL_NAMES: Record<string, string> = {
        email: '📧 이메일', papers: '📚 논문', meeting: '🎙️ 미팅', calendar: '📅 캘린더',
      };
      let toolChannel = await prisma.channel.findFirst({
        where: { userId, tool, archived: false },
        orderBy: { lastMessageAt: 'desc' },
      });
      if (!toolChannel) {
        toolChannel = await prisma.channel.create({
          data: { userId, type: 'BRAIN', tool, name: TOOL_NAMES[tool] || tool },
        });
        isNewSession = true;
      }
      channelId = toolChannel.id;
    } else if (!channelId) {
      // general: 새 자유 대화 세션 생성 (첫 메시지로 이름 설정)
      const sessionName = message.length > 30 ? message.slice(0, 27) + '...' : message;
      const newChannel = await prisma.channel.create({
        data: { userId, type: 'BRAIN', tool: 'general', name: sessionName },
      });
      channelId = newChannel.id;
      isNewSession = true;
    }

    const lab = await prisma.lab.findUnique({ where: { ownerId: userId } });

    // ── 컨텍스트 윈도우: 최근 20개 메시지만 로드 ──────
    const recentCtx = await prisma.message.findMany({
      where: { channelId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const contextMessages = recentCtx.reverse();

    // ── 도구가 명시적으로 선택된 경우: 전용 핸들러로 라우팅 ──
    if (tool !== 'general') {
      const toolResult = await handleToolMessage(tool, message + fileContext, userId, lab, request.labId);
      // 메시지 저장 + 채널 메타 업데이트
      await prisma.message.createMany({
        data: [
          { channelId, role: 'user', content: message },
          { channelId, role: 'assistant', content: toolResult.response },
        ],
      });
      const msgCount = await prisma.message.count({ where: { channelId } });
      await prisma.channel.update({
        where: { id: channelId },
        data: {
          messageCount: msgCount,
          lastMessageAt: new Date(),
          tool: tool,
          // 2~3번째 대화에서 자동 제목 생성
          ...(msgCount >= 3 && msgCount <= 5 ? { name: await generateSessionTitle(contextMessages, message) } : {}),
        },
      });
      return reply.send({
        response: toolResult.response,
        channelId,
        intent: toolResult.intent,
        tool,
        isNewSession,
        metadata: toolResult.metadata,
      });
    }

    // ── 기본 모드: 의도 분류 + RAG 병렬 검색 ──
    const classified = await classifyIntent(message);
    const { intent, entities, hops } = classified;

    // 2. RAG: 데이터 중심 병렬 검색 (intent와 무관하게 항상 실행)
    //    Intent는 액션 커맨드(save_memo, capture_*)에만 사용
    //    데이터 조회는 모든 테이블을 병렬 검색 후 결과 합산
    let dbResult: string | null = null;

    // 2a. 검색 키워드 추출
    const searchWords = message
      .replace(/[?？！!을를이가에서의로는은해줘줘요알려정보보여뭐있어]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1);

    if (lab && intent !== 'save_memo' && intent !== 'capture_create' && intent !== 'capture_complete'
        && intent !== 'daily_brief' && intent !== 'emerge' && intent !== 'weekly_review'
        && intent !== 'add_dict') {

      // multi_hop은 기존 로직 유지 (복합 조회)
      if (intent === 'multi_hop' && hops && hops.length > 0) {
        dbResult = await executeMultiHopQuery(message, entities, hops, lab.id);
      }

      // RAG 병렬 검색: Memo(98% 데이터) + 구조화 테이블을 동시에 검색
      const [memoResults, memberResults, projectResults, pubResults] = await Promise.all([
        // Memo: 키워드 OR 검색 (제목, 내용, 태그)
        searchWords.length > 0 ? prisma.memo.findMany({
          where: {
            OR: [{ userId }, { labId: lab.id }],
            AND: {
              OR: searchWords.flatMap(w => [
                { title: { contains: w, mode: 'insensitive' as const } },
                { content: { contains: w, mode: 'insensitive' as const } },
                { tags: { has: w } },
              ]),
            },
          },
          orderBy: [{ accessCount: 'desc' }, { createdAt: 'desc' }],
          take: 8,
        }) : Promise.resolve([]),

        // LabMember: 이름/역할 매칭
        prisma.labMember.findMany({
          where: {
            labId: lab.id,
            active: true,
            OR: searchWords.map(w => ({
              OR: [
                { name: { contains: w, mode: 'insensitive' as const } },
                { role: { contains: w, mode: 'insensitive' as const } },
                { team: { contains: w, mode: 'insensitive' as const } },
              ],
            })),
          },
          take: 5,
        }),

        // Project: 이름/키워드 매칭
        prisma.project.findMany({
          where: {
            labId: lab.id,
            OR: searchWords.map(w => ({
              OR: [
                { name: { contains: w, mode: 'insensitive' as const } },
                { funder: { contains: w, mode: 'insensitive' as const } },
                { status: { contains: w, mode: 'insensitive' as const } },
              ],
            })),
          },
          take: 5,
        }),

        // Publication: 제목/저널 매칭
        prisma.publication.findMany({
          where: {
            labId: lab.id,
            OR: searchWords.map(w => ({
              OR: [
                { title: { contains: w, mode: 'insensitive' as const } },
                { journal: { contains: w, mode: 'insensitive' as const } },
              ],
            })),
          },
          take: 5,
        }),
      ]);

      // 결과 합산 (Memo 우선)
      const resultParts: string[] = [];

      if (memoResults.length > 0) {
        resultParts.push(
          `[메모/FAQ/계정 검색 결과 — ${memoResults.length}건]\n` +
          memoResults.map((m, i) =>
            `${i + 1}. [${m.source || '메모'}] ${m.title || '(제목없음)'}\n${m.content.substring(0, 400)}`
          ).join('\n\n')
        );
      }

      if (memberResults.length > 0) {
        resultParts.push(
          `[구성원 검색 결과 — ${memberResults.length}명]\n` +
          memberResults.map(m =>
            `👤 ${m.name} (${m.role || ''}) ${m.email || ''} ${m.team || ''}`
          ).join('\n')
        );
      }

      if (projectResults.length > 0) {
        resultParts.push(
          `[과제 검색 결과 — ${projectResults.length}건]\n` +
          projectResults.map(p =>
            `📋 ${p.name} — ${p.funder || ''} | ${p.status || ''} | 기간: ${p.period || ''}`
          ).join('\n')
        );
      }

      if (pubResults.length > 0) {
        resultParts.push(
          `[논문 검색 결과 — ${pubResults.length}편]\n` +
          pubResults.map(p =>
            `📄 ${p.title.substring(0, 80)} — ${p.journal || ''} (${p.year || ''})`
          ).join('\n')
        );
      }

      // 병렬 검색 결과가 있으면 기존 intent 결과와 합산
      if (resultParts.length > 0) {
        const ragResult = resultParts.join('\n\n');
        dbResult = dbResult ? `${dbResult}\n\n${ragResult}` : ragResult;
      }

      // 병렬 검색에서도 못 찾았으면 기존 intent 핸들러 시도 (fallback)
      if (!dbResult) {
        dbResult = await handleDbQuery(intent, entities, lab.id, userId, message);
      }
    }

    // 3. 메모 저장 요청 (자동 태깅 포함)
    if (intent === 'save_memo' && lab) {
      const { autoTagByRules } = await import('../services/auto-tagger.js');
      const autoTags = entities.tags ? [entities.tags] : autoTagByRules(message);
      const title = message.length > 60 ? message.slice(0, 57) + '...' : message;
      await prisma.memo.create({
        data: {
          labId: lab.id,
          userId,
          title,
          content: message,
          source: 'chat',
          tags: autoTags,
        },
      });
      dbResult = `메모가 저장되었습니다. (태그: ${autoTags.join(', ')})`;
    }

    // 4. 용어 교정 등록
    if (intent === 'add_dict' && lab && entities.wrongForm && entities.correctForm) {
      await prisma.domainDict.upsert({
        where: { labId_wrongForm: { labId: lab.id, wrongForm: entities.wrongForm } },
        create: { labId: lab.id, wrongForm: entities.wrongForm, correctForm: entities.correctForm },
        update: { correctForm: entities.correctForm },
      });
      dbResult = `용어 교정 등록 완료: "${entities.wrongForm}" → "${entities.correctForm}"`;
    }

    // 4-1. 캡처 인텐트 처리
    if (intent === 'capture_create' && lab && entities.content) {
      const { classifyCapture, typeToCategory, urgencyToPriority } = await import('../services/capture-classifier.js');
      const classification = await classifyCapture(entities.content);
      const capture = await prisma.capture.create({
        data: {
          userId,
          labId: lab.id,
          content: entities.content,
          summary: classification.summary,
          category: typeToCategory(classification.type),
          tags: classification.tags,
          priority: urgencyToPriority(classification.urgency),
          confidence: classification.confidence,
          actionDate: classification.dueDate ? new Date(classification.dueDate) : null,
          modelUsed: 'gemini-flash',
          sourceType: 'text',
          status: 'active',
        },
      });
      const emoji = classification.type === 'task' ? '✅' : classification.type === 'idea' ? '💡' : '📝';
      dbResult = `${emoji} 캡처 저장 완료: [${classification.type}] ${classification.summary}` +
        (classification.tags.length > 0 ? `\n태그: ${classification.tags.join(', ')}` : '') +
        (classification.dueDate ? `\n마감: ${classification.dueDate.split('T')[0]}` : '');
    }

    if (intent === 'capture_list' && lab) {
      const typeFilter = entities.type ? { category: entities.type.toUpperCase() as any } : {};
      const captures = await prisma.capture.findMany({
        where: { labId: lab.id, status: 'active', ...typeFilter },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });
      if (captures.length === 0) {
        dbResult = '현재 활성 캡처가 없습니다.';
      } else {
        const lines = captures.map((c: any, i: number) => {
          const emoji = c.category === 'TASK' ? '✅' : c.category === 'IDEA' ? '💡' : '📝';
          return `${i + 1}. ${emoji} ${c.summary || c.content.substring(0, 40)}`;
        });
        dbResult = `캡처 목록 (${captures.length}건):\n${lines.join('\n')}`;
      }
    }

    if (intent === 'capture_complete' && lab && entities.content) {
      const capture = await prisma.capture.findFirst({
        where: {
          labId: lab.id,
          status: 'active',
          OR: [
            { content: { contains: entities.content, mode: 'insensitive' } },
            { summary: { contains: entities.content, mode: 'insensitive' } },
          ],
        },
      });
      if (capture) {
        await prisma.capture.update({
          where: { id: capture.id },
          data: { status: 'completed', completed: true, completedAt: new Date() },
        });
        dbResult = `✅ 캡처 완료 처리: ${capture.summary || capture.content.substring(0, 40)}`;
      } else {
        dbResult = '일치하는 캡처를 찾을 수 없습니다.';
      }
    }

    // 4-2. Thinking Commands (daily_brief, emerge, weekly_review)
    if (intent === 'daily_brief') {
      const { dailyBrief } = await import('../services/knowledge-graph.js');
      dbResult = await dailyBrief(userId);
    } else if (intent === 'emerge') {
      const { emergeInsights } = await import('../services/knowledge-graph.js');
      dbResult = await emergeInsights(userId);
    } else if (intent === 'weekly_review') {
      const { weeklyReview } = await import('../services/knowledge-graph.js');
      dbResult = await weeklyReview(userId);
    }

    // 5. 3층 컨텍스트 빌드
    const layerContext = await build3LayerContext(channelId, lab?.id || null);

    const recentMessages = await prisma.message.findMany({
      where: { channelId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    // 6. 사용자 메시지 저장
    await prisma.message.create({
      data: { channelId, role: 'user', content: message },
    });

    // 7. AI 응답 생성
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const systemPrompt = `당신은 연구실 AI 비서 "ResearchFlow 미니브레인"입니다.
${lab?.responseStyle === 'casual' ? '친근하고 캐주얼한 어조로 답변하세요.' : '정중하고 전문적인 어조로 답변하세요.'}

핵심 규칙:
1. DB에 등록된 정보만 답변합니다. 추측하거나 지어내지 마세요.
2. [DB 조회 결과]가 제공되면, 그 결과를 자연스럽게 정리하여 전달하세요.
3. 정보가 없으면 "등록된 정보가 없습니다. 추가하시겠어요?"로 유도하세요.
4. 복합 질의의 경우, 연결 관계를 명확히 설명하세요.
5. 대화 중 새로운 연구실 정보가 언급되면 기억합니다.
6. ⚠️ 경고가 있으면 신뢰도 상태를 사용자에게 전달하세요.`;

    const chatHistory = recentMessages.reverse().map(m => ({
      role: m.role === 'user' ? 'user' as const : 'model' as const,
      parts: [{ text: m.content }],
    }));

    // layerContext는 system prompt에서 분리 → 사용자 메시지에 prepend (토큰 절약)
    let userContent = message + fileContext;
    if (layerContext) {
      userContent = `[연구실 컨텍스트]\n${layerContext}\n\n${userContent}`;
    }
    if (dbResult) {
      userContent = `${userContent}\n\n[DB 조회 결과 — 이 데이터만으로 답변하세요]\n${dbResult}`;
    }

    const chat = model.startChat({
      history: chatHistory,
      systemInstruction: { role: 'user', parts: [{ text: systemPrompt }] },
    });

    const result = await chat.sendMessage(userContent);
    const responseText = result.response.text();

    // 8. AI 응답 저장
    await prisma.message.create({
      data: { channelId, role: 'assistant', content: responseText },
    });

    // 9. 세션 메타 업데이트 + 자동 제목
    const msgCount = await prisma.message.count({ where: { channelId } });
    const channelUpdate: any = { messageCount: msgCount, lastMessageAt: new Date() };
    if (msgCount >= 3 && msgCount <= 5) {
      channelUpdate.name = await generateSessionTitle(contextMessages, message);
    }
    await prisma.channel.update({ where: { id: channelId }, data: channelUpdate });

    // 10. 비동기 후처리
    maybeGenerateSummary(channelId).catch(() => {});
    if (lab) {
      autoExtractInfo(message, responseText, lab.id).catch(() => {});
    }

    return {
      response: responseText,
      channelId,
      intent,
      isNewSession,
      multiHop: intent === 'multi_hop',
      dbResult: dbResult ? true : false,
    };
  });

  // ── Channel CRUD ──────────────────────────────────
  app.get('/api/brain/channels', async (request: FastifyRequest) => {
    const channels = await prisma.channel.findMany({
      where: { userId: request.userId!, archived: false },
      orderBy: [{ pinned: 'desc' }, { lastMessageAt: 'desc' }, { createdAt: 'desc' }],
    });

    // 도구별 영구 세션 + 자유 대화 세션으로 분류
    const toolSessions = channels.filter(c => c.tool && c.tool !== 'general');
    const freeSessions = channels.filter(c => !c.tool || c.tool === 'general');

    return {
      data: channels,
      toolSessions,
      freeSessions,
    };
  });

  app.post('/api/brain/channels', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = createChannelSchema.parse(request.body);
    const channel = await prisma.channel.create({
      data: { userId: request.userId!, type: body.type, name: body.name },
    });
    return reply.code(201).send(channel);
  });

  app.get('/api/brain/channels/:id', async (request: FastifyRequest<{ Params: { id: string } }>) => {
    // 채널이 현재 사용자 소유인지 검증
    const channel = await prisma.channel.findFirst({
      where: { id: request.params.id, userId: request.userId! },
    });
    if (!channel) return [];

    return prisma.message.findMany({
      where: { channelId: request.params.id },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
  });

  app.delete('/api/brain/channels/:id', async (request: FastifyRequest<{ Params: { id: string } }>) => {
    await prisma.channel.deleteMany({
      where: { id: request.params.id, userId: request.userId! },
    });
    return { success: true };
  });

  // ── Memo (수동 저장) ──────────────────────────────
  app.post('/api/brain/memo', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = memoSchema.parse(request.body);
    const lab = await prisma.lab.findUnique({ where: { ownerId: request.userId! } });
    if (!lab) {
      return reply.code(404).send({ error: '연구실을 먼저 설정해주세요.' });
    }

    let tags = body.tags || [];
    if (tags.length === 0) {
      try {
        const { GoogleGenerativeAI } = await import('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
        const m = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const r = await m.generateContent(
          `다음 메모에 적절한 태그를 3~5개 생성하세요. JSON 배열로만 응답: "${body.content}"`
        );
        const text = r.response.text().trim();
        const match = text.match(/\[.*\]/s);
        if (match) tags = JSON.parse(match[0]);
      } catch {}
    }

    const memo = await prisma.memo.create({
      data: {
        labId: lab.id,
        userId: request.userId!,
        content: body.content,
        title: body.title,
        tags,
        source: body.source,
      },
    });
    return reply.code(201).send(memo);
  });

  // ── Search ────────────────────────────────────────
  app.get('/api/brain/search', async (request: FastifyRequest, reply: FastifyReply) => {
    const { query, type } = searchSchema.parse(request.query as any);
    const lab = await prisma.lab.findUnique({ where: { ownerId: request.userId! } });
    if (!lab) {
      return reply.code(404).send({ error: '연구실을 먼저 설정해주세요.' });
    }

    const results: any = {};

    if (type === 'all' || type === 'memo') {
      // Lab의 shared 메모 + 본인 메모 모두 검색
      results.memos = await prisma.memo.findMany({
        where: {
          OR: [
            { labId: lab.id, shared: true },
            { userId: request.userId! },
          ],
          AND: {
            OR: [
              { content: { contains: query, mode: 'insensitive' } },
              { title: { contains: query, mode: 'insensitive' } },
              { tags: { has: query } },
            ],
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
    }

    if (type === 'all' || type === 'project') {
      results.projects = await prisma.project.findMany({
        where: {
          labId: lab.id,
          OR: [
            { name: { contains: query, mode: 'insensitive' } },
            { funder: { contains: query, mode: 'insensitive' } },
            { number: { contains: query, mode: 'insensitive' } },
            { pm: { contains: query, mode: 'insensitive' } },
          ],
        },
      });
    }

    if (type === 'all' || type === 'publication') {
      results.publications = await prisma.publication.findMany({
        where: {
          labId: lab.id,
          OR: [
            { title: { contains: query, mode: 'insensitive' } },
            { journal: { contains: query, mode: 'insensitive' } },
            { authors: { contains: query, mode: 'insensitive' } },
          ],
        },
      });
    }

    if (type === 'all' || type === 'member') {
      results.members = await prisma.labMember.findMany({
        where: {
          labId: lab.id,
          active: true,
          OR: [
            { name: { contains: query, mode: 'insensitive' } },
            { email: { contains: query, mode: 'insensitive' } },
          ],
        },
      });
    }

    if (env.OPENAI_API_KEY) {
      try {
        const { embedding } = await generateEmbedding(query);
        results.paperChunks = await searchPapers(prisma, embedding, 5, 0.3);
      } catch {}
    }

    // 메타기억: 검색 결과에 신뢰도 정보 추가
    if (results.memos) {
      results.memos = results.memos.map((m: any) => ({
        ...m,
        computedConfidence: calculateConfidence(m),
      }));
      trackAccess('memo', results.memos.map((m: any) => m.id)).catch(() => {});
    }
    if (results.projects) {
      results.projects = results.projects.map((p: any) => ({
        ...p,
        computedConfidence: calculateConfidence(p),
      }));
      trackAccess('project', results.projects.map((p: any) => p.id)).catch(() => {});
    }
    if (results.publications) {
      results.publications = results.publications.map((p: any) => ({
        ...p,
        computedConfidence: calculateConfidence(p),
      }));
      trackAccess('publication', results.publications.map((p: any) => p.id)).catch(() => {});
    }

    return results;
  });

  // ══════════════════════════════════════════════════════
  //  METAMEMORY API ENDPOINTS
  // ══════════════════════════════════════════════════════

  // ── GET /api/brain/stale/:labId — 오래된 정보 목록 ──
  app.get('/api/brain/stale/:labId', async (request: FastifyRequest<{ Params: { labId: string }; Querystring: { threshold?: string } }>, reply: FastifyReply) => {
    const { labId } = request.params;
    const threshold = parseFloat((request.query as any).threshold || '0.5');

    const [memos, members, projects, pubs] = await Promise.all([
      prisma.memo.findMany({ where: { labId } }),
      prisma.labMember.findMany({ where: { labId, active: true } }),
      prisma.project.findMany({ where: { labId } }),
      prisma.publication.findMany({ where: { labId } }),
    ]);

    type StaleRecord = {
      id: string;
      type: 'memo' | 'member' | 'project' | 'publication';
      name: string;
      confidence: number;
      createdAt: string;
      lastVerified: string | null;
      lastAccessed: string | null;
      accessCount: number;
    };

    const staleRecords: StaleRecord[] = [];

    for (const m of memos) {
      const conf = calculateConfidence(m);
      if (conf < threshold) {
        staleRecords.push({
          id: m.id, type: 'memo',
          name: m.title || m.content.slice(0, 60),
          confidence: conf,
          createdAt: m.createdAt.toISOString(),
          lastVerified: m.lastVerified?.toISOString() || null,
          lastAccessed: m.lastAccessed?.toISOString() || null,
          accessCount: m.accessCount,
        });
      }
    }
    for (const m of members) {
      const conf = calculateConfidence(m);
      if (conf < threshold) {
        staleRecords.push({
          id: m.id, type: 'member',
          name: `${m.name} (${m.role})`,
          confidence: conf,
          createdAt: m.createdAt.toISOString(),
          lastVerified: m.lastVerified?.toISOString() || null,
          lastAccessed: m.lastAccessed?.toISOString() || null,
          accessCount: m.accessCount,
        });
      }
    }
    for (const p of projects) {
      const conf = calculateConfidence(p);
      if (conf < threshold) {
        staleRecords.push({
          id: p.id, type: 'project',
          name: p.name,
          confidence: conf,
          createdAt: p.createdAt.toISOString(),
          lastVerified: p.lastVerified?.toISOString() || null,
          lastAccessed: p.lastAccessed?.toISOString() || null,
          accessCount: p.accessCount,
        });
      }
    }
    for (const p of pubs) {
      const conf = calculateConfidence(p);
      if (conf < threshold) {
        staleRecords.push({
          id: p.id, type: 'publication',
          name: p.title.slice(0, 60),
          confidence: conf,
          createdAt: p.createdAt.toISOString(),
          lastVerified: p.lastVerified?.toISOString() || null,
          lastAccessed: p.lastAccessed?.toISOString() || null,
          accessCount: p.accessCount,
        });
      }
    }

    staleRecords.sort((a, b) => a.confidence - b.confidence);

    return {
      total: staleRecords.length,
      threshold,
      records: staleRecords,
    };
  });

  // ── GET /api/brain/auto-brief — 자동 브리핑 (하루 1회 캐시) ──
  app.get('/api/brain/auto-brief', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId!;
    const today = new Date().toISOString().split('T')[0];

    // 오늘 이미 생성된 브리핑이 있으면 캐시 반환
    const cached = await prisma.memo.findFirst({
      where: {
        userId,
        source: 'auto-brief',
        createdAt: { gte: new Date(today) },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (cached) {
      return reply.send({ success: true, briefing: cached.content, cached: true, generatedAt: cached.createdAt });
    }

    // 새로 생성
    try {
      const { dailyBrief } = await import('../services/knowledge-graph.js');
      const briefing = await dailyBrief(userId);

      // 캐시 저장
      const lab = await prisma.lab.findUnique({ where: { ownerId: userId } });
      await prisma.memo.create({
        data: {
          userId,
          labId: lab?.id || undefined,
          title: `📋 오늘의 브리핑 ${today}`,
          content: briefing,
          tags: ['auto-brief', today],
          source: 'auto-brief',
        },
      });

      return reply.send({ success: true, briefing, cached: false, generatedAt: new Date() });
    } catch (err: any) {
      console.error('Auto-brief failed:', err);
      return reply.send({ success: false, briefing: null, error: err.message });
    }
  });

  // ── POST /api/brain/verify/:memoryId — 정보 최신 확인 처리 ──
  app.post('/api/brain/verify/:memoryId', async (request: FastifyRequest<{
    Params: { memoryId: string };
    Body: { type: 'memo' | 'member' | 'project' | 'publication' };
  }>, reply: FastifyReply) => {
    const { memoryId } = request.params;
    const { type } = request.body as { type: string };

    const now = new Date();
    const updateData = {
      lastVerified: now,
      confidence: 1.0, // 검증 시 신뢰도 리셋
    };

    try {
      switch (type) {
        case 'memo':
          await prisma.memo.update({ where: { id: memoryId }, data: updateData });
          break;
        case 'member':
          await prisma.labMember.update({ where: { id: memoryId }, data: updateData });
          break;
        case 'project':
          await prisma.project.update({ where: { id: memoryId }, data: updateData });
          break;
        case 'publication':
          await prisma.publication.update({ where: { id: memoryId }, data: updateData });
          break;
        default:
          return reply.code(400).send({ error: `지원되지 않는 타입: ${type}. memo, member, project, publication 중 하나를 사용하세요.` });
      }

      return {
        success: true,
        message: '정보가 최신 확인 처리되었습니다.',
        memoryId,
        type,
        verifiedAt: now.toISOString(),
        newConfidence: 1.0,
      };
    } catch (err: any) {
      return reply.code(404).send({ error: `해당 ID의 ${type} 정보를 찾을 수 없습니다.` });
    }
  });
}
