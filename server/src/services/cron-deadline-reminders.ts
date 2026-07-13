/**
 * 마감일 리마인더 cron — 매일 KST 09:00 실행.
 *
 * Notion DB '📝 연구실 할 일·요청'에서 상태='진행중' + 마감일 있는 항목을 추적.
 * D-3, D-1, 당일, 지남 단계에 도달하면 담당자에게 Slack DM.
 * 같은 페이지의 `리마인더_단계` 속성에 마지막 발송 단계를 기록하여 중복 방지.
 *
 * 환경:
 *   NOTION_API_KEY (필수)
 *   SLACK_BOT_TOKEN (필수)
 *
 * 정책:
 *   D-3 → D-1 → 당일 → 지남. D-2는 skip (사용자 피로 방지).
 *   상태가 '완료'·'보류'·'취소'면 절대 발송 X (status filter로 제외).
 *   지남은 1번만 ('지남' 단계 마킹 후 재발송 X).
 *
 * 마이그레이션 출처: ~/.claude/skills/send-deadline-reminders/SKILL.md
 *   (Cowork에서 매일 실행하던 것을 server-side cron으로 이전. Cowork 데이터 손실 영향 X)
 */

import { Client as NotionClient } from '@notionhq/client';
import { createNotionClient } from './notion-client.js';
import { env } from '../config/env.js';
import { basePrismaClient as prisma } from '../config/prisma.js';
import { lookupSlackUserByEmail, postSlackMessage } from './cron-shared/slack-api.js';

// 📝 연구실 할 일·요청 (Slack 자동 추출) Notion DB.
// 2026-05-17: 옛 ID 70aa782f-245b-460c-93be-1f0920fc13e2 → bcaf30f0-... (DB 위치 이동/재생성 추정).
// env.NOTION_TASK_DB_ID로 override 가능 — 향후 재이동 시 코드 수정 없이 env로 처리.
const TASK_DB_ID = env.NOTION_TASK_DB_ID || 'bcaf30f0-c5af-4d9c-967b-62a3baeaa093';

type Stage = 'D-3' | 'D-1' | '당일' | '지남';
const STAGE_ORDER: Record<Stage, number> = { 'D-3': 1, 'D-1': 2, '당일': 3, '지남': 4 };

interface TaskItem {
  id: string;
  title: string;
  ownerName: string;
  due: string;          // YYYY-MM-DD
  currentStage: Stage | null;
  type?: string;
  source?: string;
  slackPermalink?: string;
  pageUrl: string;
}

export interface DeadlineReminderResult {
  totalScanned: number;
  sentCount: number;
  skippedAlreadySent: number;
  skippedNotDue: number;
  failures: Array<{ owner: string; title: string; reason: string }>;
  sentDetails: Array<{ stage: Stage; owner: string; title: string; due: string }>;
  ranAt: string;
}

/** KST 자정 기준으로 due와 today의 일수 차이 계산 */
function calcStage(due: string, now: Date = new Date()): Stage | null {
  const todayKst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  todayKst.setUTCHours(0, 0, 0, 0);
  const dueKst = new Date(`${due}T00:00:00Z`);
  const diffDays = Math.round((dueKst.getTime() - todayKst.getTime()) / (24 * 60 * 60 * 1000));
  if (diffDays > 3) return null;
  if (diffDays === 3) return 'D-3';
  if (diffDays === 2) return null;     // D-2 skip
  if (diffDays === 1) return 'D-1';
  if (diffDays === 0) return '당일';
  return '지남';
}

function shouldSend(currentStage: Stage | null, newStage: Stage): boolean {
  if (!currentStage) return true;
  // newStage가 currentStage보다 진행됐을 때만 발송 (같거나 이전이면 skip)
  return STAGE_ORDER[newStage] > STAGE_ORDER[currentStage];
}

async function fetchActiveTasks(notion: NotionClient): Promise<TaskItem[]> {
  const items: TaskItem[] = [];
  let cursor: string | undefined;
  do {
    const resp = await notion.databases.query({
      database_id: TASK_DB_ID,
      filter: {
        and: [
          // 2026-05-17: Notion DB 마이그레이션으로 '상태' property type이 status → select로 변경됨.
          // 사용자 정책: '확정' + '진행중' 둘 다 마감 추적 — PI 검토 후 학생에게 배정된 시점부터
          // 학생 진행 여부와 무관하게 마감 임박 알림. (이전엔 '진행중'만 → 학생 미시작 task 모두 누락)
          {
            or: [
              { property: '상태', select: { equals: '확정' } },
              { property: '상태', select: { equals: '진행중' } },
            ],
          },
          { property: '마감일', date: { is_not_empty: true } },
        ],
      },
      page_size: 50,
      start_cursor: cursor,
    });
    for (const p of resp.results as any[]) {
      const props = p.properties || {};
      const title =
        props['제목']?.title?.[0]?.plain_text ||
        props['Name']?.title?.[0]?.plain_text ||
        '(제목 없음)';
      const due = props['마감일']?.date?.start as string | undefined;
      const ownerName =
        (props['담당자_한글이름']?.rich_text?.[0]?.plain_text as string | undefined) ||
        (props['담당자_한글이름']?.select?.name as string | undefined) ||
        '';
      const stage = (props['리마인더_단계']?.select?.name as Stage | undefined) || null;
      const type = props['종류']?.select?.name as string | undefined;
      const source = props['원채널']?.rich_text?.[0]?.plain_text as string | undefined;
      const slackPermalink =
        (props['Slack 링크']?.url as string | undefined) ||
        (props['slack_permalink']?.url as string | undefined) ||
        undefined;
      if (!due || !ownerName) continue;
      items.push({
        id: p.id,
        title,
        ownerName,
        due,
        currentStage: stage,
        type,
        source,
        slackPermalink,
        pageUrl: p.url,
      });
    }
    cursor = resp.has_more ? resp.next_cursor || undefined : undefined;
  } while (cursor);
  return items;
}

async function findOwnerEmail(ownerName: string): Promise<string | null> {
  const member = await prisma.labMember.findFirst({
    where: { name: ownerName, active: true },
    select: { email: true },
  });
  return member?.email || null;
}

function buildMessage(item: TaskItem, stage: Stage): string {
  const headers: Record<Stage, string> = {
    'D-3': '🔔 *마감 D-3 리마인더* (BLISS Lab)',
    'D-1': '⏰ *마감 D-1 — 내일까지* (BLISS Lab)',
    '당일': '🚨 *오늘 마감* (BLISS Lab)',
    '지남': '❗ *마감일 경과* (BLISS Lab)',
  };
  const dueLabels: Record<Stage, string> = {
    'D-3': '3일 남음',
    'D-1': '내일',
    '당일': '오늘!',
    '지남': calcOverdueDays(item.due),
  };
  const lines = [
    headers[stage],
    '',
    `*${item.title}*`,
    `• 마감일: ${item.due} (${dueLabels[stage]})`,
  ];
  if (item.type) lines.push(`• 종류: ${item.type}`);
  if (item.source) lines.push(`• 원채널: ${item.source}`);
  if (item.slackPermalink) lines.push(`🔗 ${item.slackPermalink}`);
  lines.push(`📋 Notion: ${item.pageUrl}`);
  if (stage === '지남') {
    lines.push('', '_완료/연장 여부를 교수님께 알려주세요._');
  }
  return lines.join('\n');
}

function calcOverdueDays(due: string): string {
  const todayKst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  todayKst.setUTCHours(0, 0, 0, 0);
  const dueKst = new Date(`${due}T00:00:00Z`);
  const diff = Math.round((todayKst.getTime() - dueKst.getTime()) / (24 * 60 * 60 * 1000));
  return `${diff}일 지남`;
}

async function updateReminderStage(notion: NotionClient, pageId: string, stage: Stage): Promise<void> {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      '리마인더_단계': { select: { name: stage } },
    } as any,
  });
}

/**
 * 마감일 리마인더 발송 메인 함수.
 * cron 또는 manual API endpoint에서 호출.
 */
export async function runDeadlineReminders(): Promise<DeadlineReminderResult> {
  const result: DeadlineReminderResult = {
    totalScanned: 0,
    sentCount: 0,
    skippedAlreadySent: 0,
    skippedNotDue: 0,
    failures: [],
    sentDetails: [],
    ranAt: new Date().toISOString(),
  };

  if (!env.NOTION_API_KEY) {
    throw new Error('NOTION_API_KEY 미설정 — Notion 조회 불가');
  }
  if (!env.SLACK_BOT_TOKEN) {
    throw new Error('SLACK_BOT_TOKEN 미설정 — Slack DM 불가');
  }

  const notion = createNotionClient(env.NOTION_API_KEY); // undici fetch — 'Premature close' 회피
  const tasks = await fetchActiveTasks(notion);
  result.totalScanned = tasks.length;

  for (const task of tasks) {
    const newStage = calcStage(task.due);
    if (!newStage) {
      result.skippedNotDue++;
      continue;
    }
    if (!shouldSend(task.currentStage, newStage)) {
      result.skippedAlreadySent++;
      continue;
    }

    try {
      const email = await findOwnerEmail(task.ownerName);
      if (!email) {
        result.failures.push({
          owner: task.ownerName,
          title: task.title,
          reason: '이메일 매핑 없음 (LabMember.email 비어있음)',
        });
        continue;
      }
      const slackUserId = await lookupSlackUserByEmail(email);
      if (!slackUserId) {
        result.failures.push({
          owner: task.ownerName,
          title: task.title,
          reason: `Slack users.lookupByEmail 실패 (email=${email})`,
        });
        continue;
      }
      const text = buildMessage(task, newStage);
      const slackResult = await postSlackMessage(slackUserId, text);
      const sent = slackResult.ok;
      if (!sent) {
        result.failures.push({
          owner: task.ownerName,
          title: task.title,
          reason: 'Slack chat.postMessage 실패',
        });
        continue;
      }
      await updateReminderStage(notion, task.id, newStage);
      result.sentDetails.push({
        stage: newStage,
        owner: task.ownerName,
        title: task.title,
        due: task.due,
      });
      result.sentCount++;
      // Notion + Slack rate limit 안전 페이스
      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (e: any) {
      result.failures.push({
        owner: task.ownerName,
        title: task.title,
        reason: e?.message || 'unknown',
      });
    }
  }

  console.log(
    `[deadline-reminder] scanned=${result.totalScanned} sent=${result.sentCount} ` +
    `skip(already)=${result.skippedAlreadySent} skip(notDue)=${result.skippedNotDue} ` +
    `failed=${result.failures.length}`,
  );
  return result;
}
