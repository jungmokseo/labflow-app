/**
 * BLISS Slack Inbox 처리 cron — 추적 채널의 메시지를 폴링하여 검토대기 큐(Capture)에 입력.
 *
 * 마이그레이션 출처: ~/.claude/skills/process-slack-inbox/SKILL.md
 *   원래 흐름: poll.py → ~/.local/state/bliss-slack/inbox.json → 스킬이 LLM 분류 후 Notion 입력.
 *   Railway는 사용자 로컬 fs에 접근 불가 → 폴링 + LLM 분류를 서버에 직접 통합.
 *
 * 흐름:
 *   1. conversations.list로 BLISS-Bot이 멤버인 채널 발견 (잡담/FAQ 등 제외)
 *   2. 채널별 last_polled_ts 이후 메시지 conversations.history
 *   3. 룰 기반 1차 필터 (bot/이모지/🔒/thread reply/sensitive)
 *   4. Anthropic Sonnet (또는 Gemini fallback) 으로 task/request/decision 분류 + 제목/마감일/담당자 추출
 *   5. 살아남은 메시지를 prisma.capture.create — bliss-tasks/captures 와 동일한 metadata.blissSource 형식
 *   6. last_polled_ts 갱신 (전용 Capture 행에 metadata.channelStates JSON으로 저장)
 *
 * 환경:
 *   SLACK_BOT_TOKEN (필수) — BLISS Lab Slack
 *   ANTHROPIC_API_KEY (권장) — 정밀 분류용 Sonnet
 *   GEMINI_API_KEY (필수, env 로드 시점에 검증됨) — Sonnet 실패 시 fallback
 *   LAB_OWNER_CLERK_ID (선택) — Capture 소유자, 기본 'dev-user-seo'
 *
 * 한계:
 *   - 단일 replica 가정 (Railway 기본). 멀티 replica 시 channelStates에 advisory lock 필요.
 *   - 첫 실행 시 last_polled_ts 없으면 24h 윈도우 폴링 (안전 기본값).
 *   - cooldown hash 중복 체크는 metadata.blissSource.slackChannel+slackTs unique로 대체 (DB findFirst).
 */

import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Prisma } from '@prisma/client';
import { env } from '../config/env.js';
import { basePrismaClient as prisma } from '../config/prisma.js';
import { getSlackChannelHistory, getSlackPermalink } from './cron-shared/slack-api.js';

// ── 정책 ────────────────────────────────────────────
// poll.py와 동일 제외 목록 — 이름 소문자 비교 (Slack 채널명은 영소문자/한글 가능).
const EXCLUDED_CHANNEL_NAMES = new Set(
  [
    '공지', 'general', 'random',
    '잡담',
    '연구동향', '연구실-챗봇_faq', '연구실-챗봇-faq',
    'ai-알림', 'bliss-bot', 'bot',
  ].map((n) => n.toLowerCase()),
);

const SYSTEM_MESSAGE_SUBTYPES = new Set([
  'bot_message', 'channel_join', 'channel_leave',
  'channel_purpose', 'channel_topic', 'channel_name',
  'pinned_item', 'unpinned_item',
  'channel_archive', 'channel_unarchive',
]);

const TASK_HEURISTIC_KEYWORDS = [
  '해주세요', '부탁드립니다', '필요합니다', '요청드립니다',
  '예약', '신청', '접수', '보내주세요', '확인해주세요',
  '마감', '마감일', '기한',
  '교수님', '허락', '승인', '결재',
  '괜찮을까요', '가능할까요', '괜찮나요',
  '여쭙고', '여쭤', '문의드립니다',
  '결정합니다', '결정했습니다', '확정', '정리하면',
];

const SENSITIVE_KEYWORDS = [
  '그만두', '퇴사', '휴학', '졸업 미뤄', '정신',
  '우울', '힘들어', '괴롭', '관계 문제', '가족',
];

// 이모지/스티커만 있는지 (대략) — 한글/영문/숫자가 5자 이상 있어야 task 후보로 봄.
const ALPHANUM_OR_HANGUL = /[\p{L}\p{N}]/u;

// state 저장용 Capture 행 식별자 — sourceType + summary + tags로 유니크하게 잡음.
const STATE_SOURCE_TYPE = 'slack-poll-state';
const STATE_SUMMARY = 'BLISS Slack Poll State';
const STATE_TAGS = ['internal', 'slack-poll-state'];

const DEFAULT_LOOKBACK_HOURS = 24;

// ── 타입 ────────────────────────────────────────────
export interface ProcessSlackInboxResult {
  channelsScanned: number;
  messagesScanned: number;
  messagesAfterFilter: number;
  newCaptures: number;
  skippedDup: number;
  errors: string[];
  ranAt: string;
}

interface SlackMessage {
  type?: string;
  subtype?: string;
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
}

interface ChannelInfo {
  id: string;
  name: string;
}

interface ClassifiedMessage {
  kind: 'task' | 'request' | 'decision' | 'discussion' | 'sensitive';
  title: string;        // 30자 이내 한국어
  summaryKo?: string;   // 원문이 외국어면 한국어 2~3문장 요약
  ownerKoreanName?: string;
  dueDate?: string;     // YYYY-MM-DD
  type?: string;        // 영수증/회의/보고서 등
}

// ── Slack helpers ───────────────────────────────────
async function slackGet<T>(path: string): Promise<T> {
  const res = await fetch(`https://slack.com/api/${path}`, {
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Slack HTTP ${res.status} for ${path}`);
  return res.json() as Promise<T>;
}

/**
 * 채널의 멤버 ID 배열 (in-memory cache, 5분 TTL).
 * conversations.members 호출 — public/private 채널 모두 지원.
 * 실패 시 null (cron은 채널 스캔을 안전 skip).
 */
const channelMembersCache = new Map<string, { members: string[]; expiresAt: number }>();
async function getChannelMembers(channelId: string): Promise<string[] | null> {
  const cached = channelMembersCache.get(channelId);
  if (cached && cached.expiresAt > Date.now()) return cached.members;
  try {
    const data = await slackGet<{ ok: boolean; members?: string[]; error?: string }>(
      `conversations.members?channel=${encodeURIComponent(channelId)}&limit=200`,
    );
    if (!data.ok || !Array.isArray(data.members)) return null;
    channelMembersCache.set(channelId, { members: data.members, expiresAt: Date.now() + 5 * 60 * 1000 });
    return data.members;
  } catch {
    return null;
  }
}

async function discoverTrackedChannels(): Promise<ChannelInfo[]> {
  const out: ChannelInfo[] = [];
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({
      types: 'public_channel,private_channel',
      exclude_archived: 'true',
      limit: '200',
    });
    if (cursor) params.set('cursor', cursor);
    const data = await slackGet<{
      ok: boolean;
      error?: string;
      channels?: Array<{ id: string; name?: string; is_member?: boolean }>;
      response_metadata?: { next_cursor?: string };
    }>(`conversations.list?${params.toString()}`);
    if (!data.ok) {
      throw new Error(`conversations.list 실패: ${data.error || 'unknown'}`);
    }
    // PI(ADMIN_USER_ID)가 멤버인 채널만 스캔 — 사용자가 참여 안 한 봇+학생만 채널은 제외.
    // 정책: "내가 봇과 같이 참여하거나 봇 없이 나와 학생이 참여한 대화만 검토 큐에 들어옴".
    // ADMIN_USER_ID 미설정 시 PI 체크 건너뜀 (이전 동작 유지 — 봇 멤버십만 검증).
    const piUserId = env.ADMIN_USER_ID;
    for (const ch of data.channels || []) {
      if (!ch.is_member) continue;
      const name = (ch.name || '').toLowerCase();
      if (!name) continue;
      if (EXCLUDED_CHANNEL_NAMES.has(name)) continue;
      if (piUserId) {
        const members = await getChannelMembers(ch.id);
        if (members && !members.includes(piUserId)) continue;
        // members fetch 실패 시 보수적으로 포함 (이전 동작 유지)
      }
      out.push({ id: ch.id, name: `#${ch.name}` });
    }
    cursor = data.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return out;
}

async function fetchHistory(channelId: string, oldestTs: number): Promise<SlackMessage[]> {
  const data = await getSlackChannelHistory(channelId, oldestTs.toString(), 1000);
  if (!data.ok) {
    throw new Error(`conversations.history(${channelId}) 실패: ${data.error || 'unknown'}`);
  }
  return (data.messages as SlackMessage[] | undefined) || [];
}

async function getPermalink(channelId: string, ts: string): Promise<string> {
  const permalink = await getSlackPermalink(channelId, ts);
  if (permalink) return permalink;
  return `https://app.slack.com/client/${channelId}/p${ts.replace('.', '')}`;
}

async function getUserName(userId: string, cache: Map<string, string>): Promise<string> {
  if (!userId) return '(unknown)';
  const cached = cache.get(userId);
  if (cached) return cached;
  try {
    const data = await slackGet<{
      ok: boolean;
      user?: { profile?: { display_name?: string; real_name?: string } };
    }>(`users.info?user=${userId}`);
    if (data.ok && data.user) {
      const name = data.user.profile?.display_name || data.user.profile?.real_name || userId;
      cache.set(userId, name);
      return name;
    }
  } catch { /* ignore */ }
  cache.set(userId, userId);
  return userId;
}

async function getBotUserId(): Promise<string | null> {
  try {
    const data = await slackGet<{ ok: boolean; user_id?: string }>('auth.test');
    return data.ok ? data.user_id || null : null;
  } catch {
    return null;
  }
}

// ── 룰 기반 필터 ────────────────────────────────────
// 단순 답변/감사/확인 메시지 — 분류 대상 아님 (그룹DM에서 BeiBei 메시지 등 폭증 방지)
const TRIVIAL_REPLY_PATTERNS = [
  // 한국어
  /^(네|넵|예|아 네|알겠습니다|확인했습니다|감사합니다|감사해요|고맙습니다|좋습니다|좋아요)[.!\s]*$/,
  /^(괜찮습니다|괜찮아요|문제없습니다|문제없어요)[.!\s]*$/,
  // 영어 짧은 답변
  /^(ok|okay|thanks|thank you|got it|noted|sure|yes|sounds good)[.!\s]*$/i,
  // 중국어 짧은 답변
  /^(好的|好|收到|收到了|明白|明白了|谢谢|谢谢您|感谢|没问题|可以|行|嗯|嗯嗯)[，。！\s]*$/u,
  /^(好的[，,]?\s*收到[!！]?\s*(我会|我将)?.{0,40})$/u, // "好的，收到！我会..."
];

function isTrivialReply(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length > 80) return false;  // 긴 메시지는 trivial 아닐 수 있음 (조기 종료)
  return TRIVIAL_REPLY_PATTERNS.some(p => p.test(trimmed));
}

function passesHeuristicFilter(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length < 5) return false;
  if (!ALPHANUM_OR_HANGUL.test(trimmed)) return false;       // 이모지만
  if (trimmed.startsWith('🔒')) return false;
  // 단순 답변/감사/확인 메시지 — 분류 대상 아님 (그룹DM 폭증 방지)
  if (isTrivialReply(trimmed)) return false;
  for (const kw of SENSITIVE_KEYWORDS) if (trimmed.includes(kw)) return false;
  // 질문/요청 단서 키워드 — 하나라도 매치하면 task 후보.
  for (const kw of TASK_HEURISTIC_KEYWORDS) if (trimmed.includes(kw)) return true;
  // 키워드 매치 없어도 질문/명령형 끝맺음이면 후보 — 단, 아주 짧은 단순 의문사 제외.
  if ((trimmed.endsWith('?') || trimmed.endsWith('?')) && trimmed.length >= 8) return true;
  return false;
}

// ── LLM 분류 ────────────────────────────────────────
function buildClassifyPrompt(text: string, channelName: string, today: string): string {
  return `당신은 BLISS Lab(연세대 바이오센서/유연전자소자 연구실)의 Slack 메시지 분류기입니다.
PI(서정목 교수)의 검토 큐가 노이즈로 폭증하지 않도록 **매우 보수적으로** 분류하세요.

[메시지]
채널: ${channelName}
본문: """${text.slice(0, 1500)}"""

[지시]
다음 JSON 한 객체로만 응답 (다른 텍스트 없이):
{
  "kind": "task" | "request" | "decision" | "discussion" | "sensitive",
  "title": "30자 이내 한국어 제목 (요청 핵심)",
  "summary_ko": "원문이 외국어(중국어/영어 등)면 한국어 2~3문장 요약. 원문이 한국어면 그대로 또는 간단 요약",
  "owner_korean_name": "메시지에 명시된 담당자 한글 이름 (없으면 빈 문자열)",
  "due_date": "YYYY-MM-DD (메시지에 마감일 있으면, 오늘 기준 ${today}로 계산. 없으면 빈 문자열)",
  "type": "영수증 | 회의 | 보고서 | 신청 | 기타 (적절한 것 1개)"
}

[한글 정리 규칙 — 중요]
- title은 **반드시 한국어**. 원문이 중국어("教授您好...")여도 한국어 제목으로 ("교수님 검토 요청 — 노션 업데이트 완료" 등).
- summary_ko는 원문이 한국어가 아니면 핵심을 한국어 2~3문장으로 정리.
- 인명·전문용어는 그대로 유지 (예: "MOF", "DMA", "Beibei"). 지명·기관명도 그대로.

[판단 기준 — strict mode]
- **task**: 학생에게 명확하게 배정해야 할 작업이 있을 때만 ("이 영수증 김수아님이 처리해주세요"처럼 담당자 + 행동 명시).
- **request**: 교수가 **즉시 답변·승인·결재**해야 하는 명시적 요청만. 단순 "여쭙니다" "괜찮을까요?" 같은 가벼운 질문은 discussion. 교수가 모르면 일이 막히는 수준이어야 request.
- **decision**: 그룹 합의/결정 통지 ("다음 주에 재논의하기로"), 단순 통보는 제외.
- **discussion**: 다음은 모두 discussion (검토 큐 진입 X):
  - 단순 답변·확인 ("好的，收到", "我会", "我已经...", "알겠습니다", "확인했습니다")
  - 진행 상황 보고 ("我正在...", "已经更新了 notion", "我这边已经确认了")
  - 잡담·정보 공유·뉴스
  - 단순 질문이지만 누구나 답변 가능 (PI 외 학생들도 답할 수 있는 질문)
  - 학생 본인이 검색하면 알 수 있는 질문
- **sensitive**: 개인사/평가/관계/정신건강.

[중요 규칙]
- "교수님" 호칭이 있어도 **단순 보고/답변**이면 → discussion.
- 진행상황 공유 ("做了 X", "已经做完 Y") → discussion. 교수가 즉시 행동할 필요 없음.
- 그룹DM에서 학생끼리 질문·답변 주고받는 메시지 → 대부분 discussion.
- **확신 없으면 무조건 discussion으로 분류**. 잘못 task로 만드는 것보다 누락이 훨씬 낫다.
- task/request로 분류하려면 "PI가 이 메시지를 봤을 때 즉시 무언가 행동(답변·결정·작업 배정)을 해야만 한다"는 확신이 있어야 함.`;
}

function parseClassifyJson(raw: string): ClassifiedMessage | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    const validKinds = ['task', 'request', 'decision', 'discussion', 'sensitive'];
    const kind = validKinds.includes(parsed.kind) ? parsed.kind : 'discussion';
    const title = String(parsed.title || '').slice(0, 60).trim() || '(제목 없음)';
    const summaryKo = String(parsed.summary_ko || '').slice(0, 800).trim() || undefined;
    const ownerKoreanName = String(parsed.owner_korean_name || '').trim() || undefined;
    const due = String(parsed.due_date || '').trim();
    const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : undefined;
    const type = String(parsed.type || '').trim() || undefined;
    return { kind, title, summaryKo, ownerKoreanName, dueDate, type } as ClassifiedMessage;
  } catch {
    return null;
  }
}

async function classifyWithSonnet(text: string, channelName: string): Promise<ClassifiedMessage | null> {
  if (!env.ANTHROPIC_API_KEY) return null;
  const today = new Date().toISOString().slice(0, 10);
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      temperature: 0.1,
      messages: [{ role: 'user', content: buildClassifyPrompt(text, channelName, today) }],
    });
    const block = resp.content.find((b) => b.type === 'text');
    if (!block || block.type !== 'text') return null;
    return parseClassifyJson(block.text);
  } catch (e: any) {
    console.warn(`[slack-inbox] Sonnet 분류 실패: ${e?.message || e}`);
    return null;
  }
}

async function classifyWithGemini(text: string, channelName: string): Promise<ClassifiedMessage | null> {
  if (!env.GEMINI_API_KEY) return null;
  const today = new Date().toISOString().slice(0, 10);
  try {
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite' });
    const result = await model.generateContent({
      contents: [
        { role: 'user', parts: [{ text: buildClassifyPrompt(text, channelName, today) }] },
      ],
      generationConfig: { temperature: 0.1, maxOutputTokens: 512 },
    });
    return parseClassifyJson(result.response.text());
  } catch (e: any) {
    console.warn(`[slack-inbox] Gemini 분류 실패: ${e?.message || e}`);
    return null;
  }
}

async function classifyMessage(text: string, channelName: string): Promise<ClassifiedMessage | null> {
  const sonnet = await classifyWithSonnet(text, channelName);
  if (sonnet) return sonnet;
  return classifyWithGemini(text, channelName);
}

// ── State 저장/로드 (Capture metadata 활용) ──────────
async function loadState(userId: string): Promise<{ row: { id: string } | null; channelTs: Record<string, number> }> {
  const row = await prisma.capture.findFirst({
    where: { userId, sourceType: STATE_SOURCE_TYPE, status: 'active' },
    select: { id: true, metadata: true },
  });
  if (!row) return { row: null, channelTs: {} };
  const md = (row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata))
    ? (row.metadata as Prisma.JsonObject)
    : {};
  const states = md.channelStates;
  const channelTs: Record<string, number> = {};
  if (states && typeof states === 'object' && !Array.isArray(states)) {
    for (const [k, v] of Object.entries(states as Record<string, unknown>)) {
      const num = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(num) && num > 0) channelTs[k] = num;
    }
  }
  return { row: { id: row.id }, channelTs };
}

async function saveState(userId: string, existingRowId: string | null, channelTs: Record<string, number>): Promise<void> {
  const metadata = {
    channelStates: channelTs,
    lastRunAt: new Date().toISOString(),
  };
  if (existingRowId) {
    await prisma.capture.update({
      where: { id: existingRowId },
      data: { metadata },
    });
    return;
  }
  await prisma.capture.create({
    data: {
      userId,
      content: 'BLISS Slack Poll 마지막 ts 저장용 — 자동 관리.',
      summary: STATE_SUMMARY,
      category: 'MEMO',
      tags: STATE_TAGS,
      sourceType: STATE_SOURCE_TYPE,
      reviewed: true,
      status: 'active',
      metadata,
    },
  });
}

// ── Owner 결정 (bliss-tasks와 동일 패턴) ─────────────
async function resolveOwner() {
  const ownerClerkId = env.LAB_OWNER_CLERK_ID || 'dev-user-seo';
  let user = await prisma.user.findFirst({ where: { clerkId: ownerClerkId } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        clerkId: ownerClerkId,
        email: env.LAB_OWNER_EMAIL || `${ownerClerkId}@labflow.app`,
        name: 'Jungmok Seo',
      },
    });
  }
  const lab = await prisma.lab.findFirst({ where: { ownerId: user.id }, select: { id: true } });
  return { userId: user.id, labId: lab?.id ?? null };
}

/**
 * LLM이 prompt instruction을 무시하고 외국어 title을 반환하는 경우 후처리.
 * 한자 ≥ 3자 AND 한자 > 한글이면 summary_ko의 첫 문장으로 대체 (이미 한국어).
 * summary_ko 없으면 "(외국어 메시지)" prefix 추가 — 최소한 PI가 외국어임을 인지.
 */
function normalizeKoreanTitle(classified: ClassifiedMessage): ClassifiedMessage {
  const title = classified.title;
  if (!title) return classified;
  const cjk = (title.match(/[一-鿿]/g) ?? []).length;
  const hangul = (title.match(/[가-힣]/g) ?? []).length;
  const isForeign = cjk >= 3 && cjk > hangul;
  if (!isForeign) return classified;

  // summary_ko가 있으면 첫 문장을 title로 (이미 한국어로 LLM이 작성한 요약)
  if (classified.summaryKo && classified.summaryKo.trim()) {
    const firstSentence = classified.summaryKo
      .split(/[.!?。！？]\s*/)[0]
      .trim()
      .slice(0, 60);
    if (firstSentence) {
      return { ...classified, title: firstSentence };
    }
  }
  // summary_ko도 없으면 원본 title 앞에 [외국어] prefix 추가 (시각 표시)
  return { ...classified, title: `[외국어] ${title.slice(0, 50)}` };
}

// ── Capture 생성 (bliss-tasks/captures와 동일 schema) ─
async function createCapture(input: {
  userId: string;
  labId: string | null;
  classified: ClassifiedMessage;
  text: string;
  channelId: string;
  channelName: string;
  ts: string;
  permalink: string;
  userName: string;
  slackUserId: string;
}): Promise<{ created: boolean }> {
  // dedup — 같은 channel+ts는 skip
  const existing = await prisma.capture.findFirst({
    where: {
      labId: input.labId,
      AND: [
        { metadata: { path: ['blissSource', 'slackChannel'], equals: input.channelId } },
        { metadata: { path: ['blissSource', 'slackTs'], equals: input.ts } },
      ],
    },
    select: { id: true },
  });
  if (existing) return { created: false };

  // LLM이 prompt를 무시하고 외국어 title을 반환했을 때 한국어로 후처리 (summary_ko 사용).
  const classified = normalizeKoreanTitle(input.classified);

  // Content는 한글 요약 + 원문. summary는 한글 title 그대로.
  // 외국어 메시지(중국어 등)도 PI가 한국어로 한눈에 파악 가능.
  const koSummary = classified.summaryKo;
  const contentParts: string[] = [];
  if (koSummary) {
    contentParts.push(`📝 한글 요약: ${koSummary}`);
    contentParts.push('');
    contentParts.push('--- 원문 ---');
  }
  contentParts.push(input.text.slice(0, 5000));

  await prisma.capture.create({
    data: {
      userId: input.userId,
      labId: input.labId,
      content: contentParts.join('\n').slice(0, 8000),
      summary: classified.title.slice(0, 200),  // normalize로 한국어 보장
      category: 'TASK',
      tags: ['bliss-slack', 'review-queue'],
      priority: 'MEDIUM',
      confidence: 1.0,
      modelUsed: 'cron-process-slack-inbox',
      sourceType: 'slack',
      reviewed: false,
      status: 'active',
      // due_date / owner 추정값은 metadata에만 — 교수가 review-queue에서 확정하는 단계에 사용.
      metadata: {
        blissSource: {
          sourceChannel: input.channelName,
          slackPermalink: input.permalink,
          slackUserId: input.slackUserId,
          requesterName: input.userName,
          slackChannel: input.channelId,
          slackTs: input.ts,
        },
        classification: {
          kind: classified.kind,
          ownerKoreanName: classified.ownerKoreanName,
          dueDate: classified.dueDate,
          type: classified.type,
          summaryKo: koSummary,  // BLISS-Bot Home에서 표시 가능
          originalTitleIfForeign: classified.title !== input.classified.title ? input.classified.title : undefined,
        },
        capturedAt: new Date().toISOString(),
      },
    },
  });
  return { created: true };
}

// ── 메인 ────────────────────────────────────────────
export async function runProcessSlackInbox(): Promise<ProcessSlackInboxResult> {
  const result: ProcessSlackInboxResult = {
    channelsScanned: 0,
    messagesScanned: 0,
    messagesAfterFilter: 0,
    newCaptures: 0,
    skippedDup: 0,
    errors: [],
    ranAt: new Date().toISOString(),
  };

  if (!env.SLACK_BOT_TOKEN) {
    throw new Error('SLACK_BOT_TOKEN 미설정 — Slack 폴링 불가');
  }

  const { userId, labId } = await resolveOwner();
  const { row, channelTs } = await loadState(userId);
  const botUserId = await getBotUserId();
  const userNameCache = new Map<string, string>();
  const newChannelTs: Record<string, number> = { ...channelTs };
  const nowSec = Math.floor(Date.now() / 1000);

  let channels: ChannelInfo[] = [];
  try {
    channels = await discoverTrackedChannels();
  } catch (e: any) {
    result.errors.push(`discoverTrackedChannels 실패: ${e?.message || e}`);
    return result;
  }
  result.channelsScanned = channels.length;

  for (const ch of channels) {
    const oldest = newChannelTs[ch.id] ?? (nowSec - DEFAULT_LOOKBACK_HOURS * 3600);
    let messages: SlackMessage[] = [];
    try {
      messages = await fetchHistory(ch.id, oldest);
    } catch (e: any) {
      result.errors.push(`${ch.name} fetchHistory 실패: ${e?.message || e}`);
      continue;
    }

    let maxTsSec = oldest;
    for (const m of messages) {
      result.messagesScanned++;
      const ts = m.ts ? Number(m.ts) : 0;
      if (ts > maxTsSec) maxTsSec = ts;

      // 1차 룰 필터
      if (!m.user) continue;                                // user 없는 메시지(시스템) skip
      if (botUserId && m.user === botUserId) continue;      // 자기 봇 메시지 skip
      if (m.bot_id) continue;                               // 다른 봇 메시지 skip
      const subtype = m.subtype || '';
      if (SYSTEM_MESSAGE_SUBTYPES.has(subtype)) continue;
      if (subtype && subtype !== 'thread_broadcast') continue;
      // thread reply (thread_ts ≠ ts) skip — 첫 메시지만 캡처
      if (m.thread_ts && m.thread_ts !== m.ts) continue;
      const text = m.text || '';
      if (!passesHeuristicFilter(text)) continue;

      result.messagesAfterFilter++;

      // 2차 LLM 분류
      let classified: ClassifiedMessage | null;
      try {
        classified = await classifyMessage(text, ch.name);
      } catch (e: any) {
        result.errors.push(`${ch.name} classify 실패: ${e?.message || e}`);
        continue;
      }
      if (!classified) continue;
      if (classified.kind === 'discussion' || classified.kind === 'sensitive') continue;

      // 3차 Capture 생성 (dedup)
      try {
        const userName = await getUserName(m.user, userNameCache);
        const permalink = await getPermalink(ch.id, m.ts!);
        const { created } = await createCapture({
          userId, labId,
          classified, text,
          channelId: ch.id, channelName: ch.name,
          ts: m.ts!, permalink,
          userName, slackUserId: m.user,
        });
        if (created) result.newCaptures++;
        else result.skippedDup++;
      } catch (e: any) {
        result.errors.push(`${ch.name} capture 실패: ${e?.message || e}`);
      }
    }

    newChannelTs[ch.id] = maxTsSec;
  }

  // state 저장 — 한 번에 모든 채널의 마지막 ts 갱신.
  try {
    await saveState(userId, row?.id ?? null, newChannelTs);
  } catch (e: any) {
    result.errors.push(`saveState 실패: ${e?.message || e}`);
  }

  console.log(
    `[slack-inbox] channels=${result.channelsScanned} scanned=${result.messagesScanned} ` +
    `filtered=${result.messagesAfterFilter} new=${result.newCaptures} dup=${result.skippedDup} ` +
    `errors=${result.errors.length}`,
  );
  return result;
}
