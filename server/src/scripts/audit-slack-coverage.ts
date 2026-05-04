/**
 * Slack 봇 커버리지 진단:
 * - 사용자(PI=서정목) 참여 채널 vs 봇 참여 채널
 * - 봇이 멤버 아닌 채널 = 추적 누락 후보
 * - #연구동향 마지막 메시지 시각 (paper-monitoring 동작 여부)
 *
 * Usage: npx tsx src/scripts/audit-slack-coverage.ts
 */
import { env } from '../config/env.js';

const ADMIN_USER_ID = 'U0ASESNE1UP';  // 서정목 (PI)

interface SlackChannel {
  id: string;
  name: string;
  is_archived: boolean;
  is_member: boolean;
  is_private: boolean;
  num_members?: number;
}

async function slackCall<T>(method: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`https://slack.com/api/${method}`);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` } });
  return res.json() as Promise<T>;
}

async function listAllChannels(): Promise<SlackChannel[]> {
  const all: SlackChannel[] = [];
  let cursor: string | undefined;
  do {
    const params: Record<string, string> = {
      types: 'public_channel,private_channel',
      exclude_archived: 'true',
      limit: '200',
    };
    if (cursor) params.cursor = cursor;
    const r: any = await slackCall('conversations.list', params);
    if (!r.ok) { console.warn('conversations.list error:', r.error); break; }
    all.push(...r.channels);
    cursor = r.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return all;
}

async function isUserMember(channelId: string, userId: string): Promise<boolean> {
  // conversations.members에서 paginate. 채널 멤버 수가 클 수 있어 cursor 사용.
  let cursor: string | undefined;
  do {
    const params: Record<string, string> = { channel: channelId, limit: '200' };
    if (cursor) params.cursor = cursor;
    const r: any = await slackCall('conversations.members', params);
    if (!r.ok) return false;
    if ((r.members as string[]).includes(userId)) return true;
    cursor = r.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return false;
}

async function getLastMessage(channelId: string): Promise<{ ts: string; text: string } | null> {
  const r: any = await slackCall('conversations.history', { channel: channelId, limit: '1' });
  if (!r.ok || !r.messages?.length) return null;
  return { ts: r.messages[0].ts, text: r.messages[0].text || '' };
}

async function main() {
  if (!env.SLACK_BOT_TOKEN) throw new Error('SLACK_BOT_TOKEN 미설정');

  console.log('=== Slack 봇 커버리지 진단 ===\n');
  const channels = await listAllChannels();
  console.log(`총 채널 (public + private, 봇이 볼 수 있는): ${channels.length}\n`);

  const botMember = channels.filter(c => c.is_member);
  const botNotMember = channels.filter(c => !c.is_member);

  console.log(`✅ 봇 멤버 채널 (${botMember.length}개):`);
  for (const c of botMember) {
    const flag = c.is_private ? '🔒' : '#';
    console.log(`  ${flag}${c.name} (${c.id}, members: ${c.num_members || '?'})`);
  }

  console.log(`\n⚠️  봇 미멤버 채널 (${botNotMember.length}개) — 추적 안 됨:`);
  for (const c of botNotMember) {
    const flag = c.is_private ? '🔒' : '#';
    // 사용자가 멤버인지 확인 (사용자 멤버이지만 봇 미멤버 = 진짜 누락)
    const userMember = await isUserMember(c.id, ADMIN_USER_ID);
    if (userMember) {
      console.log(`  ${flag}${c.name} (${c.id}) — ⚠️ PI 참여, 봇 invite 필요`);
    } else {
      console.log(`  ${flag}${c.name} (${c.id})`);
    }
  }

  // #연구동향 마지막 게시 확인
  console.log(`\n=== #연구동향 (paper-monitoring) 진단 ===`);
  const trendCh = channels.find(c => c.name === '연구동향');
  if (!trendCh) {
    console.log('❌ #연구동향 채널 못 찾음');
  } else {
    console.log(`Channel: ${trendCh.id} | bot member: ${trendCh.is_member}`);
    const last = await getLastMessage(trendCh.id);
    if (last) {
      const ts = new Date(parseFloat(last.ts) * 1000);
      const days = Math.floor((Date.now() - ts.getTime()) / (1000 * 60 * 60 * 24));
      console.log(`마지막 메시지: ${ts.toISOString()} (${days}일 전)`);
      console.log(`텍스트: ${last.text.slice(0, 200)}`);
    } else {
      console.log('마지막 메시지 fetch 실패 (history scope 부족 또는 봇 미멤버)');
    }
  }
}

main().catch(console.error).finally(() => process.exit(0));
