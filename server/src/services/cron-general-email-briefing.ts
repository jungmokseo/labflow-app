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
import { postSlackAdminDm } from './cron-shared/slack-api.js';

// 주간보고 제외 패턴 (cron-email-briefing이 별도 처리)
const WEEKLY_REPORT_PATTERN = /weekly\s*report|주간\s*진행\s*사항\s*보고|주간보고/i;

// 분류 schema
type OrgKind = 'yonsei' | 'lynksolutec' | 'personal';
type Urgency = 'urgent' | 'action-needed' | 'schedule' | 'info' | 'promo';

const ORG_LABEL: Record<OrgKind, string> = {
  yonsei: '🏫 연세대학교',
  lynksolutec: '🏢 링크솔루텍',
  personal: '👤 개인',
};
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
}

interface BriefedEmail extends ParsedEmail {
  org: OrgKind;
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
  };
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
// 분류·요약 — Anthropic Sonnet → Gemini fallback
// ─────────────────────────────────────────────

const CLASSIFY_SYSTEM_PROMPT = `당신은 서정목 교수(연세대 BLISS LAB / 링크솔루텍 CEO)의 이메일 분류·요약 비서입니다.

각 이메일을 다음 두 축으로 분류하고 한국어 요약을 작성하세요.

## 기관 (org)
- "yonsei": @yonsei.ac.kr 도메인, 연세대 관련 발신자/수신지
- "lynksolutec": @lynksolutec.com 도메인, 링크솔루텍 거래처/파트너 (정부 rnd@, 채용 saramin도 여기)
- "personal": 위 둘에 해당하지 않는 모든 메일

## 성격 (urgency)
- "urgent": 마감 24시간 이내 또는 즉각 조치 필요. 저널 Decision/Review/Revision 등.
- "action-needed": 교수의 의견·결정·승인·답신 요청, 진학/포닥/채용 문의
- "schedule": 날짜·시간 포함된 이벤트, 마감일, 미팅 (조치는 캘린더 등록 수준)
- "info": 공지, 뉴스레터, 단순 CC, 처리 완료 보고
- "promo": Call for Papers, 광고성 투고 초대, 프로모션

## 요약 (summary)
- 한국어 4~6문장. 발신자/제목 그대로 반복하지 말고 핵심 내용·조치 포인트·마감/일정을 담을 것.
- 연구 키워드(하이드로겔, 액체금속, 방오코팅, 자가치유 PDMS, 웨어러블 바이오일렉트로닉스 등)가 등장하면 강조.

반드시 JSON 배열로만 응답:
[{"index": 0, "org": "yonsei", "urgency": "action-needed", "summary": "..."}]
`;

interface ClassifyInput {
  index: number;
  subject: string;
  from: string;
  toCC: string;
  snippet: string;
  body: string;
}

interface ClassifyOutput {
  index: number;
  org: OrgKind;
  urgency: Urgency;
  summary: string;
}

function buildUserPrompt(items: ClassifyInput[]): string {
  return items
    .map(
      e =>
        `### Email ${e.index}\nFrom: ${e.from}\nTo/Cc: ${e.toCC}\nSubject: ${e.subject}\nSnippet: ${e.snippet}\nBody: ${e.body.slice(0, 1500)}`,
    )
    .join('\n\n');
}

function parseJsonArray(text: string): ClassifyOutput[] {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('JSON 배열 미감지');
  const parsed = JSON.parse(m[0]);
  if (!Array.isArray(parsed)) throw new Error('JSON이 배열 아님');
  const VALID_ORG = new Set<OrgKind>(['yonsei', 'lynksolutec', 'personal']);
  const VALID_URG = new Set<Urgency>(['urgent', 'action-needed', 'schedule', 'info', 'promo']);
  return parsed
    .filter((p: any) => typeof p?.index === 'number' && VALID_ORG.has(p.org) && VALID_URG.has(p.urgency))
    .map((p: any) => ({
      index: p.index,
      org: p.org as OrgKind,
      urgency: p.urgency as Urgency,
      summary: String(p.summary || '').slice(0, 1000),
    }));
}

async function classifyWithSonnet(items: ClassifyInput[]): Promise<ClassifyOutput[]> {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY 미설정');
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: [{ type: 'text', text: CLASSIFY_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: buildUserPrompt(items) }],
  });
  // Sonnet 4.6 multi-block response 대응 — thinking + text 동시 반환 가능. text 블록 찾아서 사용.
  const textBlock = response.content.find(b => b.type === 'text');
  const text = textBlock?.type === 'text' ? textBlock.text : '';
  return parseJsonArray(text);
}

async function classifyWithGemini(items: ClassifyInput[]): Promise<ClassifyOutput[]> {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY 미설정');
  const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite' });
  const result = await model.generateContent({
    contents: [
      { role: 'user', parts: [{ text: `${CLASSIFY_SYSTEM_PROMPT}\n\n---\n\n${buildUserPrompt(items)}` }] },
    ],
    generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
  });
  return parseJsonArray(result.response.text());
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

  const lines: string[] = [];
  lines.push(`*📧 일반 이메일 브리핑 — ${today}*`);
  lines.push(
    `총 ${total}건 신규 | 긴급 ${counts.urgent} · 대응필요 ${counts.action} · 일정 ${counts.schedule} · 정보성 ${counts.info} · 광고 ${counts.promo}`,
  );
  lines.push('');

  // 기관별 섹션
  const orgs: OrgKind[] = ['yonsei', 'lynksolutec', 'personal'];
  for (const org of orgs) {
    const inOrg = briefed.filter(b => b.org === org && b.urgency !== 'promo');
    if (inOrg.length === 0) continue;
    lines.push(`*${ORG_LABEL[org]} (${inOrg.length}건)*`);
    inOrg.sort((a, b) => URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency]);
    for (const e of inOrg) {
      const time = formatTime(e.receivedAt);
      const urgencyEmoji = URGENCY_LABEL[e.urgency].split(' ')[0];
      const subjectShort = e.subject.length > 80 ? e.subject.slice(0, 77) + '...' : e.subject;
      if (e.urgency === 'info') {
        // 정보성: 발신자 + 한 줄 요약만
        lines.push(`${urgencyEmoji} _${e.senderName}_ (${time}) — ${e.summary.split('\n')[0]}`);
      } else {
        lines.push(`${urgencyEmoji} *${subjectShort}* (${time}, ${e.senderName})`);
        lines.push(`   ${e.summary}`);
      }
    }
    lines.push('');
  }

  // 광고 — 마지막에 모음
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

  // 3. 주간보고 제외
  const filtered = parsed.filter(e => {
    if (WEEKLY_REPORT_PATTERN.test(e.subject)) {
      result.excludedWeeklyReports++;
      return false;
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

  // 4. 분류·요약 — Sonnet → Gemini fallback
  const classifyInputs: ClassifyInput[] = filtered.map((e, i) => ({
    index: i,
    subject: e.subject,
    from: e.sender,
    toCC: e.toCC,
    snippet: e.snippet,
    body: e.body,
  }));

  let classified: ClassifyOutput[] = [];
  try {
    classified = await classifyWithSonnet(classifyInputs);
  } catch (err: any) {
    console.warn(`[general-email-briefing] Sonnet 분류 실패 (${err?.message}) → Gemini fallback`);
    result.errors.push(`sonnet: ${err?.message || err}`);
    try {
      classified = await classifyWithGemini(classifyInputs);
    } catch (err2: any) {
      result.errors.push(`gemini: ${err2?.message || err2}`);
      console.error('[general-email-briefing] Gemini fallback도 실패 — 분류 없이 종료');
      // 두 모델 모두 실패 — 분류 없이 raw 목록만 슬랙 전송
      result.briefingMarkdown =
        `*📧 일반 이메일 브리핑 — ${formatKstDate(new Date())}*\n` +
        `_분류 모델 모두 실패. 메타 정보만 표시._\n\n` +
        filtered
          .slice(0, 50)
          .map(e => `- ${e.subject.slice(0, 80)} _(${e.senderName})_`)
          .join('\n');
      const slack = await postSlackAdminDm(result.briefingMarkdown);
      result.slackDmSent = slack.ok;
      if (!slack.ok && slack.error) result.errors.push(`slack: ${slack.error}`);
      return result;
    }
  }

  // 5. 분류 결과를 이메일에 매핑 (per-email 실패 → skip)
  const classMap = new Map(classified.map(c => [c.index, c]));
  const briefed: BriefedEmail[] = [];
  for (let i = 0; i < filtered.length; i++) {
    const c = classMap.get(i);
    if (!c) continue; // 분류 누락 — skip
    briefed.push({
      ...filtered[i],
      org: c.org,
      urgency: c.urgency,
      summary: c.summary,
    });
  }
  result.emailsBriefed = briefed.length;

  // 6. 마크다운 + Slack DM
  result.briefingMarkdown = buildMarkdown(briefed);
  const slack = await postSlackAdminDm(result.briefingMarkdown);
  result.slackDmSent = slack.ok;
  if (!slack.ok && slack.error) {
    result.errors.push(`slack: ${slack.error}`);
    console.warn(`[general-email-briefing] Slack DM 실패 — ${slack.error}. Markdown은 manual trigger 응답에 포함됨.`);
  }

  console.log(
    `[general-email-briefing] scanned=${result.emailsScanned} briefed=${result.emailsBriefed} ` +
      `excluded(weekly)=${result.excludedWeeklyReports} slack=${result.slackDmSent} errors=${result.errors.length}`,
  );
  return result;
}
