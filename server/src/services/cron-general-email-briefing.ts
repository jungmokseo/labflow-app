/**
 * 일반 이메일 브리핑 cron — 매일 KST 07:00 실행.
 *
 * 서정목 교수의 통합 Gmail 계정(jungmok.seo@gmail.com — 연세대/링크솔루텍/개인 3개 계정 포워딩)에서
 * 지난 24시간 동안 받은 이메일을 검색하여 기관별·성격별로 분류하고, Sonnet으로 ~5문장 한국어 요약을 생성한다.
 * 결과는 PI Slack DM(ADMIN_USER_ID)으로 전송하며, manual trigger 응답에도 같은 markdown을 반환한다.
 *
 * 마이그레이션 출처: ~/.claude/skills/general-email-briefing/SKILL.md
 *   (Cowork에서 매일 수동 실행하던 스킬을 server-side cron으로 이전. T_last/Notion 의존 제거 — 24h 윈도우 고정.)
 *
 * 주간보고(`주간 진행사항 보고`, `Weekly Report`)는 별도 cron-email-briefing이 처리하므로 여기서는 제외.
 *
 * 환경:
 *   ANTHROPIC_API_KEY  (필수 — 분류·요약. 실패 시 Gemini fallback)
 *   GEMINI_API_KEY     (필수 — Anthropic fallback)
 *   GOOGLE_CLIENT_ID/SECRET (필수 — Gmail OAuth client)
 *   GOOGLE_REFRESH_TOKEN    (1순위 PI 토큰. 없으면 DB GmailToken으로 fallback)
 *   SLACK_BOT_TOKEN    (PI Slack DM 전송)
 *   ADMIN_USER_ID      (PI Slack user ID — DM 채널)
 */

import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { google, type gmail_v1 } from 'googleapis';
import { env } from '../config/env.js';
import { basePrismaClient as prisma } from '../config/prisma.js';
import { decryptToken, isEncrypted } from '../utils/crypto.js';
import { postSlackAdminDm, postSlackAdminDmChunked } from './cron-shared/slack-api.js';

// 주간보고 제외 패턴 (cron-email-briefing이 별도 처리)
const WEEKLY_REPORT_PATTERN = /weekly\s*report|주간\s*진행\s*사항\s*보고|주간보고/i;

// 분류 schema
// org는 EmailProfile.groups에서 동적으로 결정 — 사용자가 ResearchFlow /settings에서 설정.
// profile 없으면 기본 3개 그룹 (yonsei / lynksolutec / personal)으로 fallback.
type Urgency = 'urgent' | 'action-needed' | 'schedule' | 'info' | 'promo';

interface OrgGroup {
  name: string;     // e.g., "연세대학교"
  emoji: string;    // e.g., "🏫"
  domains: string[]; // e.g., ["yonsei.ac.kr"]
}

const DEFAULT_GROUPS: OrgGroup[] = [
  { name: '연세대학교', emoji: '🏫', domains: ['yonsei.ac.kr'] },
  { name: '링크솔루텍', emoji: '🏢', domains: ['lynksolutec.com'] },
  // personal은 매칭 안 되는 모든 메일 — 매핑 코드에서 처리
];
const FALLBACK_GROUP: OrgGroup = { name: '개인', emoji: '👤', domains: [] };

const URGENCY_LABEL: Record<Urgency, string> = {
  urgent: '⚠️ 긴급',
  'action-needed': '📝 대응필요',
  schedule: '📅 일정',
  info: '📰 정보성',
  promo: '🛒 광고',
};
const URGENCY_ORDER: Record<Urgency, number> = {
  urgent: 1,
  'action-needed': 2,
  schedule: 3,
  info: 4,
  promo: 5,
};

// EmailProfile에서 가져오는 사용자 맞춤 설정 (ResearchFlow /settings에서 등록)
interface BriefingProfile {
  groups: OrgGroup[];           // 기관 분류 — 비어 있으면 DEFAULT_GROUPS 사용
  keywords: string[];           // 중요도 상향 키워드 (e.g., "PMK-08", "박지혜")
  importanceRules: Array<{ condition: string; action: string; description?: string }>; // 사용자 맞춤 규칙
  excludePatterns: Array<{ field: 'subject' | 'from'; pattern: string }>; // 제외할 메일
}

interface ParsedEmail {
  messageId: string;
  threadId: string;
  sender: string;       // raw From header
  senderName: string;
  subject: string;
  snippet: string;
  body: string;         // text/plain (5KB cap)
  toCC: string;
  receivedAt: Date;
  // ── thread 대응 상태 (2026-05-19 추가) ──
  // 사용자(PI)가 이 thread에 답장한 적이 있으면 true.
  // urgent/action-needed로 분류되어도 후처리에서 info로 강등 — "이미 처리한 메일"이 자꾸 [대응] 표시되던 문제 해결.
  userReplied: boolean;
  userRepliedAt?: Date;  // 가장 최근 사용자 발신 시각 (있을 때만)
}

interface BriefedEmail extends ParsedEmail {
  orgName: string;      // 동적 — profile.groups[i].name 또는 '개인'
  orgEmoji: string;     // 동적
  urgency: Urgency;
  summary: string;      // ~5 sentence Korean briefing
}

export interface GeneralBriefingResult {
  emailsScanned: number;
  emailsBriefed: number;
  excludedWeeklyReports: number;
  slackDmSent: boolean;
  briefingMarkdown: string;
  errors: string[];
  ranAt: string;
}

// ─────────────────────────────────────────────
// Gmail OAuth — gdrive-sync.ts findOwnerGmailToken 패턴 차용
// ─────────────────────────────────────────────

function safeDecrypt(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  return isEncrypted(value) ? decryptToken(value) : value;
}

async function findOwnerGmailToken() {
  // PI 식별: LAB_OWNER_EMAIL → LAB_OWNER_CLERK_ID → Lab.ownerId 순. cross-user contamination 방지.
  if (env.LAB_OWNER_EMAIL) {
    const t = await prisma.gmailToken.findFirst({
      where: {
        OR: [
          { email: env.LAB_OWNER_EMAIL },
          { user: { is: { email: env.LAB_OWNER_EMAIL } } },
        ],
        refreshToken: { not: null },
      },
      orderBy: [{ primary: 'desc' }, { updatedAt: 'desc' }],
    });
    if (t) return t;
  }
  if (env.LAB_OWNER_CLERK_ID) {
    const t = await prisma.gmailToken.findFirst({
      where: { user: { is: { clerkId: env.LAB_OWNER_CLERK_ID } }, refreshToken: { not: null } },
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

  // 1순위: env.GOOGLE_REFRESH_TOKEN (PI 고정 토큰)
  if (env.GOOGLE_REFRESH_TOKEN) {
    try {
      oauth2.setCredentials({ refresh_token: env.GOOGLE_REFRESH_TOKEN });
      // refresh access token 유효성 검증 — 만료된 refresh token은 여기서 invalid_grant
      await oauth2.refreshAccessToken();
      return google.gmail({ version: 'v1', auth: oauth2 });
    } catch (err: any) {
      const msg = err?.response?.data?.error_description || err?.message || 'unknown';
      console.warn(`[general-email-briefing] env.GOOGLE_REFRESH_TOKEN 실패 (${msg}) → DB GmailToken fallback 시도`);
    }
  }

  // 2순위: DB GmailToken (PI)
  const token = await findOwnerGmailToken();
  if (!token?.refreshToken) {
    throw new Error(
      'Gmail 인증 실패: env.GOOGLE_REFRESH_TOKEN 미설정/만료 + DB GmailToken 없음. ' +
      '/settings에서 PI Gmail 재연결 또는 Railway env GOOGLE_REFRESH_TOKEN 갱신 필요.',
    );
  }
  oauth2.setCredentials({
    access_token: safeDecrypt(token.accessToken),
    refresh_token: safeDecrypt(token.refreshToken),
    expiry_date: token.expiresAt?.getTime(),
  });
  try {
    await oauth2.refreshAccessToken();
  } catch (err: any) {
    const msg = err?.response?.data?.error_description || err?.message || 'unknown';
    throw new Error(`GmailToken (${token.email}) 만료 또는 invalid_grant — /settings에서 재연결 필요. (${msg})`);
  }
  return google.gmail({ version: 'v1', auth: oauth2 });
}

// ─────────────────────────────────────────────
// Gmail 메시지 가져오기 — 24h 윈도우
// ─────────────────────────────────────────────

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

function parseMsg(data: gmail_v1.Schema$Message): ParsedEmail {
  const headers = data.payload?.headers || [];
  const get = (name: string) =>
    headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
  const sender = get('From');
  return {
    messageId: data.id!,
    threadId: data.threadId!,
    sender,
    senderName: sender.split('<')[0].trim() || sender,
    subject: get('Subject') || '(제목 없음)',
    snippet: data.snippet || '',
    body: extractPlainBody(data.payload).slice(0, 5000),
    toCC: `${get('To')} ${get('Cc')}`.trim(),
    receivedAt: new Date(Number(data.internalDate) || Date.now()),
    userReplied: false, // enrichReplyStatus가 thread.get으로 채움
  };
}

/**
 * From 헤더에서 email address 추출 — "Name <addr@x.com>" 또는 "addr@x.com" 형태 모두 지원.
 */
function extractEmailAddress(fromHeader: string): string | null {
  if (!fromHeader) return null;
  const angle = fromHeader.match(/<([^>]+)>/);
  if (angle) return angle[1].trim().toLowerCase();
  const direct = fromHeader.match(/[\w.+-]+@[\w.-]+/);
  return direct ? direct[0].toLowerCase() : null;
}

/**
 * PI 본인 email 결정 — env.LAB_OWNER_EMAIL 우선, fallback DB GmailToken.email.
 * "사용자가 보낸 thread message" 판정 시 From header가 이 주소와 일치하는지 확인.
 */
async function resolveOwnerEmail(): Promise<string | null> {
  if (env.LAB_OWNER_EMAIL) return env.LAB_OWNER_EMAIL.toLowerCase();
  const token = await findOwnerGmailToken();
  return token?.email?.toLowerCase() || null;
}

/**
 * 받은 이메일들의 thread를 batch fetch하여 사용자(PI)가 이미 답장한 thread를 표시.
 *
 * Gmail thread API:
 *   users.threads.get(id=threadId) → thread의 모든 message 반환 (헤더 only로 충분 — format='metadata')
 *
 * 판정 룰:
 *   - thread의 어떤 message의 From이 ownerEmail과 일치 AND
 *   - 그 message가 받은 메일(internalDate) 이후 발신 (= 사용자가 답장한 것)
 *
 * 같은 thread 여러 이메일은 한 번만 fetch (dedupe).
 *
 * Cost: 받은 이메일 30개 ≈ thread 20개 → 20 API calls × ~200ms / 5 concurrency = ~1초 추가.
 */
async function enrichReplyStatus(gmail: gmail_v1.Gmail, emails: ParsedEmail[], ownerEmail: string | null): Promise<void> {
  if (!ownerEmail) return; // owner 식별 안 되면 모든 메일 userReplied=false 유지

  const uniqueThreadIds = [...new Set(emails.map(e => e.threadId))];
  // threadId → { userReplied: bool, latestReplyAt?: Date }
  const threadState = new Map<string, { userReplied: boolean; latestReplyAt?: Date }>();

  const concurrency = 5;
  for (let i = 0; i < uniqueThreadIds.length; i += concurrency) {
    const batch = uniqueThreadIds.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      // format='metadata' + metadataHeaders=['From','Date'] — body 미포함으로 light
      batch.map(threadId =>
        gmail.users.threads.get({
          userId: 'me',
          id: threadId,
          format: 'metadata',
          metadataHeaders: ['From', 'Date'],
        }),
      ),
    );
    for (let j = 0; j < settled.length; j++) {
      const tid = batch[j];
      const r = settled[j];
      if (r.status !== 'fulfilled') {
        // thread fetch 실패해도 cron 계속 — 그 email은 userReplied=false 그대로
        threadState.set(tid, { userReplied: false });
        continue;
      }
      const messages = r.value.data.messages || [];
      let userReplied = false;
      let latestReplyAt: Date | undefined;
      for (const m of messages) {
        const fromHeader = m.payload?.headers?.find(h => h.name?.toLowerCase() === 'from')?.value || '';
        const fromAddr = extractEmailAddress(fromHeader);
        if (fromAddr && fromAddr === ownerEmail) {
          userReplied = true;
          const internalMs = Number(m.internalDate);
          if (internalMs && Number.isFinite(internalMs)) {
            const d = new Date(internalMs);
            if (!latestReplyAt || d > latestReplyAt) latestReplyAt = d;
          }
        }
      }
      threadState.set(tid, { userReplied, latestReplyAt });
    }
  }

  // 받은 이메일에 thread state 반영. 단 사용자 답장이 메일 도착 이후일 때만 userReplied=true.
  for (const email of emails) {
    const state = threadState.get(email.threadId);
    if (!state || !state.userReplied) continue;
    // 사용자 답장이 메일 수신 시점 이후여야 "처리됨". 이전이면 같은 thread이지만 새 메일에는 아직 답 안 함.
    if (state.latestReplyAt && state.latestReplyAt.getTime() >= email.receivedAt.getTime()) {
      email.userReplied = true;
      email.userRepliedAt = state.latestReplyAt;
    }
  }
}

async function fetchRecentEmails(gmail: gmail_v1.Gmail): Promise<ParsedEmail[]> {
  // SKILL.md: `is:unread newer_than:1d` 변형. 읽음 상태 무관하게 24h 윈도우로 잡음 (PI가 모바일에서 미리 읽었어도 브리핑에 포함).
  const afterEpoch = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
  const q = `after:${afterEpoch} -from:me -category:promotions -category:social`;

  const allIds: Array<{ id: string }> = [];
  let pageToken: string | undefined;
  for (let p = 0; p < 5; p++) {
    const list = await gmail.users.messages.list({ userId: 'me', maxResults: 100, q, pageToken });
    allIds.push(...(list.data.messages || []).map(m => ({ id: m.id! })));
    pageToken = list.data.nextPageToken || undefined;
    if (!pageToken) break;
  }

  // 상세 조회 — 부분 실패 허용
  const result: ParsedEmail[] = [];
  const concurrency = 5;
  for (let i = 0; i < allIds.length; i += concurrency) {
    const batch = allIds.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      batch.map(m => gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' })),
    );
    for (const r of settled) {
      if (r.status === 'fulfilled') result.push(parseMsg(r.value.data));
    }
  }
  return result;
}

// ─────────────────────────────────────────────
// EmailProfile (ResearchFlow /settings 에 저장된 PI 맞춤 설정) 가져오기
// ─────────────────────────────────────────────

/**
 * PI의 EmailProfile DB row를 가져와서 BriefingProfile로 정규화.
 * - 없거나 비어 있으면 DEFAULT_GROUPS만 사용 (backward compat).
 * - LAB_OWNER_EMAIL → LAB_OWNER_CLERK_ID → Lab.ownerId 순으로 PI userId 식별 (findOwnerGmailToken과 동일 패턴).
 */
async function loadBriefingProfile(): Promise<BriefingProfile> {
  let userId: string | null = null;
  if (env.LAB_OWNER_EMAIL) {
    const u = await prisma.user.findFirst({ where: { email: env.LAB_OWNER_EMAIL }, select: { id: true } });
    if (u) userId = u.id;
  }
  if (!userId && env.LAB_OWNER_CLERK_ID) {
    const u = await prisma.user.findFirst({ where: { clerkId: env.LAB_OWNER_CLERK_ID }, select: { id: true } });
    if (u) userId = u.id;
  }
  if (!userId && env.LAB_ID) {
    const lab = await prisma.lab.findUnique({ where: { id: env.LAB_ID }, select: { ownerId: true } });
    if (lab?.ownerId) userId = lab.ownerId;
  }

  // profile 없으면 default groups + 빈 rules
  if (!userId) {
    return { groups: DEFAULT_GROUPS, keywords: [], importanceRules: [], excludePatterns: [] };
  }

  const profile = await prisma.emailProfile.findUnique({ where: { userId } });
  if (!profile) {
    return { groups: DEFAULT_GROUPS, keywords: [], importanceRules: [], excludePatterns: [] };
  }

  // JSON column 안전 파싱
  const groups = parseGroups(profile.groups);
  const keywords = parseStringArray(profile.keywords);
  const importanceRules = parseImportanceRules(profile.importanceRules);
  const excludePatterns = parseExcludePatterns(profile.excludePatterns);

  return {
    groups: groups.length > 0 ? groups : DEFAULT_GROUPS,
    keywords,
    importanceRules,
    excludePatterns,
  };
}

function parseGroups(v: unknown): OrgGroup[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((g): g is Record<string, unknown> => g !== null && typeof g === 'object')
    .map(g => ({
      name: typeof g.name === 'string' ? g.name : '',
      emoji: typeof g.emoji === 'string' ? g.emoji : '📁',
      domains: Array.isArray(g.domains) ? g.domains.filter((d): d is string => typeof d === 'string') : [],
    }))
    .filter(g => g.name.length > 0);
}

function parseStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is string => typeof s === 'string' && s.length > 0);
}

function parseImportanceRules(v: unknown): BriefingProfile['importanceRules'] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
    .map(r => ({
      condition: typeof r.condition === 'string' ? r.condition : '',
      action: typeof r.action === 'string' ? r.action : '',
      description: typeof r.description === 'string' ? r.description : undefined,
    }))
    .filter(r => r.condition.length > 0 && r.action.length > 0);
}

function parseExcludePatterns(v: unknown): BriefingProfile['excludePatterns'] {
  if (!Array.isArray(v)) return [];
  const out: BriefingProfile['excludePatterns'] = [];
  for (const p of v) {
    if (p === null || typeof p !== 'object') continue;
    const rec = p as Record<string, unknown>;
    const field: 'subject' | 'from' = rec.field === 'from' ? 'from' : 'subject';
    const pattern = typeof rec.pattern === 'string' ? rec.pattern : '';
    if (pattern.length > 0) out.push({ field, pattern });
  }
  return out;
}

/**
 * 발신자 도메인으로 group 매칭 — rule-based 1차 분류 (LLM 호출 전).
 * profile.groups를 위에서부터 순회. 매칭 없으면 FALLBACK_GROUP ('개인').
 */
function matchGroupByDomain(sender: string, groups: OrgGroup[]): OrgGroup {
  const senderLower = sender.toLowerCase();
  for (const g of groups) {
    if (g.domains.some(d => senderLower.includes(d.toLowerCase()))) return g;
  }
  return FALLBACK_GROUP;
}

// ─────────────────────────────────────────────
// 분류·요약 — Anthropic Sonnet → Gemini fallback
// ─────────────────────────────────────────────

/**
 * 동적 분류 prompt 생성 — ResearchFlow email.ts buildClassificationPrompt와 1:1 정합.
 * profile.groups + keywords + importanceRules 모두 prompt에 주입하여 PI 맞춤 분류.
 */
function buildClassifySystemPrompt(profile: BriefingProfile): string {
  // ── 기관 정의 ──
  const groupList = profile.groups
    .map(g => `- "${g.name}": @${g.domains.join(', @')} 도메인의 발신자/수신지`)
    .join('\n');
  const groupNames = [...profile.groups.map(g => g.name), FALLBACK_GROUP.name];

  // ── keywords ──
  let keywordSection = '';
  if (profile.keywords.length > 0) {
    keywordSection = `\n- **키워드 상향:** 다음 키워드가 제목/내용에 등장하면 중요도 1단계 상향: ${profile.keywords.join(', ')}`;
  }

  // ── importanceRules ──
  let rulesSection = '';
  if (profile.importanceRules.length > 0) {
    const rules = profile.importanceRules
      .map((r, i) => `${i + 1}. ${r.condition} → ${r.action}${r.description ? ` (${r.description})` : ''}`)
      .join('\n');
    rulesSection = `\n\n## 사용자 맞춤 중요도 규칙 (순서대로 적용)\n${rules}`;
  }

  return `당신은 서정목 교수(연세대 BLISS LAB / 링크솔루텍 CEO)의 이메일 분류·요약 비서입니다.

각 이메일을 다음 두 축으로 분류하고 한국어 요약을 작성하세요.

## 기관 (orgName)
${groupList}
- "${FALLBACK_GROUP.name}": 위에 해당하지 않는 모든 메일

응답의 orgName 필드는 위에 명시된 정확한 한국어 이름 중 하나만 사용: ${groupNames.map(n => `"${n}"`).join(', ')}.

## 성격 (urgency)
- "urgent": 마감 24시간 이내 또는 즉각 조치 필요. 저널 Decision/Review/Revision 등.
- "action-needed": 교수의 의견·결정·승인·답신 요청, 진학/포닥/채용 문의
- "schedule": 날짜·시간 포함된 이벤트, 마감일, 미팅 (조치는 캘린더 등록 수준)
- "info": 공지, 뉴스레터, 단순 CC, 처리 완료 보고
- "promo": Call for Papers, 광고성 투고 초대, 프로모션

## ⚠️ 답장 완료 처리 (가장 중요)
- 각 이메일의 input에 "userReplied: true" 표시가 있으면 **교수가 이미 이 thread에 답장한 메일**입니다.
- 답장 완료 메일은 **절대 "urgent" 또는 "action-needed"로 분류하지 마세요**. 후속 조치가 없는 한 "info" 또는 "schedule"로 분류.
- 단, 답장 후에 상대가 또 새 요청을 보낸 경우(예: "감사합니다, 그럼 한 가지 더…" 같이 명시적 후속 요청)는 다시 action-needed 가능 — 본문에서 새 요청이 명확할 때만.
- summary 첫 문장에 "(답장 완료)" 표시 후 핵심 요약. 예: "(답장 완료) 5/20 미팅 시간 확정 회신 마침. 추가 조치 없음."

## 중요도 조정 규칙${keywordSection}${rulesSection}

## 요약 (summary)
- 한국어 4~6문장. 발신자/제목 그대로 반복하지 말고 핵심 내용·조치 포인트·마감/일정을 담을 것.
- 연구 키워드(하이드로겔, 액체금속, 방오코팅, 자가치유 PDMS, 웨어러블 바이오일렉트로닉스 등)가 등장하면 강조.

반드시 JSON 배열로만 응답 (다른 텍스트 없이):
[{"index": 0, "orgName": "${profile.groups[0]?.name || FALLBACK_GROUP.name}", "urgency": "action-needed", "summary": "..."}]
`;
}

interface ClassifyInput {
  index: number;
  subject: string;
  from: string;
  toCC: string;
  snippet: string;
  body: string;
  userReplied: boolean;     // 사용자가 thread에 답장한 경우 true — prompt에서 강등 판단
  userRepliedAt?: string;   // ISO — 표시용
}

interface ClassifyOutput {
  index: number;
  orgName: string;      // 동적 group name — prompt에서 명시한 문자열 중 하나
  urgency: Urgency;
  summary: string;
}

function buildUserPrompt(items: ClassifyInput[]): string {
  return items
    .map(e => {
      const replyMarker = e.userReplied
        ? `\n⚠️ userReplied: true (교수가 ${e.userRepliedAt ? new Date(e.userRepliedAt).toISOString().slice(0, 16) : '이미'} 이 thread에 답장함 — info/schedule로 강등 권장)`
        : '';
      return `### Email ${e.index}${replyMarker}\nFrom: ${e.from}\nTo/Cc: ${e.toCC}\nSubject: ${e.subject}\nSnippet: ${e.snippet}\nBody: ${e.body.slice(0, 1500)}`;
    })
    .join('\n\n');
}

/**
 * JSON 배열 파싱 — 다음 케이스에 robust:
 *   - 응답 앞뒤에 설명 텍스트 (e.g. "Here's the classification:\n[...]")
 *   - markdown code fence (```json ... ```)
 *   - JSON 잘림 (max_tokens 초과로 마지막 객체가 짤린 경우)
 *
 * 잘림 복구: 마지막 정상 객체 끝에서 `]`로 닫아서 partial array 반환.
 */
function parseJsonArray(text: string, validOrgNames: Set<string>): ClassifyOutput[] {
  // 1) code fence 제거
  let cleaned = text.replace(/```(?:json)?\s*\n?/gi, '').replace(/```/g, '').trim();

  // 2) 처음 [ 위치 찾기
  const startIdx = cleaned.indexOf('[');
  if (startIdx < 0) throw new Error(`JSON 배열 미감지 (응답 앞 100자: ${text.slice(0, 100)})`);
  cleaned = cleaned.slice(startIdx);

  // 3) parse 시도 — 성공이면 OK
  let parsed: unknown;
  try {
    // 마지막 ] 까지 잘라서 (뒤에 남은 설명 텍스트 무시)
    const endIdx = cleaned.lastIndexOf(']');
    if (endIdx > 0) {
      parsed = JSON.parse(cleaned.slice(0, endIdx + 1));
    } else {
      throw new Error('missing closing bracket');
    }
  } catch {
    // 4) 잘린 응답 복구 — 마지막 정상 } 위치를 찾아 그 뒤로 ] 추가
    const lastBrace = cleaned.lastIndexOf('}');
    if (lastBrace < 0) throw new Error(`JSON parse 실패 + 정상 객체 없음 (응답 앞 200자: ${text.slice(0, 200)})`);
    const recovered = cleaned.slice(0, lastBrace + 1) + ']';
    try {
      parsed = JSON.parse(recovered);
    } catch (e: any) {
      throw new Error(`JSON parse 실패 (복구 시도 후): ${e?.message}. 응답 앞 200자: ${text.slice(0, 200)}`);
    }
  }

  if (!Array.isArray(parsed)) throw new Error('JSON이 배열 아님');
  const VALID_URG = new Set<Urgency>(['urgent', 'action-needed', 'schedule', 'info', 'promo']);
  // LLM이 orgName을 prompt에 명시한 정확한 값으로 출력해야 함. 매칭 실패 시 FALLBACK_GROUP.name으로 자동 강등.
  return parsed
    .filter((p: any) => typeof p?.index === 'number' && VALID_URG.has(p.urgency))
    .map((p: any) => {
      const rawOrg = String(p.orgName || p.org || '').trim();
      const orgName = validOrgNames.has(rawOrg) ? rawOrg : FALLBACK_GROUP.name;
      return {
        index: p.index,
        orgName,
        urgency: p.urgency as Urgency,
        summary: String(p.summary || '').slice(0, 1000),
      };
    });
}

// ── 배치 분류 설정 ────────────────────────────────────
// 한 배치당 이메일 수. 작을수록 token 안전 + per-batch fallback 격리도가 좋아짐.
// 10개 = 평균 800~1200 output tokens (max_tokens 2048 충분).
const BATCH_SIZE = 10;

// API 호출 timeout (ms). Sonnet 4.6은 50개를 한 번에 처리할 때 60s+ 걸림 — 배치는 짧음.
const CLASSIFY_TIMEOUT_MS = 90_000;

async function classifyWithSonnet(
  items: ClassifyInput[],
  systemPrompt: string,
  validOrgNames: Set<string>,
): Promise<ClassifyOutput[]> {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY 미설정');
  const anthropic = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    timeout: CLASSIFY_TIMEOUT_MS,
    maxRetries: 2, // SDK가 retryable 에러 (429/529 등) 자동 재시도
  });
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048, // 10개 이메일 × 평균 150 tokens = 1500 → 2048로 safety margin
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: buildUserPrompt(items) }],
  });
  // Sonnet 4.6 multi-block response 대응 — thinking + text 동시 반환 가능. text 블록 찾아서 사용.
  const textBlock = response.content.find(b => b.type === 'text');
  const text = textBlock?.type === 'text' ? textBlock.text : '';
  return parseJsonArray(text, validOrgNames);
}

async function classifyWithGemini(
  items: ClassifyInput[],
  systemPrompt: string,
  validOrgNames: Set<string>,
): Promise<ClassifyOutput[]> {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY 미설정');
  const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash' });

  // Gemini SDK는 native timeout 없음 → Promise.race로 강제 timeout
  const callPromise = model.generateContent({
    contents: [
      { role: 'user', parts: [{ text: `${systemPrompt}\n\n---\n\n${buildUserPrompt(items)}` }] },
    ],
    generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
  });
  const timeoutPromise = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error(`Gemini timeout after ${CLASSIFY_TIMEOUT_MS}ms`)), CLASSIFY_TIMEOUT_MS),
  );
  const result = await Promise.race([callPromise, timeoutPromise]);
  return parseJsonArray(result.response.text(), validOrgNames);
}

/**
 * 배치 분류 — inputs를 BATCH_SIZE개씩 나눠 병렬 호출.
 * 각 배치는 자체 local index 0..n-1로 호출 (모델 confusion 방지),
 * 결과는 globalIdx로 복원해서 반환.
 *
 * 각 배치는 독립적으로 Sonnet 시도 → 실패 시 Gemini fallback.
 * 두 모델 모두 실패한 배치만 unclassified로 (다른 배치는 살아남음).
 *
 * 반환: { classified, batchErrors }
 *   classified.index는 inputs 기준 global index (입력 그대로 매핑).
 */
async function classifyInBatches(
  inputs: ClassifyInput[],
  profile: BriefingProfile,
): Promise<{ classified: ClassifyOutput[]; batchErrors: string[] }> {
  const systemPrompt = buildClassifySystemPrompt(profile);
  const validOrgNames = new Set([...profile.groups.map(g => g.name), FALLBACK_GROUP.name]);

  // 배치 분할 + 각 배치 안에서 local index 0..n-1로 재매핑
  type BatchSlot = { localItems: ClassifyInput[]; globalIdxs: number[]; batchNum: number };
  const slots: BatchSlot[] = [];
  for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
    const slice = inputs.slice(i, i + BATCH_SIZE);
    slots.push({
      localItems: slice.map((e, localIdx) => ({ ...e, index: localIdx })),
      globalIdxs: slice.map(e => e.index),
      batchNum: Math.floor(i / BATCH_SIZE),
    });
  }

  const batchErrors: string[] = [];
  const results = await Promise.all(
    slots.map(async ({ localItems, globalIdxs, batchNum }) => {
      // Sonnet 시도
      try {
        const r = await classifyWithSonnet(localItems, systemPrompt, validOrgNames);
        if (r.length === 0) throw new Error('Sonnet 응답 빈 배열');
        return r.map(c => ({ ...c, index: globalIdxs[c.index] })).filter(c => c.index !== undefined);
      } catch (sonnetErr: any) {
        const sonnetMsg = sonnetErr?.message || String(sonnetErr);
        console.warn(`[general-email-briefing] batch ${batchNum} Sonnet 실패 (${sonnetMsg}) → Gemini fallback`);
        // Gemini fallback
        try {
          const r = await classifyWithGemini(localItems, systemPrompt, validOrgNames);
          if (r.length === 0) throw new Error('Gemini 응답 빈 배열');
          return r.map(c => ({ ...c, index: globalIdxs[c.index] })).filter(c => c.index !== undefined);
        } catch (geminiErr: any) {
          const geminiMsg = geminiErr?.message || String(geminiErr);
          const summary = `batch ${batchNum} (${localItems.length}건): sonnet=${sonnetMsg.slice(0, 80)} | gemini=${geminiMsg.slice(0, 80)}`;
          console.error(`[general-email-briefing] ${summary}`);
          batchErrors.push(summary);
          return []; // 이 배치만 unclassified — 다른 배치는 영향 없음
        }
      }
    }),
  );

  return {
    classified: results.flat(),
    batchErrors,
  };
}

// ─────────────────────────────────────────────
// 마크다운 렌더링
// ─────────────────────────────────────────────

function formatKstDate(d: Date): string {
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const yyyy = kst.getUTCFullYear();
  const mm = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(kst.getUTCDate()).padStart(2, '0');
  const hh = String(kst.getUTCHours()).padStart(2, '0');
  const mi = String(kst.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi} KST`;
}

function formatTime(d: Date): string {
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return `${String(kst.getUTCHours()).padStart(2, '0')}:${String(kst.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * Markdown 출력 — ResearchFlow 정책: 중요도 1차, 기관 2차.
 * 사용자 보고: "기관별로는 나누었는데 모든 메일을 그냥 요약" → 중요도 hierarchy가 시각적으로 약했음.
 * 변경: 중요도 섹션이 top-level 헤더, 같은 중요도 안에서 기관별 sub-grouping.
 *
 * 섹션 순서:
 *   1. ⚠️ 긴급           (org 표시 inline)
 *   2. 📝 대응필요        (org 표시 inline)
 *   3. 📅 일정            (org 표시 inline)
 *   4. 📰 정보성          (org별 collapsed list)
 *   5. 🛒 광고/프로모션   (sender만 모음)
 */
function buildMarkdown(briefed: BriefedEmail[]): string {
  const today = formatKstDate(new Date());
  const total = briefed.length;
  const counts = {
    urgent: briefed.filter(b => b.urgency === 'urgent').length,
    action: briefed.filter(b => b.urgency === 'action-needed').length,
    schedule: briefed.filter(b => b.urgency === 'schedule').length,
    info: briefed.filter(b => b.urgency === 'info').length,
    promo: briefed.filter(b => b.urgency === 'promo').length,
  };
  const repliedCount = briefed.filter(b => b.userReplied).length;

  const lines: string[] = [];
  lines.push(`*📧 일반 이메일 브리핑 — ${today}*`);
  const headerSuffix = repliedCount > 0 ? ` · ✅ 답장완료 ${repliedCount}` : '';
  lines.push(
    `총 ${total}건 신규 | ⚠️ ${counts.urgent} · 📝 ${counts.action} · 📅 ${counts.schedule} · 📰 ${counts.info} · 🛒 ${counts.promo}${headerSuffix}`,
  );
  lines.push('');

  // ── 중요도별 섹션 (urgent → action-needed → schedule) ──
  // 각 섹션 안에서 기관별로 sub-group (가독성 향상).
  const detailedUrgencies: Urgency[] = ['urgent', 'action-needed', 'schedule'];
  for (const urg of detailedUrgencies) {
    const inUrg = briefed.filter(b => b.urgency === urg);
    if (inUrg.length === 0) continue;
    lines.push(`*${URGENCY_LABEL[urg]} (${inUrg.length}건)*`);

    // 같은 urgency 안에서 orgName별 sub-group
    const byOrg = new Map<string, { emoji: string; items: BriefedEmail[] }>();
    for (const e of inUrg) {
      const bucket = byOrg.get(e.orgName);
      if (bucket) bucket.items.push(e);
      else byOrg.set(e.orgName, { emoji: e.orgEmoji, items: [e] });
    }
    // org 순서: 메일 많은 순
    const orgEntries = [...byOrg.entries()].sort((a, b) => b[1].items.length - a[1].items.length);
    for (const [orgName, { emoji, items }] of orgEntries) {
      lines.push(`  ${emoji} *${orgName}* (${items.length})`);
      for (const e of items) {
        const time = formatTime(e.receivedAt);
        const subjectShort = e.subject.length > 80 ? e.subject.slice(0, 77) + '...' : e.subject;
        const repliedMark = e.userReplied ? '✅ ' : '';
        lines.push(`  • ${repliedMark}*${subjectShort}* — _${e.senderName}_ (${time})`);
        lines.push(`    ${e.summary}`);
      }
    }
    lines.push('');
  }

  // ── 정보성 — 기관별 collapsed (한 줄 per 메일) ──
  const infoItems = briefed.filter(b => b.urgency === 'info');
  if (infoItems.length > 0) {
    lines.push(`*📰 정보성 (${infoItems.length}건)*`);
    const byOrg = new Map<string, { emoji: string; items: BriefedEmail[] }>();
    for (const e of infoItems) {
      const bucket = byOrg.get(e.orgName);
      if (bucket) bucket.items.push(e);
      else byOrg.set(e.orgName, { emoji: e.orgEmoji, items: [e] });
    }
    const orgEntries = [...byOrg.entries()].sort((a, b) => b[1].items.length - a[1].items.length);
    for (const [orgName, { emoji, items }] of orgEntries) {
      lines.push(`  ${emoji} *${orgName}*`);
      for (const e of items) {
        const repliedMark = e.userReplied ? '✅ ' : '';
        lines.push(`  • ${repliedMark}_${e.senderName}_ — ${e.summary.split('\n')[0].slice(0, 120)}`);
      }
    }
    lines.push('');
  }

  // ── 광고 — 발신자만 ──
  const promos = briefed.filter(b => b.urgency === 'promo');
  if (promos.length > 0) {
    lines.push(`*🛒 광고/프로모션 (${promos.length}건)*`);
    for (const e of promos) {
      lines.push(`- _${e.senderName}_: ${e.subject.slice(0, 100)}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

// ─────────────────────────────────────────────
// 메인 entry
// ─────────────────────────────────────────────

export async function runGeneralEmailBriefing(): Promise<GeneralBriefingResult> {
  const result: GeneralBriefingResult = {
    emailsScanned: 0,
    emailsBriefed: 0,
    excludedWeeklyReports: 0,
    slackDmSent: false,
    briefingMarkdown: '',
    errors: [],
    ranAt: new Date().toISOString(),
  };

  // 1. Gmail client
  let gmail: gmail_v1.Gmail;
  try {
    gmail = await buildGmailClient();
  } catch (err: any) {
    result.errors.push(`gmail-auth: ${err?.message || err}`);
    throw err; // 토큰 만료는 사용자 액션 필요 — 명확히 throw
  }

  // 2. fetch 24h
  let parsed: ParsedEmail[];
  try {
    parsed = await fetchRecentEmails(gmail);
  } catch (err: any) {
    const msg = err?.message || String(err);
    result.errors.push(`gmail-fetch: ${msg}`);
    if (/invalid_grant|unauthorized/i.test(msg)) {
      throw new Error(`Gmail 토큰 만료 — /settings에서 재연결 필요. (${msg})`);
    }
    throw err;
  }
  result.emailsScanned = parsed.length;

  // 2.4. Thread 답장 상태 추적 — PI가 이미 답장한 thread의 메일은 후처리에서 강등 처리.
  // 실패해도 cron 계속 진행 (모든 이메일 userReplied=false 유지).
  try {
    const ownerEmail = await resolveOwnerEmail();
    await enrichReplyStatus(gmail, parsed, ownerEmail);
  } catch (err: any) {
    console.warn(`[general-email-briefing] enrichReplyStatus 실패 — 답장 추적 skip (${err?.message})`);
  }

  // 2.5. EmailProfile (ResearchFlow /settings) 로드 — keywords/importanceRules/groups/excludePatterns
  let profile: BriefingProfile;
  try {
    profile = await loadBriefingProfile();
  } catch (err: any) {
    console.warn(`[general-email-briefing] EmailProfile 로드 실패 → default 사용 (${err?.message})`);
    profile = { groups: DEFAULT_GROUPS, keywords: [], importanceRules: [], excludePatterns: [] };
  }

  // 3. 주간보고 제외 + excludePatterns (사용자 등록 규칙)
  const excludeRegexes = profile.excludePatterns.map(p => {
    try { return { field: p.field, regex: new RegExp(p.pattern, 'i') }; }
    catch { return null; } // invalid regex skip
  }).filter((x): x is { field: 'subject' | 'from'; regex: RegExp } => x !== null);

  const filtered = parsed.filter(e => {
    if (WEEKLY_REPORT_PATTERN.test(e.subject)) {
      result.excludedWeeklyReports++;
      return false;
    }
    for (const ex of excludeRegexes) {
      const target = ex.field === 'subject' ? e.subject : e.sender;
      if (ex.regex.test(target)) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    result.briefingMarkdown = `*📧 일반 이메일 브리핑 — ${formatKstDate(new Date())}*\n\n지난 24시간 동안 새로운 이메일이 없습니다.`;
    const slack = await postSlackAdminDm(result.briefingMarkdown);
    result.slackDmSent = slack.ok;
    if (!slack.ok && slack.error) result.errors.push(`slack: ${slack.error}`);
    console.log(`[general-email-briefing] scanned=${result.emailsScanned} briefed=0 slack=${result.slackDmSent}`);
    return result;
  }

  // 4. 분류·요약 — 배치 분할 (BATCH_SIZE=10) + 배치별 Sonnet → Gemini fallback
  //    이전엔 50개 한 번에 분류 → 4096 토큰 초과 / 60s+ 타임아웃으로 JSON 잘림 → 두 모델 모두 실패.
  //    배치 분할로 단일 fail point 제거: 한 배치만 실패해도 나머지 배치는 살아남음.
  const classifyInputs: ClassifyInput[] = filtered.map((e, i) => ({
    index: i, // global index — classifyInBatches가 batch 내부에서 local 0..n-1로 재매핑 후 복원
    subject: e.subject,
    from: e.sender,
    toCC: e.toCC,
    snippet: e.snippet,
    body: e.body,
    userReplied: e.userReplied,
    userRepliedAt: e.userRepliedAt?.toISOString(),
  }));

  const { classified: totalClassified, batchErrors: allBatchErrors } = await classifyInBatches(classifyInputs, profile);
  if (allBatchErrors.length > 0) result.errors.push(...allBatchErrors);

  // 5. 분류 결과를 이메일에 매핑 (per-email 실패 → unclassified 섹션으로)
  //    LLM orgName → profile.groups의 emoji 매핑 (또는 도메인 매칭으로 fallback).
  const orgEmojiMap = new Map<string, string>(profile.groups.map(g => [g.name, g.emoji]));
  orgEmojiMap.set(FALLBACK_GROUP.name, FALLBACK_GROUP.emoji);
  const classMap = new Map(totalClassified.map(c => [c.index, c]));
  const briefed: BriefedEmail[] = [];
  const unclassified: ParsedEmail[] = [];
  let demotedCount = 0;
  for (let i = 0; i < filtered.length; i++) {
    const c = classMap.get(i);
    if (!c) {
      unclassified.push(filtered[i]);
      continue;
    }
    // LLM이 orgName 정확히 못 채운 경우 도메인 매칭으로 보정
    const orgName = orgEmojiMap.has(c.orgName) ? c.orgName : matchGroupByDomain(filtered[i].sender, profile.groups).name;
    const orgEmoji = orgEmojiMap.get(orgName) || FALLBACK_GROUP.emoji;

    // ── 답장 완료 후처리 safety net ──
    // prompt에서 LLM이 강등을 충분히 했는지 보장 못함 — 후처리로 명시적 강등.
    // userReplied=true인데 LLM이 여전히 urgent/action-needed로 둔 경우 info로 강등.
    // schedule은 유지 (날짜 정보 자체는 가치 있음).
    let finalUrgency = c.urgency;
    if (filtered[i].userReplied && (finalUrgency === 'urgent' || finalUrgency === 'action-needed')) {
      finalUrgency = 'info';
      demotedCount++;
    }

    // summary에 "(답장 완료)" prefix 보장 (LLM이 안 붙였으면 추가)
    let finalSummary = c.summary;
    if (filtered[i].userReplied && !/^\(답장 완료\)/.test(finalSummary)) {
      finalSummary = `(답장 완료) ${finalSummary}`;
    }

    briefed.push({
      ...filtered[i],
      orgName,
      orgEmoji,
      urgency: finalUrgency,
      summary: finalSummary,
    });
  }
  result.emailsBriefed = briefed.length;
  if (demotedCount > 0) {
    console.log(`[general-email-briefing] 답장 완료 후처리 강등: ${demotedCount}건 (urgent/action-needed → info)`);
  }

  // 6. 마크다운 + Slack DM
  // 분류 성공 0건이면 fallback (raw 메타 정보), 1건 이상이면 정상 + 분류 실패는 별도 섹션
  if (briefed.length === 0 && unclassified.length > 0) {
    result.briefingMarkdown =
      `*📧 일반 이메일 브리핑 — ${formatKstDate(new Date())}*\n` +
      `_⚠️ 분류 모델 모두 실패 (${allBatchErrors.length}개 배치). 메타 정보만 표시._\n\n` +
      unclassified
        .slice(0, 50)
        .map(e => `- ${e.subject.slice(0, 80)} _(${e.senderName})_`)
        .join('\n');
  } else {
    let markdown = buildMarkdown(briefed);
    // 일부 배치만 실패한 경우 — 분류 실패 이메일을 끝에 추가 (사용자가 알 수 있게)
    if (unclassified.length > 0) {
      markdown +=
        `\n\n*⚠️ 분류 실패 (${unclassified.length}건)*\n` +
        unclassified
          .slice(0, 20)
          .map(e => `- ${e.subject.slice(0, 80)} _(${e.senderName})_`)
          .join('\n');
    }
    result.briefingMarkdown = markdown;
  }

  // 장기 미실행 후 backfill 또는 많은 이메일 누적 시 markdown이 길어 Slack truncate 가능 →
  // chunked 발송으로 안전하게 여러 메시지로 분할 (3500자 cap, 섹션 경계 우선).
  const slack = await postSlackAdminDmChunked(result.briefingMarkdown);
  result.slackDmSent = slack.ok;
  if (slack.chunks && slack.chunks > 1) {
    console.log(`[general-email-briefing] Slack DM 분할 발송: ${slack.chunks} chunks (총 markdown ${result.briefingMarkdown.length}자)`);
  }
  if (!slack.ok && slack.error) {
    result.errors.push(`slack: ${slack.error}`);
    console.warn(`[general-email-briefing] Slack DM 실패 — ${slack.error}. Markdown은 manual trigger 응답에 포함됨.`);
  }

  console.log(
    `[general-email-briefing] scanned=${result.emailsScanned} briefed=${result.emailsBriefed} ` +
      `unclassified=${unclassified.length} excluded(weekly)=${result.excludedWeeklyReports} ` +
      `slack=${result.slackDmSent} batchErrors=${allBatchErrors.length}`,
  );
  return result;
}
