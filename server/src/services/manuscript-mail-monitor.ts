/**
 * Gmail 자동 감지 — 논문 제출/리젝/리비전/억셉 이메일을 자동 분류해서 노션 manuscript에 반영.
 *
 * 흐름:
 * 1. Gmail 검색 (저널 시스템 sender + manuscript 키워드)
 * 2. 각 이메일에서 manuscript ID 추출 (nn-2026-XXX, MTBIO-D-26-XXX 등)
 * 3. ManuscriptMailEvent 로그 (중복 처리 방지)
 * 4. 매칭되는 Manuscript row가 있으면 노션 property 자동 patch
 *    - 제출 → 단계="심사 중", 차례="저널", 제출일 갱신
 *    - 리젝 → 단계="대응 중", 차례="PI", 리젝 이력 추가, 시도 횟수 +1
 *    - 리비전 → 단계="대응 중", 차례="학생", 리비전 마감일 추출
 *    - 억셉 → 단계="억셉", 차례=null
 * 5. 매칭 안 되면 unmatched 큐로 → 사용자가 수동 매칭
 */
import { PrismaClient } from '@prisma/client';
import { google, type gmail_v1 } from 'googleapis';
import { env } from '../config/env.js';
import { encryptToken, decryptToken, isEncrypted } from '../utils/crypto.js';
import { patchManuscriptProperty } from './manuscript-sync.js';

type EventType = 'submitted' | 'decision' | 'reject' | 'revision_request' | 'accept';

const prisma = new PrismaClient();

// 논문 시스템 발신자 (다 cover)
const JOURNAL_SENDERS = [
  'onbehalfof@manuscriptcentral.com',  // ACS, Wiley
  'em@editorialmanager.com',            // Elsevier (Materials Today, Biomaterials, etc)
  'no-reply@atyponrex.com',             // Wiley submission system
  '@wiley.com',
  '@elsevier.com',
  '@aaas.org',
  '@nature.com',
  '@science.org',
  '@aip.org',
  '@iop.org',
  '@rsc.org',
  '@acs.org',
  'no-reply@submissions.elsevier.com',
];

// 추출 패턴: ID prefix → 저널
const ID_PATTERNS: Array<{ regex: RegExp; journal: string }> = [
  { regex: /\b(nn-\d{4}-\d{5}[a-z]?(?:\.R\d)?)\b/i, journal: 'ACS Nano' },
  { regex: /\b(am-\d{4}-\d{6}(?:\.R\d)?)\b/i, journal: 'ACS Applied Materials & Interfaces' },
  { regex: /\b(nl-\d{4}-\d{6}(?:\.R\d)?)\b/i, journal: 'Nano Letters' },
  { regex: /\b(MTBIO-D-\d{2}-\d{5})\b/i, journal: 'Materials Today Bio' },
  { regex: /\b(BIOACTMAT-D-\d{2}-\d{5})\b/i, journal: 'Bioactive Materials' },
  { regex: /\b(NANOTODAY-D-\d{2}-\d{5})\b/i, journal: 'Nano Today' },
  { regex: /\b(NCOMMS-\d{2}-\d{6})\b/i, journal: 'Nature Communications' },
  { regex: /\b(aeg\d{4})\b/i, journal: 'Science Advances' },
  { regex: /\b(jbmt\d+(?:R\d)?)\b/i, journal: 'Biomaterials' },
  { regex: /\b(TB-ART-\d{2}-\d{4}-\d{6})\b/i, journal: 'Journal of Materials Chemistry B' },
];

interface ManuscriptIdMatch {
  id: string;
  journal: string;
}

interface GmailMsg {
  id: string;
  threadId: string;
  subject: string;
  snippet: string;
  body: string;
  fromAddr: string;
  receivedAt: Date;
}

// ─────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────

function safeDecrypt(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  return isEncrypted(value) ? decryptToken(value) : value;
}

function extractManuscriptId(text: string): ManuscriptIdMatch | null {
  for (const { regex, journal } of ID_PATTERNS) {
    const m = text.match(regex);
    if (m) return { id: m[1], journal };
  }
  return null;
}

// 본인 논문이 아닌 메일 — review 요청, peer review 초청, 다른 lab 협업 알림 등
// 이런 메일은 같은 manuscript ID 패턴을 갖지만 PI가 1저자/교신/공저가 아닌 케이스 → 무시
function isReviewerCorrespondence(subject: string, snippet: string): boolean {
  const s = (subject + ' ' + snippet).toLowerCase();
  return /(invitation to (peer )?review|assigned to review|inviting you to review|kindly agreed to review|review (arrived|received) for|review for [^.]* (due|requested)|thank you for (the |your )?review|review (arrived|invitation)|reviewer (invitation|assigned)|review of nn-|review of [a-z]+-d-)/i.test(s);
}

// 이벤트 타입 분류 — subject + snippet + body 첫 부분
// 본인 논문임이 명확한 표현(your manuscript, decision on your, etc.)을 우선시.
function classifyEvent(subject: string, snippet: string): EventType | null {
  // Review 요청은 명시적으로 제외 — 본인 논문 추적과 무관
  if (isReviewerCorrespondence(subject, snippet)) return null;

  const s = (subject + ' ' + snippet).toLowerCase();

  // 억셉 — 본인 논문임이 명확한 키워드만
  if (/your manuscript has been accepted|i am pleased to accept|delighted to accept|congratulations.* manuscript .* accept/.test(s)) {
    return 'accept';
  }

  // 리비전 (reject보다 먼저)
  if (/revision of (your|the|")|revision .* is due|major revision|minor revision|please revise|revisions are required|^revision /.test(s)) {
    return 'revision_request';
  }

  // 제출 — 본인 키워드만
  if (/thank you for submitting your|your manuscript .* (has been )?successfully (been )?submitted|submission started for|submission received|manuscript .* assigned to editor|manuscript submitted to/.test(s)) {
    return 'submitted';
  }

  // 리젝 — Decision on (your/submission) 컨텍스트 + reject 키워드
  // 본인 키워드 ("decision on your", "decision on submission") 없이 단독 reject만 있으면 무시
  if (/decision on (your|submission|manuscript)/.test(s) || /^decision on/.test(s)) {
    if (/regret|reject|not (suitable|accept)|unable to (accept|publish)|decline to publish/.test(s)) return 'reject';
    return 'decision';  // 일반 decision (사용자 검토 필요)
  }

  return null;
}

// 리비전 due date 추출 (본문에서)
function extractRevisionDueDate(body: string): Date | null {
  // 패턴: "due by Mar 15, 2026" / "before 2026-04-15" / "30 days from"
  const m1 = body.match(/(?:due|deadline|by)\s+(?:on\s+)?([A-Z][a-z]+\s+\d{1,2}(?:,?\s+\d{4})?)/);
  if (m1) {
    const d = new Date(m1[1]);
    if (!isNaN(d.getTime())) return d;
  }
  const m2 = body.match(/(\d{4}-\d{2}-\d{2})/);
  if (m2) {
    const d = new Date(m2[1]);
    if (!isNaN(d.getTime())) return d;
  }
  // "X days" → 메일 받은 날 + X일
  const m3 = body.match(/(\d+)\s+days/);
  if (m3) return new Date(Date.now() + Number(m3[1]) * 86400000);
  return null;
}

/** 본문에서 논문 제목 추출 — ManuscriptCentral/Editorial Manager 표준 헤더 */
function extractTitleFromBody(body: string): string | null {
  // "Title: \"...\"" 또는 "TITLE: ..." 또는 "manuscript entitled \"...\""
  const m1 = body.match(/(?:^|\n)\s*Title:\s*"([^"\n]+)"/i);
  if (m1) return m1[1].trim();
  const m2 = body.match(/(?:^|\n)\s*Title:\s*([^\n]+)/i);
  if (m2) return m2[1].trim();
  const m3 = body.match(/manuscript entitled "([^"]+)"/i);
  if (m3) return m3[1].trim();
  const m4 = body.match(/manuscript[,:]?\s*"([^"\n]{10,})"/i);
  if (m4) return m4[1].trim();
  return null;
}

/** 마지막 처리한 메일 시각 — incremental 검색에 사용 (테이블에서 max(received_at) 조회) */
async function getLastProcessedAt(): Promise<Date | null> {
  const last = await prisma.manuscriptMailEvent.findFirst({
    orderBy: { receivedAt: 'desc' },
    select: { receivedAt: true },
  });
  return last?.receivedAt || null;
}

// ─────────────────────────────────────────────
// Step 1: fetchMessages
// ─────────────────────────────────────────────

/** OAuth client 구성 + 토큰 자동 갱신 hook */
async function buildGmailClient(userId: string): Promise<gmail_v1.Gmail | null> {
  const gmailToken = await prisma.gmailToken.findFirst({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
  if (!gmailToken) {
    console.warn('[mail-monitor] Gmail 토큰 없음 — userId:', userId);
    return null;
  }

  const oauth2Client = new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI,
  );
  oauth2Client.setCredentials({
    access_token: safeDecrypt(gmailToken.accessToken),
    refresh_token: safeDecrypt(gmailToken.refreshToken),
    expiry_date: gmailToken.expiresAt?.getTime(),
  });
  oauth2Client.on('tokens', async (tokens) => {
    try {
      await prisma.gmailToken.update({
        where: { id: gmailToken.id },
        data: {
          accessToken: encryptToken(tokens.access_token!),
          expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
          ...(tokens.refresh_token ? { refreshToken: encryptToken(tokens.refresh_token) } : {}),
        },
      });
    } catch (e) {
      const msg = (e as Error).message?.slice(0, 100) || 'unknown';
      console.error(`[mail-monitor] FAILED token refresh: ${msg}`);
    }
  });

  return google.gmail({ version: 'v1', auth: oauth2Client });
}

/** Gmail payload (단일/멀티파트)에서 text/plain 본문 추출 */
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

/** Gmail full message → GmailMsg */
function parseGmailMessage(data: gmail_v1.Schema$Message): GmailMsg {
  const headers = data.payload?.headers || [];
  const get = (name: string) => headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
  return {
    id: data.id!,
    threadId: data.threadId!,
    subject: get('Subject'),
    snippet: data.snippet || '',
    body: extractPlainBody(data.payload).slice(0, 5000),  // 본문 5KB 제한
    fromAddr: get('From'),
    receivedAt: new Date(Number(data.internalDate) || Date.now()),
  };
}

/** 검색 쿼리 — sinceDate 우선, 없으면 daysAgo fallback */
function buildSearchQuery(daysAgo: number, sinceDate: Date | null): string {
  const afterEpoch = sinceDate
    ? Math.floor(sinceDate.getTime() / 1000)
    : Math.floor((Date.now() - daysAgo * 86400000) / 1000);
  const senderQuery = JOURNAL_SENDERS.map(s => `from:${s}`).join(' OR ');
  const subjectKeywords = '(manuscript OR submission OR "decision on" OR revision OR rebuttal OR accepted)';
  return `after:${afterEpoch} (${senderQuery}) ${subjectKeywords} -from:me`;
}

async function fetchGmailMessages(
  userId: string,
  daysAgo: number = 90,
  sinceDate: Date | null = null,
): Promise<GmailMsg[]> {
  const gmail = await buildGmailClient(userId);
  if (!gmail) return [];

  // 검색 — 최대 5페이지 (500건)
  const q = buildSearchQuery(daysAgo, sinceDate);
  const allIds: Array<{ id: string }> = [];
  let pageToken: string | undefined;
  for (let p = 0; p < 5; p++) {
    const list = await gmail.users.messages.list({ userId: 'me', maxResults: 100, q, pageToken });
    allIds.push(...(list.data.messages || []).map(m => ({ id: m.id! })));
    pageToken = list.data.nextPageToken || undefined;
    if (!pageToken) break;
  }
  console.log(`[mail-monitor] Gmail 검색: ${allIds.length}개 메시지`);

  // 상세 (full body) 가져오기 — concurrency 5
  const result: GmailMsg[] = [];
  const concurrency = 5;
  for (let i = 0; i < allIds.length; i += concurrency) {
    const batch = allIds.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map(m =>
      gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' }),
    ));
    for (const r of settled) {
      if (r.status === 'fulfilled') result.push(parseGmailMessage(r.value.data));
    }
  }
  return result;
}

// ─────────────────────────────────────────────
// Step 2: classify + match
// ─────────────────────────────────────────────

interface Classified {
  msg: GmailMsg;
  eventType: EventType;
  idMatch: ManuscriptIdMatch | null;
  manuscriptId: string | null;
}

/** msg를 분류·매칭 — 알 수 없으면 null. 매칭 실패도 포함 (manuscriptId=null). */
async function classifyAndMatch(msg: GmailMsg): Promise<Classified | null> {
  const eventType = classifyEvent(msg.subject, msg.snippet);
  if (!eventType) return null;

  const fullText = msg.subject + '\n' + msg.snippet + '\n' + msg.body;
  const idMatch = extractManuscriptId(fullText);

  let manuscriptId: string | null = null;
  if (idMatch) {
    const baseId = idMatch.id.replace(/\.R\d+$/, '');
    const found = await prisma.manuscript.findFirst({
      where: {
        archived: false,
        OR: [{ manuscriptNum: idMatch.id }, { manuscriptNum: baseId }],
      },
      select: { id: true },
    });
    if (found) manuscriptId = found.id;
  }

  return { msg, eventType, idMatch, manuscriptId };
}

// ─────────────────────────────────────────────
// Step 3: applyToNotion + 이벤트 로그
// ─────────────────────────────────────────────

interface NotionPatchPlan {
  stage: string | null;
  whoseTurn: string | null;
  activityType: string;
  revisionDueAt: Date | null;
}

/** eventType별 stage/turn/activityLabel 결정 */
function planNotionPatch(eventType: EventType, idMatch: ManuscriptIdMatch | null, body: string): NotionPatchPlan {
  const journal = idMatch?.journal || '';
  switch (eventType) {
    case 'submitted':
      return { stage: '심사 중', whoseTurn: '저널', activityType: `${journal} 제출됨`, revisionDueAt: null };
    case 'reject':
      return { stage: '대응 중', whoseTurn: 'PI', activityType: `${journal} reject`, revisionDueAt: null };
    case 'revision_request':
      return { stage: '대응 중', whoseTurn: '학생', activityType: `${journal} 리비전 요청`, revisionDueAt: extractRevisionDueDate(body) };
    case 'accept':
      return { stage: '억셉', whoseTurn: null, activityType: `${journal} 억셉`, revisionDueAt: null };
    case 'decision':
      return { stage: null, whoseTurn: 'PI', activityType: `${journal} decision (검토 필요)`, revisionDueAt: null };
  }
}

/** Notion patch payload 빌드 */
async function buildNotionProps(
  manuscriptId: string,
  msg: GmailMsg,
  eventType: EventType,
  plan: NotionPatchPlan,
): Promise<Record<string, unknown>> {
  const props: Record<string, unknown> = {
    "마지막 활동": { date: { start: msg.receivedAt.toISOString().slice(0, 10) } },
    "마지막 활동 종류": { rich_text: [{ text: { content: plan.activityType.slice(0, 200) } }] },
  };

  // 메모에 추출된 제목 자동 보강 (이미 있으면 skip)
  const extractedTitle = extractTitleFromBody(msg.body);
  if (extractedTitle) {
    const ms = await prisma.manuscript.findUnique({
      where: { id: manuscriptId },
      select: { memo: true },
    });
    if (ms && (!ms.memo || !ms.memo.includes(extractedTitle))) {
      const newMemo = ms.memo ? `${ms.memo}\n\nTITLE: ${extractedTitle}` : `TITLE: ${extractedTitle}`;
      props["메모"] = { rich_text: [{ text: { content: newMemo.slice(0, 1900) } }] };
    }
  }

  if (plan.stage) props["단계"] = { select: { name: plan.stage } };
  if (plan.whoseTurn) props["차례"] = { select: { name: plan.whoseTurn } };

  if (eventType === 'submitted') {
    props["제출일"] = { date: { start: msg.receivedAt.toISOString().slice(0, 10) } };
  }
  if (plan.revisionDueAt) {
    props["리비전 마감"] = { date: { start: plan.revisionDueAt.toISOString().slice(0, 10) } };
  }

  return props;
}

/** 메일 한 통을 처리 — 추출/분류/매칭/노션 patch */
async function processOneMessage(msg: GmailMsg): Promise<{ matched: boolean; eventType: string | null }> {
  // 이미 처리된 메일?
  const existing = await prisma.manuscriptMailEvent.findUnique({
    where: { gmailMessageId: msg.id },
  });
  if (existing) return { matched: !!existing.manuscriptId, eventType: existing.eventType };

  const cls = await classifyAndMatch(msg);
  if (!cls) return { matched: false, eventType: null };

  const plan = planNotionPatch(cls.eventType, cls.idMatch, msg.body);

  // 이벤트 로그 저장 (idempotency: gmailMessageId unique)
  const evt = await prisma.manuscriptMailEvent.create({
    data: {
      gmailMessageId: msg.id,
      threadId: msg.threadId,
      manuscriptId: cls.manuscriptId,
      manuscriptNum: cls.idMatch?.id || null,
      eventType: cls.eventType,
      journal: cls.idMatch?.journal || null,
      subject: msg.subject.slice(0, 200),
      fromAddr: msg.fromAddr.slice(0, 100),
      receivedAt: msg.receivedAt,
      revisionDueAt: plan.revisionDueAt,
      rawSnippet: msg.snippet.slice(0, 500),
      applied: false,
    },
  });

  // 매칭됐으면 노션 patch
  if (cls.manuscriptId) {
    const props = await buildNotionProps(cls.manuscriptId, msg, cls.eventType, plan);
    const ok = await patchManuscriptProperty(cls.manuscriptId, props);
    if (ok) {
      await prisma.manuscriptMailEvent.update({
        where: { id: evt.id },
        data: { applied: true },
      });
    }
  }

  return { matched: !!cls.manuscriptId, eventType: cls.eventType };
}

// ─────────────────────────────────────────────
// 메인 monitor
// ─────────────────────────────────────────────

/** 메인 monitor — userId의 Gmail에서 마지막 처리 시점 이후 메일만 처리 (incremental).
 *  daysAgo 명시 시 그 기간 풀스캔 (수동 [Gmail] 버튼 / 첫 백필 용). */
export async function monitorManuscriptMail(opts: { userId: string; daysAgo?: number; force?: boolean } = { userId: '' }):
  Promise<{ scanned: number; matched: number; unmatched: number; events: Record<string, number> }> {
  const t0 = Date.now();
  console.log('[mail-monitor] 시작');

  const userId = opts.userId || (await prisma.user.findFirst({ where: { email: 'jungmok.seo@gmail.com' } }))?.id;
  if (!userId) {
    console.warn('[mail-monitor] userId 없음');
    return { scanned: 0, matched: 0, unmatched: 0, events: {} };
  }

  // incremental — 마지막 처리한 receivedAt 이후 메일만. 수동 트리거(daysAgo 명시)는 풀스캔.
  let sinceDate: Date | null = null;
  if (!opts.daysAgo) {
    sinceDate = await getLastProcessedAt();
    // 1시간 백트래킹 — 동시 도착 메일 누락 방지
    if (sinceDate) sinceDate = new Date(sinceDate.getTime() - 60 * 60 * 1000);
  }
  const messages = await fetchGmailMessages(userId, opts.daysAgo ?? 30, sinceDate);
  if (sinceDate) {
    console.log(`[mail-monitor] incremental: ${sinceDate.toISOString()} 이후 ${messages.length}건`);
  }

  let scanned = 0, matched = 0, unmatched = 0;
  const events: Record<string, number> = {};
  for (const msg of messages) {
    try {
      const r = await processOneMessage(msg);
      scanned++;
      if (r.eventType) {
        events[r.eventType] = (events[r.eventType] || 0) + 1;
        if (r.matched) matched++;
        else unmatched++;
      }
    } catch (e) {
      const errMsg = (e as Error).message?.slice(0, 100) || 'unknown';
      console.warn(`[mail-monitor] FAILED ${msg.id}: ${errMsg}`);
    }
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`[mail-monitor] 완료: 스캔 ${scanned}, 매칭 ${matched}, 미매칭 ${unmatched}, 이벤트 ${JSON.stringify(events)}, ${elapsed}s`);
  return { scanned, matched, unmatched, events };
}

/** 미매칭 이벤트 목록 — UI에서 사용자가 수동 매칭 */
export async function getUnmatchedEvents() {
  return prisma.manuscriptMailEvent.findMany({
    where: { manuscriptId: null, applied: false },
    orderBy: { receivedAt: 'desc' },
    take: 50,
  });
}

/** 미매칭 이벤트를 manuscript에 수동 매칭 */
export async function linkUnmatchedEvent(eventId: string, manuscriptId: string) {
  await prisma.manuscriptMailEvent.update({
    where: { id: eventId },
    data: { manuscriptId },
  });
  // 자동 적용은 사용자가 별도로 트리거. (또는 cron이 다음에 처리)
  return { ok: true };
}
