/**
 * 워크시트 Slack 리마인드 발송 + ✅ reaction 추적 서비스.
 *
 * 흐름:
 * 1. PI가 /projects에서 [Slack 리마인드] / [검토 완료 알림] 클릭
 *    → sendWorksheetReminder() — Slack DM 발송 + worksheet_reminders row 생성
 * 2. 학생이 받은 DM에 ✅ (white_check_mark) reaction 추가
 *    → checkPendingReminders() polling이 reactions.get으로 발견 → ackedAt 갱신
 * 3. PI가 /projects에서 발송 상태 확인 + bliss-slack-bot App Home에서 학생도 자기 목록 확인
 *
 * raw SQL 사용 — paper_embeddings/wiki_embeddings 와 schema 충돌 회피.
 */
import { basePrismaClient as prisma } from '../config/prisma.js';
import { env } from '../config/env.js';

let tableEnsured = false;
async function ensureWorksheetRemindersTable() {
  if (tableEnsured) return;
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS worksheet_reminders (
      id                  TEXT PRIMARY KEY,
      project_id          TEXT NOT NULL,
      project_title       TEXT NOT NULL,
      student_name        TEXT NOT NULL,
      slack_user_id       TEXT NOT NULL,
      slack_channel_id    TEXT NOT NULL,
      slack_message_ts    TEXT NOT NULL,
      slack_permalink     TEXT,
      message             TEXT NOT NULL,
      purpose             TEXT NOT NULL,
      sent_by_user_id     TEXT,
      sent_at             TIMESTAMPTZ DEFAULT NOW(),
      acked_at            TIMESTAMPTZ,
      ack_emoji           TEXT,
      dismissed_at        TIMESTAMPTZ,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_wr_project ON worksheet_reminders(project_id)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_wr_user_ack ON worksheet_reminders(slack_user_id, acked_at)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_wr_msg ON worksheet_reminders(slack_channel_id, slack_message_ts)`);
  tableEnsured = true;
}

export interface WorksheetReminderRow {
  id: string;
  project_id: string;
  project_title: string;
  student_name: string;
  slack_user_id: string;
  slack_channel_id: string;
  slack_message_ts: string;
  slack_permalink: string | null;
  message: string;
  purpose: string;
  sent_by_user_id: string | null;
  sent_at: Date;
  acked_at: Date | null;
  ack_emoji: string | null;
  dismissed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface SendOpts {
  projectId: string;
  projectTitle: string;
  studentName: string;
  slackUserId: string;     // 미리 lookupByEmail로 해결한 Slack user id
  message: string;
  purpose: 'PI_TURN' | 'STUDENT_TURN';
  sentByUserId?: string;
}

interface SlackPostResp {
  ok: boolean;
  channel?: string;       // DM channel id (postMessage to user id)
  ts?: string;
  permalink?: string;
  error?: string;
}

/**
 * Slack DM 발송 + DB 기록 한 row 생성.
 * caller는 사전에 lookupByEmail로 slackUserId를 결정해야 함.
 */
export async function recordWorksheetReminder(opts: SendOpts): Promise<{
  ok: boolean;
  reminderId?: string;
  channel?: string;
  ts?: string;
  permalink?: string | null;
  error?: string;
}> {
  await ensureWorksheetRemindersTable();
  const token = env.SLACK_BOT_TOKEN;
  if (!token) return { ok: false, error: 'SLACK_BOT_TOKEN 미설정' };

  // 메시지에 ✅ 안내 추가 (옵션 A: reaction 추적)
  const messageWithAck = opts.message +
    `\n\n💡 _확인하셨다면 이 메시지에 :white_check_mark: 이모지로 반응해 주세요._`;

  // chat.postMessage — channel = user id면 DM 자동 open
  const post = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      channel: opts.slackUserId,
      text: messageWithAck,
      unfurl_links: false,
      unfurl_media: false,
    }),
  }).then(r => r.json() as Promise<SlackPostResp>);

  if (!post.ok || !post.channel || !post.ts) {
    return { ok: false, error: post.error || 'chat.postMessage 실패' };
  }

  // permalink fetch (best-effort)
  let permalink: string | null = null;
  try {
    const pl = await fetch(
      `https://slack.com/api/chat.getPermalink?channel=${post.channel}&message_ts=${post.ts}`,
      { headers: { Authorization: `Bearer ${token}` } },
    ).then(r => r.json() as Promise<{ ok: boolean; permalink?: string }>);
    if (pl.ok) permalink = pl.permalink || null;
  } catch { /* ignore */ }

  // DB 기록
  const id = `wr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO worksheet_reminders (
      id, project_id, project_title, student_name, slack_user_id,
      slack_channel_id, slack_message_ts, slack_permalink,
      message, purpose, sent_by_user_id, sent_at, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW(),NOW())`,
    id, opts.projectId, opts.projectTitle, opts.studentName, opts.slackUserId,
    post.channel, post.ts, permalink,
    messageWithAck, opts.purpose, opts.sentByUserId || null,
  );

  return { ok: true, reminderId: id, channel: post.channel, ts: post.ts, permalink };
}

/**
 * pending reminder들의 reactions.get을 폴링해서 ackedAt 갱신.
 * - 발송 후 14일 이내 + acked_at IS NULL 인 row만 검사 (오래된 건 polling 그만)
 * - white_check_mark / heavy_check_mark / +1 / done 중 하나라도 받으면 ack
 */
const ACK_EMOJIS = new Set(['white_check_mark', 'heavy_check_mark', '+1', 'done', 'ok']);

export async function checkPendingReminders(maxToCheck = 50): Promise<{ checked: number; acked: number; errors: number }> {
  await ensureWorksheetRemindersTable();
  const token = env.SLACK_BOT_TOKEN;
  if (!token) return { checked: 0, acked: 0, errors: 0 };

  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const pending = await prisma.$queryRawUnsafe<WorksheetReminderRow[]>(
    `SELECT id, slack_channel_id, slack_message_ts, slack_user_id
     FROM worksheet_reminders
     WHERE acked_at IS NULL AND dismissed_at IS NULL AND sent_at >= $1
     ORDER BY sent_at DESC
     LIMIT $2`,
    cutoff, maxToCheck,
  );

  let checked = 0, acked = 0, errors = 0;
  for (const r of pending as any[]) {
    checked++;
    try {
      const resp = await fetch(
        `https://slack.com/api/reactions.get?channel=${r.slack_channel_id}&timestamp=${r.slack_message_ts}`,
        { headers: { Authorization: `Bearer ${token}` } },
      ).then(r => r.json() as Promise<{ ok: boolean; message?: { reactions?: Array<{ name: string; users: string[] }> }; error?: string }>);
      if (!resp.ok) { errors++; continue; }
      const reactions = resp.message?.reactions || [];
      // 학생 본인이 ack 이모지를 남겼는지 확인
      const ackReaction = reactions.find(rxn =>
        ACK_EMOJIS.has(rxn.name) && rxn.users.includes(r.slack_user_id),
      );
      if (ackReaction) {
        await prisma.$executeRawUnsafe(
          `UPDATE worksheet_reminders SET acked_at = NOW(), ack_emoji = $1, updated_at = NOW() WHERE id = $2`,
          ackReaction.name, r.id,
        );
        acked++;
      }
    } catch (e: any) {
      errors++;
    }
  }
  return { checked, acked, errors };
}

/** 프로젝트별 reminder 목록 (PI UI용) */
export async function getRemindersByProject(projectId: string): Promise<WorksheetReminderRow[]> {
  await ensureWorksheetRemindersTable();
  return prisma.$queryRawUnsafe<WorksheetReminderRow[]>(
    `SELECT * FROM worksheet_reminders WHERE project_id = $1 ORDER BY sent_at DESC LIMIT 20`,
    projectId,
  );
}

/** 학생별 reminder 목록 (App Home용) */
export async function getRemindersForStudent(slackUserId: string, includeAcked = false): Promise<WorksheetReminderRow[]> {
  await ensureWorksheetRemindersTable();
  const where = includeAcked
    ? `slack_user_id = $1 AND dismissed_at IS NULL`
    : `slack_user_id = $1 AND dismissed_at IS NULL AND acked_at IS NULL`;
  return prisma.$queryRawUnsafe<WorksheetReminderRow[]>(
    `SELECT * FROM worksheet_reminders WHERE ${where} ORDER BY sent_at DESC LIMIT 30`,
    slackUserId,
  );
}

/** Slack reaction_added 이벤트로 즉시 ack 갱신 (App Home에서 클릭한 경우) */
export async function ackByMessageTs(channelId: string, messageTs: string, emoji: string, userId: string): Promise<boolean> {
  await ensureWorksheetRemindersTable();
  if (!ACK_EMOJIS.has(emoji)) return false;
  const result = await prisma.$executeRawUnsafe(
    `UPDATE worksheet_reminders
     SET acked_at = NOW(), ack_emoji = $1, updated_at = NOW()
     WHERE slack_channel_id = $2 AND slack_message_ts = $3 AND slack_user_id = $4 AND acked_at IS NULL`,
    emoji, channelId, messageTs, userId,
  );
  return (result as any) > 0;
}
