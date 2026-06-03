/**
 * Slack Web API 공통 helper — cron 자동화에서 재사용.
 *
 * 모든 cron service (deadline-reminders, paper-monitoring, general-email-briefing,
 * process-slack-inbox 등)이 같은 Slack API 호출 패턴을 사용하므로 한 곳에서 관리.
 *
 * Token: env.SLACK_BOT_TOKEN을 인자로 받음 (env import는 호출자가 함 — 순환 import 방지).
 */

import { env } from '../../config/env.js';

const SLACK_API = 'https://slack.com/api';

interface SlackOkResponse {
  ok: boolean;
  error?: string;
}

interface SlackUserResponse extends SlackOkResponse {
  user?: { id?: string };
}

interface SlackPostMessageResponse extends SlackOkResponse {
  ts?: string;
}

/** Slack Bot Token이 설정되어 있는지 확인 + 미설정 시 친절한 에러 */
function ensureToken(): string {
  if (!env.SLACK_BOT_TOKEN) throw new Error('SLACK_BOT_TOKEN 미설정');
  return env.SLACK_BOT_TOKEN;
}

/** users.lookupByEmail — Slack 워크스페이스에서 email로 user_id 조회 */
export async function lookupSlackUserByEmail(email: string): Promise<string | null> {
  if (!env.SLACK_BOT_TOKEN) return null;
  try {
    const res = await fetch(
      `${SLACK_API}/users.lookupByEmail?email=${encodeURIComponent(email)}`,
      { headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` } },
    );
    const data = (await res.json()) as SlackUserResponse;
    if (!data.ok) {
      console.warn(`[slack-api] users.lookupByEmail 실패 (${email}): ${data.error}`);
      return null;
    }
    return data.user?.id || null;
  } catch (e: any) {
    console.warn(`[slack-api] users.lookupByEmail 예외 (${email}): ${e?.message}`);
    return null;
  }
}

/**
 * chat.postMessage — DM 또는 채널 게시 공용.
 * - DM: channel = userId (예: 'U0...')
 * - 채널: channel = channelId (예: 'C0...')
 *
 * @returns { ok, ts?, error? }
 */
export async function postSlackMessage(
  channel: string,
  text: string,
  options: { blocks?: unknown[]; threadTs?: string } = {},
): Promise<SlackPostMessageResponse> {
  const token = ensureToken();
  try {
    const body: Record<string, unknown> = { channel, text };
    if (options.blocks) body.blocks = options.blocks;
    if (options.threadTs) body.thread_ts = options.threadTs;
    const res = await fetch(`${SLACK_API}/chat.postMessage`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as SlackPostMessageResponse;
    if (!data.ok) {
      console.warn(`[slack-api] chat.postMessage 실패 (${channel}): ${data.error}`);
    }
    return data;
  } catch (e: any) {
    console.warn(`[slack-api] chat.postMessage 예외 (${channel}): ${e?.message}`);
    return { ok: false, error: e?.message || 'unknown' };
  }
}

/** PI에게 DM (env.ADMIN_USER_ID 사용) */
export async function postSlackAdminDm(text: string, options?: { blocks?: unknown[] }): Promise<SlackPostMessageResponse> {
  if (!env.ADMIN_USER_ID) {
    return { ok: false, error: 'ADMIN_USER_ID 미설정' };
  }
  return postSlackMessage(env.ADMIN_USER_ID, text, options);
}

/**
 * 긴 markdown text를 Slack chat.postMessage 안전 한계(~40KB) 안에서 chunk 분할 발송.
 *
 * 배경: 장기간 cron 미실행 후 backfill 시 24h 윈도우에 누적 이메일이 매우 많으면
 *   - markdown 길이 > Slack truncate 한계 (정확한 한계는 client별 다름 — desktop ~40KB, mobile 더 짧음)
 *   - 모바일에서 "더보기" 잘리거나 일부 섹션 안 보임
 *
 * 정책:
 *   - 한 chunk 약 3500자 (안전 margin) — Block Kit limit과 mobile 가독성 둘 다 고려
 *   - 분할 경계: 빈 줄(\n\n) 우선 → 줄바꿈(\n) → 어쩔 수 없으면 hard split
 *   - 후속 chunk는 첫 줄에 `(1/N)` 같은 카운터 표시 — 사용자가 part 인지 가능
 *   - 첫 chunk 성공해도 후속 chunk 실패하면 errors에 누적 — 첫 chunk만 보일 수 있음
 *
 * @returns 모든 chunk 결과 합산. 마지막 chunk의 ts 반환. 첫 chunk fail이면 첫 error.
 */
export async function postSlackAdminDmChunked(
  text: string,
  options?: { maxChunkSize?: number },
): Promise<SlackPostMessageResponse & { chunks?: number }> {
  if (!env.ADMIN_USER_ID) {
    return { ok: false, error: 'ADMIN_USER_ID 미설정' };
  }
  const maxSize = options?.maxChunkSize ?? 3500;
  const chunks = splitMarkdownIntoChunks(text, maxSize);
  if (chunks.length === 0) return { ok: true, chunks: 0 };
  if (chunks.length === 1) {
    const r = await postSlackMessage(env.ADMIN_USER_ID, chunks[0]);
    return { ...r, chunks: 1 };
  }

  // 여러 chunk 발송 — 첫 chunk 성공 후 후속 발송. rate limit (1 msg/sec) 안전하게 200ms delay.
  let lastResp: SlackPostMessageResponse = { ok: false };
  let successCount = 0;
  for (let i = 0; i < chunks.length; i++) {
    const isFirst = i === 0;
    const isLast = i === chunks.length - 1;
    const prefix = isFirst ? '' : `_(${i + 1}/${chunks.length} — 분할 발송)_\n`;
    const suffix = isLast ? '' : `\n_(다음 part 이어집니다… ${i + 2}/${chunks.length})_`;
    const chunkText = `${prefix}${chunks[i]}${suffix}`;
    const r = await postSlackMessage(env.ADMIN_USER_ID, chunkText);
    if (r.ok) successCount++;
    lastResp = r;
    // rate limit 회피
    if (!isLast) await new Promise(r2 => setTimeout(r2, 250));
  }
  return {
    ok: successCount === chunks.length,
    ts: lastResp.ts,
    error: lastResp.error,
    chunks: chunks.length,
  };
}

/**
 * Markdown을 chunk로 분할 — 섹션 경계 우선.
 *
 * 분할 우선순위:
 *   1. 빈 줄(\n\n) — 섹션/문단 경계
 *   2. 한 줄(\n) — 줄 경계
 *   3. hard split — 어쩔 수 없을 때 (한 줄이 maxSize 초과)
 *
 * 첫 chunk는 maxSize 이내, 나머지도 동일. 빈 chunk는 skip.
 */
export function splitMarkdownIntoChunks(text: string, maxSize: number): string[] {
  if (!text) return [];
  if (text.length <= maxSize) return [text];

  const result: string[] = [];
  let remaining = text;

  while (remaining.length > maxSize) {
    // 빈 줄 경계 우선 — maxSize 이내의 마지막 \n\n 찾기
    let splitAt = remaining.lastIndexOf('\n\n', maxSize);
    if (splitAt < maxSize * 0.5) {
      // 빈 줄이 너무 일찍 끝나면 줄바꿈 사용
      splitAt = remaining.lastIndexOf('\n', maxSize);
    }
    if (splitAt < maxSize * 0.3) {
      // 줄바꿈도 너무 일찍이면 hard split
      splitAt = maxSize;
    }
    result.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining.length > 0) result.push(remaining);
  return result.filter(c => c.length > 0);
}

/**
 * conversations.history — 채널 메시지 조회.
 * @param channelId 채널 ID
 * @param oldestTs 이 ts보다 늦은 메시지만 (exclusive). 미설정 시 latest 100건.
 * @param limit 최대 개수 (default 100, max 1000)
 */
export async function getSlackChannelHistory(
  channelId: string,
  oldestTs?: string,
  limit = 100,
): Promise<{ ok: boolean; messages?: any[]; error?: string }> {
  const token = ensureToken();
  try {
    const params = new URLSearchParams({
      channel: channelId,
      limit: String(limit),
    });
    if (oldestTs) params.set('oldest', oldestTs);
    const res = await fetch(`${SLACK_API}/conversations.history?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = (await res.json()) as { ok: boolean; messages?: any[]; error?: string };
    return data;
  } catch (e: any) {
    return { ok: false, error: e?.message || 'unknown' };
  }
}

/** chat.getPermalink — 메시지 permalink 조회 */
export async function getSlackPermalink(channelId: string, ts: string): Promise<string | null> {
  if (!env.SLACK_BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams({ channel: channelId, message_ts: ts });
    const res = await fetch(`${SLACK_API}/chat.getPermalink?${params}`, {
      headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    });
    const data = (await res.json()) as { ok: boolean; permalink?: string; error?: string };
    return data.ok ? data.permalink || null : null;
  } catch {
    return null;
  }
}
