/**
 * 주간보고 이메일 처리 cron — 학생(연세대 BLISS LAB) + 회사(링크솔루텍) 통합.
 *
 * Cowork SKILL `~/.claude/skills/email-briefing/SKILL.md`을 server-side로 이전한 버전.
 * SKILL의 6단계(T_last 조회 → Gmail 검색 → 본문 요약 → Notion 페이지 업데이트 → T_last 갱신
 * → 채팅 보고)를 Railway cron에 적합하게 단순화:
 *   - T_last 조회/갱신은 sliding window(LOOK_BACK_DAYS)로 대체 (Notion에 별도 상태 저장 X)
 *   - 채팅 보고는 result 객체로 반환 (호출자가 Slack/UI에 표시)
 *   - 학생 모드 4.5단계(프로젝트 DB 업데이트)는 본 cron 범위에서 제외 — labflow-app의
 *     project sync는 별도 gdrive-sync로 처리됨.
 *
 * 환경 (필수):
 *   NOTION_API_KEY        — Notion 페이지 read/update
 *   ANTHROPIC_API_KEY     — Claude Sonnet 요약 (1순위)
 *   GEMINI_API_KEY        — Gemini fallback (Anthropic 실패 시)
 *   GOOGLE_CLIENT_ID/SECRET — Gmail OAuth client
 *   LAB_ID                — Lab.ownerId 조회 (gdrive-sync와 동일 패턴)
 *   GOOGLE_REFRESH_TOKEN  — env에 박힌 PI 토큰 (1순위)
 *   ※ env 토큰 실패 시 LAB_ID + Lab.ownerId → GmailToken DB fallback
 *
 * 호출:
 *   await runEmailBriefing()              // both (default)
 *   await runEmailBriefing('student')     // 학생만
 *   await runEmailBriefing('company')     // 회사만
 */

import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Client as NotionClient } from '@notionhq/client';
import { google, type gmail_v1 } from 'googleapis';
import { env } from '../config/env.js';
import { prisma } from '../config/prisma.js';
import { decryptToken, isEncrypted } from '../utils/crypto.js';

// ── 리소스 ID (SKILL.md "리소스 ID" 섹션) ─────────────────────
const NOTION_STUDENT_PAGE_ID = '311f9f17-6cf4-8086-b90c-f665a712a928';
const NOTION_COMPANY_PAGE_ID = '311f9f17-6cf4-8095-ac72-e31e2274dfdb';

// 이전에 처리한 범위 (T_last 대안) — 7일 sliding window.
// SKILL은 Notion 페이지에서 T_last를 읽지만 cron은 매주 1회 고정 실행이라 단순화 가능.
const LOOK_BACK_DAYS = 7;

// ── 학생 명단 (SKILL.md 2-A 표) ─────────────────────────────
interface MemberSpec {
  name: string;
  email?: string;        // 미확인 학생은 제목 패턴 매칭만
  matchPattern?: string; // 미확인 학생용 보조 검색 ('@yonsei.ac.kr' + subject)
}

const STUDENT_MEMBERS: MemberSpec[] = [
  { name: '김수아', email: 'sooa.kim38@yonsei.ac.kr' },
  { name: '김태영', email: 'taeyoung.kim92@yonsei.ac.kr' },
  { name: '조예진', email: 'yejin.jo12@yonsei.ac.kr' },
  { name: '이유림', email: 'l22yurim@yonsei.ac.kr' },
  { name: '박시연', email: 'pksy51630@yonsei.ac.kr' },
  { name: '육근영', email: 'kyyook1118@yonsei.ac.kr' },
  { name: '함혜인', email: 'hhi0706@yonsei.ac.kr' },
  { name: '손가영', email: 'sonky0803@yonsei.ac.kr' },
  { name: '강민경', email: 'mkkang@yonsei.ac.kr' },
  { name: '정윤민', email: 'yunminj@yonsei.ac.kr' },
  { name: '김찬수', email: 'nce9080@yonsei.ac.kr' },
  { name: '김미도', email: 'kmd08@yonsei.ac.kr' },
  { name: '장한빛', email: 'hanbit1jang@gmail.com' },
  { name: '박지민', matchPattern: 'yonsei.ac.kr' },
  { name: '홍승완', matchPattern: 'yonsei.ac.kr' },
];

// ── 회사 직원 명단 (SKILL.md 2-B 표) ────────────────────────
const COMPANY_MEMBERS: MemberSpec[] = [
  { name: '조동인', email: 'chodi@lynksolutec.com' },
  { name: '경영관리', email: 'sales@lynksolutec.com' },
  { name: 'RA', email: 'ra@lynksolutec.com' },
  { name: '김성권', email: 'sk_kim@lynksolutec.com' },
  // 성미정 — 퇴사, 팔로업 불필요
];

// ── 결과 타입 ─────────────────────────────────────────────
export interface EmailBriefingResult {
  scope: 'student' | 'company' | 'both';
  emailsFound: number;
  membersUpdated: number;
  errors: Array<{ member: string; reason: string }>;
  ranAt: string;
}

// ─────────────────────────────────────────────────────────
// Gmail OAuth (gdrive-sync findOwnerGmailToken 패턴)
// ─────────────────────────────────────────────────────────

async function findOwnerGmailToken() {
  if (env.LAB_OWNER_EMAIL) {
    const t = await prisma.gmailToken.findFirst({
      where: {
        OR: [{ email: env.LAB_OWNER_EMAIL }, { user: { is: { email: env.LAB_OWNER_EMAIL } } }],
        refreshToken: { not: null },
      },
      orderBy: [{ primary: 'desc' }, { updatedAt: 'desc' }],
    });
    if (t) return t;
  }
  if (env.LAB_ID) {
    const lab = await prisma.lab.findUnique({
      where: { id: env.LAB_ID },
      select: { ownerId: true },
    });
    if (lab?.ownerId) {
      const t = await prisma.gmailToken.findFirst({
        where: { userId: lab.ownerId, refreshToken: { not: null } },
        orderBy: [{ primary: 'desc' }, { updatedAt: 'desc' }],
      });
      if (t) return t;
    }
  }
  return null;
}

async function buildGmailClient(): Promise<gmail_v1.Gmail> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error('GOOGLE_CLIENT_ID/SECRET 미설정 — Gmail OAuth 불가');
  }
  const oauth2 = new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);

  // 1순위: env.GOOGLE_REFRESH_TOKEN (gdrive-sync와 동일)
  if (env.GOOGLE_REFRESH_TOKEN) {
    try {
      oauth2.setCredentials({ refresh_token: env.GOOGLE_REFRESH_TOKEN });
      await oauth2.refreshAccessToken();
      return google.gmail({ version: 'v1', auth: oauth2 });
    } catch (e: any) {
      console.warn(`[email-briefing] env.GOOGLE_REFRESH_TOKEN 실패: ${e?.message} → DB 토큰 fallback`);
    }
  }

  // 2순위: Lab.ownerId → GmailToken (DB)
  const token = await findOwnerGmailToken();
  if (!token?.refreshToken) {
    throw new Error(
      'Gmail OAuth 토큰 없음 — env.GOOGLE_REFRESH_TOKEN 또는 OWNER GmailToken 둘 다 미설정/만료. ' +
      '/settings에서 Gmail 재연결 또는 Railway env 갱신 필요.',
    );
  }
  const refresh = isEncrypted(token.refreshToken) ? decryptToken(token.refreshToken) : token.refreshToken;
  oauth2.setCredentials({ refresh_token: refresh });
  try {
    await oauth2.refreshAccessToken();
  } catch (e: any) {
    throw new Error(`Gmail OAuth 토큰 만료 (${token.email}): ${e?.message}. /settings에서 재연결 필요.`);
  }
  return google.gmail({ version: 'v1', auth: oauth2 });
}

// ─────────────────────────────────────────────────────────
// Gmail 검색 + 본문 추출
// ─────────────────────────────────────────────────────────

interface FoundMail {
  member: MemberSpec;
  subject: string;
  body: string;
  receivedAt: Date;
}

function extractPlainBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return '';
  if (payload.body?.data) return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  for (const p of payload.parts || []) {
    if (p.mimeType === 'text/plain' && p.body?.data) {
      return Buffer.from(p.body.data, 'base64').toString('utf-8');
    }
    if (p.parts) {
      const r = extractPlainBody(p);
      if (r) return r;
    }
  }
  return '';
}

/** 학생/회사 모드별 Gmail 검색 — SKILL.md 2단계 */
async function searchWeeklyReports(
  gmail: gmail_v1.Gmail,
  members: MemberSpec[],
  afterDate: Date,
): Promise<FoundMail[]> {
  const afterEpoch = Math.floor(afterDate.getTime() / 1000);
  const results: FoundMail[] = [];

  // 이메일 확인된 멤버: from: 쿼리 묶어서 1회 호출
  const emailedMembers = members.filter(m => m.email);
  if (emailedMembers.length > 0) {
    const fromQuery = emailedMembers.map(m => `from:${m.email}`).join(' OR ');
    const q = `(${fromQuery}) after:${afterEpoch}`;
    const list = await gmail.users.messages.list({ userId: 'me', maxResults: 100, q });
    const ids = (list.data.messages || []).map(m => m.id!);
    for (const id of ids) {
      try {
        const det = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
        const headers = det.data.payload?.headers || [];
        const fromHeader = headers.find(h => h.name?.toLowerCase() === 'from')?.value || '';
        const subject = headers.find(h => h.name?.toLowerCase() === 'subject')?.value || '';
        const matched = emailedMembers.find(m => m.email && fromHeader.toLowerCase().includes(m.email.toLowerCase()));
        if (!matched) continue;
        results.push({
          member: matched,
          subject,
          body: extractPlainBody(det.data.payload).slice(0, 8000),
          receivedAt: new Date(Number(det.data.internalDate) || Date.now()),
        });
      } catch (e: any) {
        console.warn(`[email-briefing] 메시지 ${id} 가져오기 실패: ${e?.message}`);
      }
    }
  }

  // 미확인 멤버 (박지민/홍승완): 제목 패턴 매칭 — 본인 도메인 + 주간보고 키워드
  // SKILL.md 2-A "추가로 이메일 미확인 학생 대응"
  const unmappedMembers = members.filter(m => !m.email && m.matchPattern);
  if (unmappedMembers.length > 0) {
    const q = `subject:(Weekly Report OR 주간보고) from:@${unmappedMembers[0].matchPattern} after:${afterEpoch}`;
    try {
      const list = await gmail.users.messages.list({ userId: 'me', maxResults: 50, q });
      const ids = (list.data.messages || []).map(m => m.id!);
      for (const id of ids) {
        try {
          const det = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
          const headers = det.data.payload?.headers || [];
          const fromHeader = headers.find(h => h.name?.toLowerCase() === 'from')?.value || '';
          const subject = headers.find(h => h.name?.toLowerCase() === 'subject')?.value || '';
          // 이름 매칭 — 발신자 표시명에 한글 이름 포함 시 해당 멤버에 귀속
          const matched = unmappedMembers.find(m => fromHeader.includes(m.name));
          if (!matched) continue;
          results.push({
            member: matched,
            subject,
            body: extractPlainBody(det.data.payload).slice(0, 8000),
            receivedAt: new Date(Number(det.data.internalDate) || Date.now()),
          });
        } catch (e: any) {
          console.warn(`[email-briefing] 미확인 학생 메시지 ${id} 실패: ${e?.message}`);
        }
      }
    } catch (e: any) {
      console.warn(`[email-briefing] 미확인 학생 검색 실패: ${e?.message}`);
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────
// 요약 (Sonnet → Gemini fallback)
// ─────────────────────────────────────────────────────────

async function summarizeReport(memberName: string, body: string, scope: 'student' | 'company'): Promise<string> {
  // SKILL.md 3단계 — 학생: 프로젝트별 1~2줄 / 회사: 업무 항목별 1~2줄
  const systemPrompt = scope === 'student'
    ? '학생 주간보고를 요약하라. 프로젝트별로 핵심 진행사항을 1~2줄로 압축. 인사말/서명 제거. 불릿 포맷 (- 프로젝트명: 내용).'
    : '회사 직원 주간보고를 요약하라. 업무 항목별로 핵심 진행사항을 1~2줄로 압축. 인사말/서명 제거. 불릿 포맷 (- 항목: 내용).';
  const userMessage = `[${memberName}] 주간보고 본문:\n\n${body}`;

  // 1순위: Sonnet (CLAUDE.md "이메일 브리핑: Sonnet → Gemini fallback")
  if (env.ANTHROPIC_API_KEY) {
    try {
      const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });
      const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
      if (text.trim()) return text.trim();
    } catch (e: any) {
      console.warn(`[email-briefing] Sonnet 실패 (${memberName}): ${e?.message} → Gemini fallback`);
    }
  }

  // 2순위: Gemini
  if (env.GEMINI_API_KEY) {
    try {
      const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
      const r = await model.generateContent(`${systemPrompt}\n\n${userMessage}`);
      const text = r.response.text();
      if (text.trim()) return text.trim();
    } catch (e: any) {
      console.warn(`[email-briefing] Gemini 실패 (${memberName}): ${e?.message}`);
    }
  }

  throw new Error('Sonnet/Gemini 모두 실패');
}

// ─────────────────────────────────────────────────────────
// Notion 페이지 업데이트 (SKILL.md 4-5단계)
// ─────────────────────────────────────────────────────────

/** Notion 페이지의 모든 블록을 가져와 멤버 섹션 시작 블록 ID를 찾는다 */
async function findMemberSectionBlockId(
  notion: NotionClient,
  pageId: string,
  memberName: string,
): Promise<string | null> {
  let cursor: string | undefined;
  do {
    const resp: any = await notion.blocks.children.list({
      block_id: pageId,
      page_size: 100,
      start_cursor: cursor,
    });
    for (const b of resp.results) {
      // heading_1/2/3 의 rich_text에 멤버 이름이 포함되면 해당 섹션
      const richText =
        b.heading_1?.rich_text || b.heading_2?.rich_text || b.heading_3?.rich_text;
      if (Array.isArray(richText)) {
        const text = richText.map((t: any) => t.plain_text || '').join('');
        if (text.includes(memberName)) return b.id;
      }
    }
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  return null;
}

/**
 * 새 bullet을 멤버 섹션 직후에 prepend (SKILL.md "기존 bullet 맨 위에" = 역순).
 * Notion API는 children.append 시 after 파라미터로 특정 블록 직후 삽입 가능.
 */
async function insertSummaryBullet(
  notion: NotionClient,
  pageId: string,
  afterBlockId: string,
  dateStr: string,
  summary: string,
): Promise<void> {
  // 요약 본문을 줄단위로 자르고, 첫 줄은 날짜 헤딩 bullet으로, 나머지는 들여쓰기된 bullet으로
  const lines = summary.split('\n').map(l => l.trim()).filter(Boolean);
  const headBullet = `${dateStr}: ${lines[0] || '(요약 없음)'}`;
  const subBullets = lines.slice(1);

  const children: any[] = [
    {
      object: 'block',
      type: 'bulleted_list_item',
      bulleted_list_item: {
        rich_text: [{ type: 'text', text: { content: headBullet } }],
        children: subBullets.length > 0
          ? subBullets.map(line => ({
              object: 'block',
              type: 'bulleted_list_item',
              bulleted_list_item: {
                rich_text: [{ type: 'text', text: { content: line.replace(/^[-*]\s*/, '') } }],
              },
            }))
          : undefined,
      },
    },
  ];

  await notion.blocks.children.append({
    block_id: pageId,
    children,
    after: afterBlockId,
  } as any);
}

// ─────────────────────────────────────────────────────────
// 모드별 처리
// ─────────────────────────────────────────────────────────

async function processScope(
  scope: 'student' | 'company',
  notion: NotionClient,
  gmail: gmail_v1.Gmail,
  result: EmailBriefingResult,
): Promise<void> {
  const members = scope === 'student' ? STUDENT_MEMBERS : COMPANY_MEMBERS;
  const pageId = scope === 'student' ? NOTION_STUDENT_PAGE_ID : NOTION_COMPANY_PAGE_ID;

  const afterDate = new Date(Date.now() - LOOK_BACK_DAYS * 86400000);
  const mails = await searchWeeklyReports(gmail, members, afterDate);
  result.emailsFound += mails.length;

  console.log(`[email-briefing] ${scope}: ${mails.length}건 수신 (${members.length}명 중)`);

  // 멤버별로 가장 최근 메일 1통씩만 처리 (한 주에 같은 사람이 여러 번 보낼 수 있음)
  const latestByMember = new Map<string, FoundMail>();
  for (const m of mails) {
    const existing = latestByMember.get(m.member.name);
    if (!existing || m.receivedAt > existing.receivedAt) {
      latestByMember.set(m.member.name, m);
    }
  }

  for (const [memberName, mail] of latestByMember) {
    try {
      const summary = await summarizeReport(memberName, mail.body, scope);

      const blockId = await findMemberSectionBlockId(notion, pageId, memberName);
      if (!blockId) {
        result.errors.push({ member: memberName, reason: 'Notion 페이지에서 멤버 섹션 미발견' });
        continue;
      }

      // YYYY.MM.DD 포맷 (KST 기준 — SKILL.md "- YYYY.MM.DD: 내용 요약")
      const kst = new Date(mail.receivedAt.getTime() + 9 * 60 * 60 * 1000);
      const dateStr = `${kst.getUTCFullYear()}.${String(kst.getUTCMonth() + 1).padStart(2, '0')}.${String(kst.getUTCDate()).padStart(2, '0')}`;

      await insertSummaryBullet(notion, pageId, blockId, dateStr, summary);
      result.membersUpdated++;

      // Notion rate limit 안전 페이스
      await new Promise(r => setTimeout(r, 350));
    } catch (e: any) {
      result.errors.push({ member: memberName, reason: e?.message || 'unknown' });
    }
  }
}

// ─────────────────────────────────────────────────────────
// 메인 진입점
// ─────────────────────────────────────────────────────────

export async function runEmailBriefing(scope: 'student' | 'company' | 'both' = 'both'): Promise<EmailBriefingResult> {
  const result: EmailBriefingResult = {
    scope,
    emailsFound: 0,
    membersUpdated: 0,
    errors: [],
    ranAt: new Date().toISOString(),
  };

  if (!env.NOTION_API_KEY) throw new Error('NOTION_API_KEY 미설정');

  const notion = new NotionClient({ auth: env.NOTION_API_KEY });
  const gmail = await buildGmailClient();

  if (scope === 'student' || scope === 'both') {
    try {
      await processScope('student', notion, gmail, result);
    } catch (e: any) {
      console.error(`[email-briefing] 학생 모드 실패: ${e?.message}`);
      result.errors.push({ member: '(student-scope)', reason: e?.message || 'unknown' });
    }
  }
  if (scope === 'company' || scope === 'both') {
    try {
      await processScope('company', notion, gmail, result);
    } catch (e: any) {
      console.error(`[email-briefing] 회사 모드 실패: ${e?.message}`);
      result.errors.push({ member: '(company-scope)', reason: e?.message || 'unknown' });
    }
  }

  console.log(
    `[email-briefing] scope=${scope} emails=${result.emailsFound} updated=${result.membersUpdated} errors=${result.errors.length}`,
  );
  return result;
}
