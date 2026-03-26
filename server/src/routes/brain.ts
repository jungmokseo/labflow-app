/**
 * 미니브레인 (Lab Memory) Routes — 3층 기억 구조 + 의도 분류 + 멀티홉 질의 체이닝
 *
 * POST   /api/brain/chat              → 미니브레인 대화 (3층 기억 + 멀티홉 DB 조회)
 * GET    /api/brain/channels           → 사용자 채널 목록
 * POST   /api/brain/channels           → 새 채널 생성
 * GET    /api/brain/channels/:id       → 채널 메시지 목록
 * DELETE /api/brain/channels/:id       → 채널 삭제
 * POST   /api/brain/memo               → 메모 저장 (수동)
 * GET    /api/brain/search             → Lab Memory 자연어 검색
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import { env } from '../config/env.js';
import { generateEmbedding, searchPapers } from '../services/embedding-service.js';

// ── Schemas ─────────────────────────────────────────
const chatSchema = z.object({
  channelId: z.string().optional(),
  message: z.string().min(1),
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
  | 'save_memo' | 'search_memory' | 'general_chat' | 'add_dict';

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
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

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
  return { intent: 'general_chat', entities: {} };
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
    if (matchedMemo.length) results.push(`💡 메모: ${matchedMemo.length}개 관련 메모`);
  }

  if (results.length > 0) {
    return '관련 정보를 찾았습니다:\n\n' + results.join('\n');
  }

  return ''; // 빈 문자열 = DB에 관련 정보 없음
}

// ══════════════════════════════════════════════════════
//  SINGLE-HOP DB QUERY (기존 로직 유지 + 유도형 응답)
// ══════════════════════════════════════════════════════

async function handleDbQuery(intent: Intent, entities: Record<string, string>, labId: string): Promise<string | null> {
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
          return matched.map(p =>
            `📋 **${p.name}**\n  과제번호: ${p.number || '미등록'}\n  지원기관: ${p.funder || '미등록'}\n  기간: ${p.period || '미등록'}\n  PM: ${p.pm || '미등록'}\n  사사문구: ${p.acknowledgment || '미등록 — 등록하시겠어요?'}`
          ).join('\n\n');
        }
        return `"${keyword}"에 해당하는 과제를 찾지 못했습니다. 등록된 과제 ${projects.length}건 중에 해당 키워드가 없습니다.`;
      }
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
          return matched.map(p =>
            `📄 **${p.title}**\n  저널: ${p.journal || '미등록'} (${p.year || ''})\n  저자: ${p.authors || '미등록'}\n  DOI: ${p.doi || '미등록'}`
          ).join('\n\n');
        }
        return `"${keyword}"에 해당하는 논문을 찾지 못했습니다. 등록된 논문 ${pubs.length}편 중에 해당 키워드가 없습니다.`;
      }
      return `총 ${pubs.length}편의 논문이 등록되어 있습니다.\n\n` +
        pubs.slice(0, 10).map(p => `• ${p.title} (${p.journal || ''}, ${p.year || ''})`).join('\n');
    }

    case 'query_member': {
      const members = await prisma.labMember.findMany({ where: { labId, active: true } });
      if (members.length === 0) return '등록된 구성원이 없습니다. 구성원 정보를 등록하시겠어요?';

      const name = entities.name || entities.query || '';
      if (name) {
        const matched = members.filter(m =>
          m.name.includes(name) || (m.email && m.email.includes(name))
        );
        if (matched.length > 0) {
          return matched.map(m =>
            `👤 **${m.name}** (${m.role})\n  이메일: ${m.email || '미등록'}\n  연락처: ${m.phone || '미등록'}`
          ).join('\n\n');
        }
        return `"${name}"에 해당하는 구성원을 찾지 못했습니다. 등록하시겠어요? "${name} 학생 추가해줘"라고 말씀해 주세요.`;
      }
      return `총 ${members.length}명의 구성원이 등록되어 있습니다:\n\n` +
        members.map(m => `• ${m.name} (${m.role}) — ${m.email || '이메일 미등록'}`).join('\n');
    }

    case 'query_meeting': {
      const meetings = await prisma.meeting.findMany({
        where: { userId: labId },
        orderBy: { createdAt: 'desc' },
        take: 5,
      });
      if (meetings.length === 0) return '저장된 미팅 기록이 없습니다. 미팅을 녹음하고 정리해 보시겠어요?';
      return meetings.map(m =>
        `🎙️ **${m.title}** (${m.createdAt.toLocaleDateString('ko-KR')})\n  ${m.summary?.slice(0, 200) || '요약 없음'}...`
      ).join('\n\n');
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
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

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
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

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
//  ROUTES
// ══════════════════════════════════════════════════════

export async function brainRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authMiddleware);

  // ── Chat (3층 기억 + 멀티홉 체이닝) ──────────────
  app.post('/api/brain/chat', async (request: FastifyRequest, reply: FastifyReply) => {
    const { channelId: inputChannelId, message } = chatSchema.parse(request.body);
    const userId = request.userId!;

    // 채널 가져오기 또는 생성
    let channelId = inputChannelId;
    if (!channelId) {
      let defaultChannel = await prisma.channel.findFirst({
        where: { userId, type: 'BRAIN' },
        orderBy: { createdAt: 'desc' },
      });
      if (!defaultChannel) {
        defaultChannel = await prisma.channel.create({
          data: { userId, type: 'BRAIN', name: '미니브레인' },
        });
      }
      channelId = defaultChannel.id;
    }

    const lab = await prisma.lab.findUnique({ where: { ownerId: userId } });

    // 1. 의도 분류 (multi_hop 포함)
    const classified = await classifyIntent(message);
    const { intent, entities, hops } = classified;

    // 2. DB 조회 — 멀티홉 vs 단일홉
    let dbResult: string | null = null;

    if (lab) {
      if (intent === 'multi_hop') {
        // 멀티홉 체이닝 실행
        dbResult = await executeMultiHopQuery(message, entities, hops, lab.id);
      } else if (['query_project', 'query_publication', 'query_member', 'query_meeting'].includes(intent)) {
        // 기존 단일홉 조회
        dbResult = await handleDbQuery(intent, entities, lab.id);
      }
    }

    // 3. 메모 저장 요청
    if (intent === 'save_memo' && lab) {
      await prisma.memo.create({
        data: {
          labId: lab.id,
          userId,
          content: message,
          source: 'chat',
          tags: entities.tags ? [entities.tags] : [],
        },
      });
      dbResult = '메모가 저장되었습니다.';
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
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const systemPrompt = `당신은 연구실 AI 비서 "LabFlow 미니브레인"입니다.
${lab?.responseStyle === 'casual' ? '친근하고 캐주얼한 어조로 답변하세요.' : '정중하고 전문적인 어조로 답변하세요.'}

핵심 규칙:
1. DB에 등록된 정보만 답변합니다. 추측하거나 지어내지 마세요.
2. [DB 조회 결과]가 제공되면, 그 결과를 자연스럽게 정리하여 전달하세요.
3. DB 조회 결과에 "미등록"이 있으면 사용자에게 등록을 제안하세요.
4. 정보가 전혀 없으면 "등록된 정보가 없습니다. 추가하시겠어요?"로 유도하세요.
5. 복합 질의의 경우, 연결 관계를 명확히 설명하세요 (예: "A 과제의 PM인 B님의 연락처는...").
6. 대화 중 새로운 연구실 정보가 언급되면 기억합니다.

${layerContext}`;

    const chatHistory = recentMessages.reverse().map(m => ({
      role: m.role === 'user' ? 'user' as const : 'model' as const,
      parts: [{ text: m.content }],
    }));

    let userContent = message;
    if (dbResult) {
      userContent = `${message}\n\n[DB 조회 결과 — 이 데이터만으로 답변하세요]\n${dbResult}`;
    }

    const chat = model.startChat({
      history: chatHistory,
      systemInstruction: systemPrompt,
    });

    const result = await chat.sendMessage(userContent);
    const responseText = result.response.text();

    // 8. AI 응답 저장
    await prisma.message.create({
      data: { channelId, role: 'assistant', content: responseText },
    });

    // 9. 비동기 후처리
    maybeGenerateSummary(channelId).catch(() => {});
    if (lab) {
      autoExtractInfo(message, responseText, lab.id).catch(() => {});
    }

    return {
      response: responseText,
      channelId,
      intent,
      multiHop: intent === 'multi_hop',
      dbResult: dbResult ? true : false,
    };
  });

  // ── Channel CRUD ──────────────────────────────────
  app.get('/api/brain/channels', async (request: FastifyRequest) => {
    return prisma.channel.findMany({
      where: { userId: request.userId! },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { messages: true } } },
    });
  });

  app.post('/api/brain/channels', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = createChannelSchema.parse(request.body);
    const channel = await prisma.channel.create({
      data: { userId: request.userId!, type: body.type, name: body.name },
    });
    return reply.code(201).send(channel);
  });

  app.get('/api/brain/channels/:id', async (request: FastifyRequest<{ Params: { id: string } }>) => {
    return prisma.message.findMany({
      where: { channelId: request.params.id },
      orderBy: { createdAt: 'asc' },
      take: 50,
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
        const m = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
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
      results.memos = await prisma.memo.findMany({
        where: {
          labId: lab.id,
          OR: [
            { content: { contains: query, mode: 'insensitive' } },
            { title: { contains: query, mode: 'insensitive' } },
            { tags: { has: query } },
          ],
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

    return results;
  });
}
