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
