/**
 * Gmail 자동 감지 — 논문 제출/리젝/리비전/억셉 이메일을 자동 분류해서 노션 manuscript에 반영.
 *
 * 흐름:
 * 1. Gmail 검색 (저널 시스템 sender + manuscript 키워드) + 수동 전달(Fwd) 메일 별도 검색
 * 2. 각 이메일에서 manuscript ID·저널·제목 추출
 * 3. ManuscriptMailEvent 로그 (중복 처리 방지)
 * 4. 매칭 (manuscriptNum → 제목/메모 유사도 → 저널 단독 후보) → 노션 property 자동 patch
 *    - 제출 → 단계="심사 중", 차례="저널", 제출일 갱신
 *    - 리젝 → 단계="대응 중", 차례="PI"
 *    - 리비전 → 단계="대응 중", 차례="학생", 리비전 마감일 추출
 *    - 억셉 → 단계="억셉", 차례=null
 *    매칭 성공 + manuscriptNum 미기록이면 DB·Notion("Manuscript ID")에 backfill → 이후 ID 매칭 가능
 * 5. 매칭 안 되면 unmatched 큐로 → 사용자가 수동 매칭 (linkUnmatchedEvent가 Notion patch까지 수행)
 * 6. 스캔 후 기존 unmatched 이벤트 자동 재처리 (재분류·재매칭 — 코드 개선 소급 적용)
 *
 * 2026-07-11 재설계 배경 (production 12건 전수 미매칭 + 오분류):
 *  - Decision 메일 snippet이 "Thank you for submitting…"으로 시작 → submitted 오분류 → subject 우선 판정으로 교체
 *  - HTML-only 메일 body 추출 실패 → ID/마감일 추출 불가 → text/html fallback 추가
 *  - journal이 ID 패턴에서만 유도 → 발신자 표시명·subject에서도 유도
 *  - Wiley 숫자 ID(1742938)·Editorial Manager generic(MSR-D-26-…)·ScholarOne(BUTR-2026-166) 패턴 부재 → 추가
 *  - Manuscript.manuscriptNum이 노션에 거의 비어 있어 ID 매칭 전멸 → 제목/메모/저널 fallback + backfill
 *  - 사용자가 수동 전달한 메일은 -from:me / 저널 발신자 필터에 걸려 스캔 제외 → Fwd 전용 검색 추가
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
  'onbehalfof@manuscriptcentral.com',  // ACS, Wiley (ScholarOne)
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
  '@springernature.com',
  '@biomedcentral.com',
  '@mdpi.com',
  '@frontiersin.org',
];

// ── ID 추출 패턴 ──────────────────────────────────────
// specific: 저널명 확정 가능. generic: ID만 추출 (저널은 deriveJournal이 별도 유도).
// generic은 오탐 방지를 위해 subject+snippet에서만 적용.
const ID_PATTERNS_SPECIFIC: Array<{ regex: RegExp; journal: string }> = [
  { regex: /\b(nn-\d{4}-\d{5}[a-z]?(?:\.R\d+)?)\b/i, journal: 'ACS Nano' },
  { regex: /\b(am-\d{4}-\d{6}(?:\.R\d+)?)\b/i, journal: 'ACS Applied Materials & Interfaces' },
  { regex: /\b(nl-\d{4}-\d{6}(?:\.R\d+)?)\b/i, journal: 'Nano Letters' },
  { regex: /\b(MTBIO-D-\d{2}-\d{5}(?:R\d+)?)\b/i, journal: 'Materials Today Bio' },
  { regex: /\b(BIOACTMAT-D-\d{2}-\d{5}(?:R\d+)?)\b/i, journal: 'Bioactive Materials' },
  { regex: /\b(NANOTODAY-D-\d{2}-\d{5}(?:R\d+)?)\b/i, journal: 'Nano Today' },
  { regex: /\b(NCOMMS-\d{2}-\d{6}(?:[A-Z])?)\b/i, journal: 'Nature Communications' },
  { regex: /\b(aeg\d{4})\b/i, journal: 'Science Advances' },
  { regex: /\b(jbmt\d+(?:R\d+)?)\b/i, journal: 'Biomaterials' },
  { regex: /\b(TB-ART-\d{2}-\d{4}-\d{6}(?:\.R\d+)?)\b/i, journal: 'Journal of Materials Chemistry B' },
];

const ID_PATTERNS_GENERIC: RegExp[] = [
  /\b([A-Z]{2,12}-D-\d{2}-\d{4,6}(?:R\d+)?)\b/,          // Editorial Manager 공통 (MSR-D-26-xxxxx 등)
  /\b([A-Z]{2}-[A-Z]{3}-\d{2}-\d{4}-\d{6}(?:\.R\d+)?)\b/, // RSC 스타일 (CC-COM-05-2026-003249)
  /\b([A-Z]{3,10}-\d{4}-\d{3,5}(?:\.R\d+)?)\b/,          // ScholarOne 공통 (BUTR-2026-166)
];

// Wiley 숫자 ID — subject에서만 ("accepted for publication: 1742938", "Decision on manuscript: 8206616")
const WILEY_NUMERIC_SUBJECT = /(?:manuscript|publication|submission)\s*[:#]?\s*(\d{6,8})\b/i;

interface ManuscriptIdMatch {
  id: string;
  journal: string | null;
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

/** Fwd:/FW:/Re: prefix 제거한 subject */
function stripSubjectPrefixes(subject: string): string {
  return subject.replace(/^(\s*(fwd?|re|회신|전달)\s*:\s*)+/i, '').trim();
}

/** 수동 전달 메일이면 body의 "From: …" 라인에서 원 발신자 추출 */
function extractOriginalFrom(body: string): string | null {
  const m = body.match(/^\s*(?:>+\s*)?From:\s*(.+)$/im);
  return m ? m[1].trim().slice(0, 150) : null;
}

function extractManuscriptId(subject: string, snippet: string, body: string): ManuscriptIdMatch | null {
  const fullText = subject + '\n' + snippet + '\n' + body;
  for (const { regex, journal } of ID_PATTERNS_SPECIFIC) {
    const m = fullText.match(regex);
    if (m) return { id: m[1], journal };
  }
  // generic — 오탐 방지 위해 subject+snippet 한정
  const shortText = subject + '\n' + snippet;
  for (const regex of ID_PATTERNS_GENERIC) {
    const m = shortText.match(regex);
    if (m) return { id: m[1], journal: null };
  }
  const wiley = subject.match(WILEY_NUMERIC_SUBJECT);
  if (wiley) return { id: wiley[1], journal: null };
  return null;
}

// 알려진 저널 키워드 — From 표시명이 사람 이름인지 저널명인지 구분용
const JOURNAL_NAME_HINT = /nature|science|materials|nano|advanced|acs|journal|letters|communications|small|bio|chem|physics|energy|electron|sensor|robot|matter|cell|lancet|wiley|elsevier|springer/i;

/** 저널명 유도 — ID 패턴 → subject 패턴 → From 표시명 순 */
function deriveJournal(msg: GmailMsg, idMatch: ManuscriptIdMatch | null): string | null {
  if (idMatch?.journal) return idMatch.journal;

  const subject = stripSubjectPrefixes(msg.subject);
  // "submitted to X" / "Decision on submission to X" / "Your submission to X"
  // 저널명 첫 글자 소문자 허용 (npj Flexible Electronics, eLife, mBio 등)
  const m1 = subject.match(/(?:submitted to|submission to|decision on submission to|your submission to)\s+([A-Za-z][A-Za-z&\-.\s]{2,60})/);
  if (m1) {
    const j = m1[1].replace(/\s*[-–—:|].*$/, '').trim();
    if (j.length >= 3) return j;
  }

  // From 표시명: "Advanced Functional Materials <afm@wiley.com>" — 저널 키워드 있을 때만 (사람 이름 배제)
  const display = msg.fromAddr.split('<')[0].replace(/["']/g, '').trim();
  if (display && !display.includes('@') && JOURNAL_NAME_HINT.test(display) &&
      !/no-?reply|editorial office|on behalf|via /i.test(display)) {
    return display.slice(0, 80);
  }
  return null;
}

// ── 리뷰어 메일 필터 (본인 논문 아님 — 파이프라인 제외) ──
// 주의: decision letter 본문의 "reviewers' comments"류와 혼동하지 말 것 — 모호한 단서는 subject에서만.
function isReviewerCorrespondence(subject: string, snippet: string, body: string): boolean {
  const subj = stripSubjectPrefixes(subject).toLowerCase();
  // subject 단서 — subject에 있으면 확실
  if (/your review|review invitation|review reminder|invitation to review|review request|review of [a-z]/i.test(subj)) return true;
  // 본문 단서 — 명확한 것만
  const all = (subject + ' ' + snippet + ' ' + body.slice(0, 1500)).toLowerCase();
  return /dear reviewer|thank you for (providing|completing) (the |your )?review|thank you for agreeing to review|invitation to (peer )?review|inviting you to review|kindly agreed to review|assigned to review|as a reviewer for/.test(all);
}

/**
 * 이벤트 타입 분류 — subject 우선 판정.
 * 핵심: decision 메일 snippet은 "Thank you for submitting your manuscript…We regret…"으로 시작하는 경우가
 * 대부분이라, snippet 기반 판정은 'submitted' 오분류를 낳는다 (production 12건 중 3건 실제 발생).
 * subject가 결정 통보('decision')면 snippet의 제출 감사 문구를 무시하고 decision 계열로 확정.
 */
function classifyEvent(subject: string, snippet: string, body: string): EventType | null {
  if (isReviewerCorrespondence(subject, snippet, body)) return null;

  // 게재 확정 후 행정 메일(저작권 양식·출판 계약·OA 비용 청구·교정쇄 안내)은 결정 신호가 아님.
  // 실제 accept 메일은 별도로 도착하므로 무시해도 손실 없음(2026-07-13: MTBIO_103405 폼 메일 오분류 대응).
  if (/rights and access form|publishing agreement (completed|for)|licen[sc]e to publish|article publication charge|open access[^.]{0,30}(charge|invoice|payment)/i.test(subject)) {
    return null;
  }

  const subj = stripSubjectPrefixes(subject).toLowerCase();
  const all = (subj + ' ' + snippet + ' ' + body.slice(0, 3000)).toLowerCase();

  // 1) accept — subject 최우선
  if (/accepted for publication|has been accepted/.test(subj)) return 'accept';

  // 2) decision 계열 — subject 판정이 snippet 오염보다 우선
  if (/\bdecision\b/.test(subj)) {
    if (/regret|reject|not suitable|not be (accepted|published)|unable to (accept|publish)|decline to publish|cannot (be )?accept/.test(all)) return 'reject';
    if (/major revision|minor revision|revise and resubmit|invited to (submit|provide) a revis|revisions? (is|are) (invited|required|requested)/.test(all)) return 'revision_request';
    if (/has been accepted|pleased to accept|delighted to accept/.test(all)) return 'accept';
    return 'decision';  // 결정 내용 불명 — 사용자 검토 필요
  }

  // 3) accept — 본문 기반
  if (/your (manuscript|paper|article) has been accepted|pleased to accept|delighted to accept|(manuscript|paper|article)[^.]{0,60}accepted for publication/.test(all)) {
    return 'accept';
  }

  // 4) revision
  if (/revision of (your|the|")|revision[^.]{0,40} is due|major revision|minor revision|please revise|revisions are required|revise and resubmit/.test(all)) {
    return 'revision_request';
  }

  // 5) reject — subject에 decision 없어도 본문에 명확
  if (/we regret to inform you[^.]{0,100}(manuscript|submission|paper)/.test(all) &&
      /reject|not be published|cannot be accepted|not suitable/.test(all)) {
    return 'reject';
  }

  // 6) submitted — subject 우선, 그다음 본문
  if (/(manuscript|submission) (submitted|received)|receipt of (your )?(open access )?submission|successfully submitted|submission confirmation/.test(subj)) {
    return 'submitted';
  }
  if (/thank you for submitting your (manuscript|paper|work|article)|your (manuscript|submission)[^.]{0,60}successfully (been )?submitted|submission started for|manuscript[^.]{0,60}assigned to (an )?editor/.test(all)) {
    return 'submitted';
  }

  return null;
}

// 리비전 due date 추출 (본문에서)
function extractRevisionDueDate(body: string): Date | null {
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
  const m3 = body.match(/(\d+)\s+days/);
  if (m3) return new Date(Date.now() + Number(m3[1]) * 86400000);
  return null;
}

/** 본문에서 논문 제목 추출 — ManuscriptCentral/Editorial Manager 표준 헤더 */
function extractTitleFromBody(body: string, subject: string): string | null {
  const m1 = body.match(/(?:^|\n)\s*(?:Full )?Title:\s*"([^"\n]+)"/i);
  if (m1) return m1[1].trim();
  const m2 = body.match(/(?:^|\n)\s*(?:Full )?Title:\s*([^\n]{10,})/i);
  if (m2) return m2[1].trim();
  const m3 = body.match(/manuscript (?:entitled|titled)\s*[,:]?\s*"([^"]{10,})"/i);
  if (m3) return m3[1].trim();
  const m4 = body.match(/(?:your|the) (?:manuscript|submission|paper|article)[,:]?\s*"([^"\n]{10,})"/i);
  if (m4) return m4[1].trim();
  // subject 안 따옴표 제목: Revision of "..." is due soon
  const m5 = subject.match(/"([^"]{15,})"/);
  if (m5) return m5[1].trim();
  return null;
}

/** 마지막 처리한 메일 시각 — incremental 검색에 사용 */
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
  let gmailToken = await prisma.gmailToken.findFirst({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
  if (!gmailToken) {
    // 웹 세션 userId ≠ GmailToken.userId 케이스 방어 (단일 PI 앱) —
    // 이전엔 여기서 null 반환 → 수동 [Gmail] 스캔이 조용히 0건으로 끝났음.
    gmailToken = await prisma.gmailToken.findFirst({
      where: { email: 'jungmok.seo@gmail.com', refreshToken: { not: null } },
      orderBy: [{ primary: 'desc' }, { updatedAt: 'desc' }],
    });
    if (gmailToken) {
      console.warn(`[mail-monitor] userId(${userId}) 토큰 없음 → PI 기본 토큰(${gmailToken.email}) fallback`);
    }
  }
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

/** HTML → 텍스트 (태그 strip + 엔티티 최소 해석) */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n');
}

/**
 * Gmail payload에서 본문 추출 — text/plain 우선, 없으면 text/html을 텍스트화.
 * (Editorial Manager/ScholarOne 메일 상당수가 HTML-only — 이전엔 body=''로 ID/마감일 추출 전멸)
 */
function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return '';

  let html = '';
  const walk = (part: gmail_v1.Schema$MessagePart): string => {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      return Buffer.from(part.body.data, 'base64').toString('utf-8');
    }
    if (part.mimeType === 'text/html' && part.body?.data && !html) {
      html = Buffer.from(part.body.data, 'base64').toString('utf-8');
    }
    for (const p of part.parts || []) {
      const r = walk(p);
      if (r) return r;
    }
    return '';
  };

  // top-level 단일 파트 (mimeType이 text/plain 또는 text/html)
  if (payload.body?.data && !payload.parts?.length) {
    const raw = Buffer.from(payload.body.data, 'base64').toString('utf-8');
    return payload.mimeType === 'text/html' ? htmlToText(raw) : raw;
  }

  const plain = walk(payload);
  if (plain) return plain;
  if (html) return htmlToText(html);
  return '';
}

/** Gmail full message → GmailMsg. Fwd 메일이면 subject prefix 제거 + 원 발신자 복원. */
function parseGmailMessage(data: gmail_v1.Schema$Message): GmailMsg {
  const headers = data.payload?.headers || [];
  const get = (name: string) => headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
  const rawSubject = get('Subject');
  const body = extractBody(data.payload).slice(0, 8000);
  let fromAddr = get('From');
  let subject = rawSubject;

  // 수동 전달 메일 — 원래 발신자·제목으로 정규화 (분류·저널 유도가 원본 기준으로 동작)
  if (/^\s*(fwd?|전달)\s*:/i.test(rawSubject)) {
    subject = stripSubjectPrefixes(rawSubject);
    const origFrom = extractOriginalFrom(body);
    if (origFrom) fromAddr = origFrom;
  }

  return {
    id: data.id!,
    threadId: data.threadId!,
    subject,
    snippet: data.snippet || '',
    body,
    fromAddr,
    receivedAt: new Date(Number(data.internalDate) || Date.now()),
  };
}

const SUBJECT_KEYWORDS = '(manuscript OR submission OR "decision on" OR revision OR rebuttal OR accepted)';

/** 검색 쿼리 — sinceDate 우선, 없으면 daysAgo fallback */
function buildSearchQuery(daysAgo: number, sinceDate: Date | null): string {
  const afterEpoch = sinceDate
    ? Math.floor(sinceDate.getTime() / 1000)
    : Math.floor((Date.now() - daysAgo * 86400000) / 1000);
  const senderQuery = JOURNAL_SENDERS.map(s => `from:${s}`).join(' OR ');
  return `after:${afterEpoch} (${senderQuery}) ${SUBJECT_KEYWORDS} -from:me`;
}

/** 수동 전달(Fwd) 메일 검색 쿼리 — 사용자가 저널 메일을 직접 전달해 넣는 워크플로우 지원 */
function buildForwardedQuery(daysAgo: number, sinceDate: Date | null): string {
  const afterEpoch = sinceDate
    ? Math.floor(sinceDate.getTime() / 1000)
    : Math.floor((Date.now() - daysAgo * 86400000) / 1000);
  return `after:${afterEpoch} subject:(fwd OR fw) ${SUBJECT_KEYWORDS}`;
}

async function listMessageIds(gmail: gmail_v1.Gmail, q: string, maxPages = 5): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  for (let p = 0; p < maxPages; p++) {
    const list = await gmail.users.messages.list({ userId: 'me', maxResults: 100, q, pageToken });
    ids.push(...(list.data.messages || []).map(m => m.id!));
    pageToken = list.data.nextPageToken || undefined;
    if (!pageToken) break;
  }
  return ids;
}

async function fetchGmailMessages(
  userId: string,
  daysAgo: number = 90,
  sinceDate: Date | null = null,
): Promise<GmailMsg[]> {
  const gmail = await buildGmailClient(userId);
  if (!gmail) return [];

  // 저널 발신 + 수동 전달 두 쿼리 (중복 ID는 Set으로 제거)
  const [journalIds, fwdIds] = await Promise.all([
    listMessageIds(gmail, buildSearchQuery(daysAgo, sinceDate)),
    listMessageIds(gmail, buildForwardedQuery(daysAgo, sinceDate), 2),
  ]);
  const allIds = [...new Set([...journalIds, ...fwdIds])];
  console.log(`[mail-monitor] Gmail 검색: 저널 ${journalIds.length} + Fwd ${fwdIds.length} → ${allIds.length}개`);

  const result: GmailMsg[] = [];
  const concurrency = 5;
  for (let i = 0; i < allIds.length; i += concurrency) {
    const batch = allIds.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map(id =>
      gmail.users.messages.get({ userId: 'me', id, format: 'full' }),
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
  journal: string | null;
  extractedTitle: string | null;
  manuscriptId: string | null;
}

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9가-힣]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 저널명 정규화 — "&"↔"and", 구두점·콜론 제거. "Materials Science & Engineering R"과
 *  "Materials Science and Engineering: R"이 같게 취급되도록(2026-07-13 MSR 매칭 갭 대응). */
function normalizeJournal(j: string): string {
  return j.toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Manuscript 매칭 — 3단계 fallback:
 *  1. manuscriptNum 정확/기저(baseId) 일치
 *  2. 추출 제목 ↔ Manuscript.title/memo 유사도 (정규화 포함관계 또는 토큰 overlap ≥ 0.75)
 *  3. 저널명 단독 — 해당 저널로 활성(심사 중/대응 중) manuscript가 정확히 1건일 때만
 */
async function matchManuscript(
  idMatch: ManuscriptIdMatch | null,
  extractedTitle: string | null,
  journal: string | null,
): Promise<string | null> {
  // 1) manuscriptNum
  if (idMatch) {
    const baseId = idMatch.id.replace(/[.]?R\d+$/i, '');
    const found = await prisma.manuscript.findFirst({
      where: {
        archived: false,
        OR: [
          { manuscriptNum: { equals: idMatch.id, mode: 'insensitive' } },
          { manuscriptNum: { equals: baseId, mode: 'insensitive' } },
          { manuscriptNum: { contains: baseId, mode: 'insensitive' } },
        ],
      },
      select: { id: true },
    });
    if (found) return found.id;
  }

  const candidates = await prisma.manuscript.findMany({
    where: { archived: false },
    select: { id: true, title: true, memo: true, currentJournal: true, stage: true },
  });

  // 2) 제목 유사도 (title + memo의 "TITLE: …" 축적분)
  if (extractedTitle) {
    const nt = normalizeTitle(extractedTitle);
    if (nt.length >= 15) {
      for (const c of candidates) {
        const ct = normalizeTitle(c.title || '');
        const cm = normalizeTitle(c.memo || '');
        if ((ct.length >= 10 && (ct.includes(nt) || nt.includes(ct))) ||
            (cm.length >= 15 && cm.includes(nt))) {
          return c.id;
        }
      }
      // 토큰 overlap (min-size 분모) — 부분 표현 차이 흡수
      const ntTokens = new Set(nt.split(' ').filter(w => w.length > 2));
      if (ntTokens.size >= 4) {
        let best: string | null = null;
        let bestScore = 0;
        for (const c of candidates) {
          const ctTokens = new Set(normalizeTitle(c.title || '').split(' ').filter(w => w.length > 2));
          if (ctTokens.size < 3) continue;
          const inter = [...ntTokens].filter(w => ctTokens.has(w)).length;
          const score = inter / Math.min(ntTokens.size, ctTokens.size);
          if (score > bestScore) { bestScore = score; best = c.id; }
        }
        if (bestScore >= 0.75) return best;
      }
    }
  }

  // 3) 저널 단독 — 유일 활성 후보일 때만 (오매칭이 미매칭보다 나쁘므로 보수적)
  if (journal) {
    const nj = normalizeJournal(journal);
    if (nj.length >= 6) {
      const active = candidates.filter(c => {
        if (c.stage !== '심사 중' && c.stage !== '대응 중') return false;
        const cj = normalizeJournal(c.currentJournal || '');
        if (cj.length < 6) return false;
        // 정규화 후 양방향 포함관계 — "…engineering r" ⊆/⊇ "…engineering r"
        return cj.includes(nj) || nj.includes(cj);
      });
      if (active.length === 1) return active[0].id;
    }
  }

  return null;
}

/** 매칭 성공 시 manuscriptNum backfill — DB + Notion("Manuscript ID") 동시 (sync가 덮어쓰지 않게) */
async function backfillManuscriptNum(manuscriptId: string, idMatch: ManuscriptIdMatch | null): Promise<void> {
  if (!idMatch) return;
  try {
    const ms = await prisma.manuscript.findUnique({
      where: { id: manuscriptId },
      select: { manuscriptNum: true },
    });
    if (!ms || (ms.manuscriptNum && ms.manuscriptNum.trim())) return;
    const baseId = idMatch.id.replace(/[.]?R\d+$/i, '');
    await prisma.manuscript.update({ where: { id: manuscriptId }, data: { manuscriptNum: baseId } });
    await patchManuscriptProperty(manuscriptId, {
      'Manuscript ID': { rich_text: [{ text: { content: baseId } }] },
    });
    console.log(`[mail-monitor] manuscriptNum backfill: ${manuscriptId} ← ${baseId}`);
  } catch (e) {
    console.warn(`[mail-monitor] backfill 실패: ${(e as Error).message?.slice(0, 80)}`);
  }
}

/** msg를 분류·매칭 — 알 수 없으면 null. 매칭 실패도 포함 (manuscriptId=null). */
async function classifyAndMatch(msg: GmailMsg): Promise<Classified | null> {
  const eventType = classifyEvent(msg.subject, msg.snippet, msg.body);
  if (!eventType) return null;

  const idMatch = extractManuscriptId(msg.subject, msg.snippet, msg.body);
  const journal = deriveJournal(msg, idMatch);
  const extractedTitle = extractTitleFromBody(msg.body, msg.subject);
  const manuscriptId = await matchManuscript(idMatch, extractedTitle, journal);

  return { msg, eventType, idMatch, journal, extractedTitle, manuscriptId };
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
function planNotionPatch(eventType: EventType, journal: string | null, body: string): NotionPatchPlan {
  const j = journal || '';
  switch (eventType) {
    case 'submitted':
      return { stage: '심사 중', whoseTurn: '저널', activityType: `${j} 제출됨`.trim(), revisionDueAt: null };
    case 'reject':
      return { stage: '대응 중', whoseTurn: 'PI', activityType: `${j} reject`.trim(), revisionDueAt: null };
    case 'revision_request':
      return { stage: '대응 중', whoseTurn: '학생', activityType: `${j} 리비전 요청`.trim(), revisionDueAt: extractRevisionDueDate(body) };
    case 'accept':
      return { stage: '억셉', whoseTurn: null, activityType: `${j} 억셉`.trim(), revisionDueAt: null };
    case 'decision':
      return { stage: null, whoseTurn: 'PI', activityType: `${j} decision (검토 필요)`.trim(), revisionDueAt: null };
  }
}

/** Notion patch payload 빌드 */
async function buildNotionProps(
  manuscriptId: string,
  msg: GmailMsg,
  eventType: EventType,
  plan: NotionPatchPlan,
  extractedTitle: string | null,
): Promise<Record<string, unknown>> {
  const props: Record<string, unknown> = {
    '마지막 활동': { date: { start: msg.receivedAt.toISOString().slice(0, 10) } },
    '마지막 활동 종류': { rich_text: [{ text: { content: plan.activityType.slice(0, 200) } }] },
  };

  // 메모에 추출된 제목 자동 보강 (이미 있으면 skip) — 이후 제목 매칭 정확도 향상에도 사용됨
  if (extractedTitle) {
    const ms = await prisma.manuscript.findUnique({
      where: { id: manuscriptId },
      select: { memo: true },
    });
    if (ms && (!ms.memo || !ms.memo.includes(extractedTitle))) {
      const newMemo = ms.memo ? `${ms.memo}\n\nTITLE: ${extractedTitle}` : `TITLE: ${extractedTitle}`;
      props['메모'] = { rich_text: [{ text: { content: newMemo.slice(0, 1900) } }] };
    }
  }

  if (plan.stage) props['단계'] = { select: { name: plan.stage } };
  if (plan.whoseTurn) props['차례'] = { select: { name: plan.whoseTurn } };

  if (eventType === 'submitted') {
    props['제출일'] = { date: { start: msg.receivedAt.toISOString().slice(0, 10) } };
  }
  if (plan.revisionDueAt) {
    props['리비전 마감'] = { date: { start: plan.revisionDueAt.toISOString().slice(0, 10) } };
  }

  return props;
}

/** 매칭된 이벤트에 Notion patch 적용 (+backfill). 성공 시 applied=true. */
async function applyMatchedEvent(
  evtId: string,
  manuscriptId: string,
  msg: GmailMsg,
  eventType: EventType,
  plan: NotionPatchPlan,
  idMatch: ManuscriptIdMatch | null,
  extractedTitle: string | null,
): Promise<boolean> {
  const props = await buildNotionProps(manuscriptId, msg, eventType, plan, extractedTitle);
  const ok = await patchManuscriptProperty(manuscriptId, props);
  if (ok) {
    await prisma.manuscriptMailEvent.update({
      where: { id: evtId },
      data: { applied: true },
    });
    await backfillManuscriptNum(manuscriptId, idMatch);
  }
  return ok;
}

/** 메일 한 통을 처리 — 추출/분류/매칭/노션 patch */
async function processOneMessage(msg: GmailMsg): Promise<{ matched: boolean; eventType: string | null }> {
  const existing = await prisma.manuscriptMailEvent.findUnique({
    where: { gmailMessageId: msg.id },
  });
  if (existing) return { matched: !!existing.manuscriptId, eventType: existing.eventType };

  const cls = await classifyAndMatch(msg);
  if (!cls) return { matched: false, eventType: null };

  const plan = planNotionPatch(cls.eventType, cls.journal, msg.body);

  const evt = await prisma.manuscriptMailEvent.create({
    data: {
      gmailMessageId: msg.id,
      threadId: msg.threadId,
      manuscriptId: cls.manuscriptId,
      manuscriptNum: cls.idMatch?.id || null,
      eventType: cls.eventType,
      journal: cls.journal,
      subject: msg.subject.slice(0, 200),
      fromAddr: msg.fromAddr.slice(0, 100),
      receivedAt: msg.receivedAt,
      revisionDueAt: plan.revisionDueAt,
      rawSnippet: msg.snippet.slice(0, 500),
      applied: false,
    },
  });

  if (cls.manuscriptId) {
    await applyMatchedEvent(evt.id, cls.manuscriptId, msg, cls.eventType, plan, cls.idMatch, cls.extractedTitle);
  }

  return { matched: !!cls.manuscriptId, eventType: cls.eventType };
}

// ─────────────────────────────────────────────
// 미매칭 이벤트 재처리 — 분류/매칭 로직 개선을 과거 이벤트에 소급 적용
// ─────────────────────────────────────────────

/**
 * unmatched(manuscriptId=null, applied=false) 이벤트를 Gmail에서 원문 재조회 후 재분류·재매칭.
 *  - 리뷰어 메일로 판명 → eventType='ignored' 마킹 (unmatched 목록에서 제거, 재스캔 재생성 방지)
 *  - 재매칭 성공 → Notion patch + applied=true + backfill
 *  - 분류/저널/ID가 개선되면 이벤트 row 갱신 (사용자 수동 매칭 UI 품질 향상)
 */
export async function reprocessUnmatchedEvents(userId: string): Promise<{
  scanned: number; relinked: number; reclassified: number; ignored: number; reapplied: number;
}> {
  const zero = { scanned: 0, relinked: 0, reclassified: 0, ignored: 0, reapplied: 0 };
  const events = await prisma.manuscriptMailEvent.findMany({
    where: { manuscriptId: null, applied: false, eventType: { not: 'ignored' } },
    orderBy: { receivedAt: 'desc' },
    take: 60,
  });

  // 매칭됐지만 Notion 반영이 실패했던 이벤트 재시도 (patch 일시 실패 — rate limit 등)
  const linkedUnapplied = await prisma.manuscriptMailEvent.findMany({
    where: { manuscriptId: { not: null }, applied: false, eventType: { not: 'ignored' } },
    orderBy: { receivedAt: 'desc' },
    take: 20,
  });

  if (events.length === 0 && linkedUnapplied.length === 0) return zero;

  const gmail = await buildGmailClient(userId);
  if (!gmail) return zero;

  const result0 = { ...zero };
  for (const evt of linkedUnapplied) {
    try {
      const data = await gmail.users.messages.get({ userId: 'me', id: evt.gmailMessageId, format: 'full' }).catch(() => null);
      if (!data || !evt.manuscriptId) continue;
      const msg = parseGmailMessage(data.data);
      const eventType = (['submitted', 'decision', 'reject', 'revision_request', 'accept'] as EventType[])
        .includes(evt.eventType as EventType) ? (evt.eventType as EventType) : 'decision';
      const idMatch: ManuscriptIdMatch | null = evt.manuscriptNum ? { id: evt.manuscriptNum, journal: evt.journal } : null;
      const plan = planNotionPatch(eventType, evt.journal, msg.body);
      const ok = await applyMatchedEvent(evt.id, evt.manuscriptId, msg, eventType, plan, idMatch, extractTitleFromBody(msg.body, msg.subject));
      if (ok) result0.reapplied++;
    } catch (e) {
      console.warn(`[mail-monitor] re-apply 실패 ${evt.id}: ${(e as Error).message?.slice(0, 80)}`);
    }
  }

  const result = result0; // re-apply 카운트(reapplied) 포함해 누적
  for (const evt of events) {
    try {
      const data = await gmail.users.messages.get({ userId: 'me', id: evt.gmailMessageId, format: 'full' }).catch(() => null);
      if (!data) continue;
      result.scanned++;
      const msg = parseGmailMessage(data.data);

      const eventType = classifyEvent(msg.subject, msg.snippet, msg.body);
      if (!eventType) {
        // 리뷰어/무관 메일로 판명 — unmatched 큐에서 제거
        await prisma.manuscriptMailEvent.update({
          where: { id: evt.id },
          data: { eventType: 'ignored', applied: true },
        });
        result.ignored++;
        continue;
      }

      const idMatch = extractManuscriptId(msg.subject, msg.snippet, msg.body);
      const journal = deriveJournal(msg, idMatch);
      const extractedTitle = extractTitleFromBody(msg.body, msg.subject);
      const manuscriptId = await matchManuscript(idMatch, extractedTitle, journal);
      const plan = planNotionPatch(eventType, journal, msg.body);

      const changed = eventType !== evt.eventType ||
        (idMatch?.id || null) !== evt.manuscriptNum ||
        (journal || null) !== evt.journal;

      await prisma.manuscriptMailEvent.update({
        where: { id: evt.id },
        data: {
          eventType,
          manuscriptNum: idMatch?.id || evt.manuscriptNum,
          journal: journal || evt.journal,
          revisionDueAt: plan.revisionDueAt || evt.revisionDueAt,
          manuscriptId,
        },
      });
      if (changed) result.reclassified++;

      if (manuscriptId) {
        const ok = await applyMatchedEvent(evt.id, manuscriptId, msg, eventType, plan, idMatch, extractedTitle);
        if (ok) result.relinked++;
      }
    } catch (e) {
      console.warn(`[mail-monitor] reprocess 실패 ${evt.id}: ${(e as Error).message?.slice(0, 80)}`);
    }
  }
  console.log(`[mail-monitor] reprocess: scanned=${result.scanned} relinked=${result.relinked} reclassified=${result.reclassified} ignored=${result.ignored} reapplied=${result.reapplied}`);
  return result;
}

// ─────────────────────────────────────────────
// 메인 monitor
// ─────────────────────────────────────────────

/** 메인 monitor — userId의 Gmail에서 마지막 처리 시점 이후 메일만 처리 (incremental).
 *  daysAgo 명시 시 그 기간 풀스캔 (수동 [Gmail] 버튼 / 첫 백필 용).
 *  완료 후 기존 unmatched 이벤트 자동 재처리 (로직 개선 소급 적용). */
export async function monitorManuscriptMail(opts: { userId: string; daysAgo?: number; force?: boolean; skipReprocess?: boolean } = { userId: '' }):
  Promise<{ scanned: number; matched: number; unmatched: number; events: Record<string, number>; reprocess?: { scanned: number; relinked: number; reclassified: number; ignored: number } }> {
  const t0 = Date.now();
  console.log('[mail-monitor] 시작');

  const userId = opts.userId || (await prisma.user.findFirst({ where: { email: 'jungmok.seo@gmail.com' } }))?.id;
  if (!userId) {
    console.warn('[mail-monitor] userId 없음');
    return { scanned: 0, matched: 0, unmatched: 0, events: {} };
  }

  let sinceDate: Date | null = null;
  if (!opts.daysAgo) {
    sinceDate = await getLastProcessedAt();
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

  // 기존 unmatched 재처리 — 이번 스캔에서 새로 unmatched된 것 + 과거 잔여 모두
  let reprocess;
  if (!opts.skipReprocess) {
    try {
      reprocess = await reprocessUnmatchedEvents(userId);
    } catch (e) {
      console.warn(`[mail-monitor] reprocess 단계 실패: ${(e as Error).message?.slice(0, 80)}`);
    }
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`[mail-monitor] 완료: 스캔 ${scanned}, 매칭 ${matched}, 미매칭 ${unmatched}, 이벤트 ${JSON.stringify(events)}, ${elapsed}s`);
  return { scanned, matched, unmatched, events, reprocess };
}

/** 미매칭 이벤트 목록 — UI에서 사용자가 수동 매칭 */
export async function getUnmatchedEvents() {
  return prisma.manuscriptMailEvent.findMany({
    where: { manuscriptId: null, applied: false, eventType: { not: 'ignored' } },
    orderBy: { receivedAt: 'desc' },
    take: 50,
  });
}

/**
 * 미매칭 이벤트를 manuscript에 수동 매칭 — Notion patch까지 즉시 적용.
 * (이전엔 링크만 하고 patch를 안 해서 사용자가 수동 매칭해도 노션에 아무 변화가 없었음)
 */
export async function linkUnmatchedEvent(eventId: string, manuscriptId: string) {
  const evt = await prisma.manuscriptMailEvent.findUnique({ where: { id: eventId } });
  if (!evt) return { ok: false, error: 'event not found' };

  await prisma.manuscriptMailEvent.update({
    where: { id: eventId },
    data: { manuscriptId },
  });

  // 이벤트에 저장된 정보로 Notion patch (원문 재조회 없이 — eventType/journal/revisionDueAt 사용)
  const eventType = (['submitted', 'decision', 'reject', 'revision_request', 'accept'] as EventType[])
    .includes(evt.eventType as EventType) ? (evt.eventType as EventType) : 'decision';
  const plan = planNotionPatch(eventType, evt.journal, '');
  if (evt.revisionDueAt) plan.revisionDueAt = evt.revisionDueAt;

  const fakeMsg: GmailMsg = {
    id: evt.gmailMessageId,
    threadId: evt.threadId ?? evt.gmailMessageId,
    subject: evt.subject ?? '',
    snippet: evt.rawSnippet ?? '',
    body: '',
    fromAddr: evt.fromAddr ?? '',
    receivedAt: evt.receivedAt,
  };
  const idMatch: ManuscriptIdMatch | null = evt.manuscriptNum ? { id: evt.manuscriptNum, journal: evt.journal } : null;
  const applied = await applyMatchedEvent(eventId, manuscriptId, fakeMsg, eventType, plan, idMatch, null);

  return { ok: true, applied };
}
