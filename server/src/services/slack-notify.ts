import { basePrismaClient as prisma } from '../config/prisma.js';
import { env } from '../config/env.js';

type SlackLookupResponse = {
  ok: boolean;
  user?: { id?: string };
  error?: string;
};

type SlackPostMessageResponse = {
  ok: boolean;
  error?: string;
};

function formatDate(date: Date | null): string {
  if (!date) return '없음';
  return date.toISOString().slice(0, 10);
}

function slackMessage(input: {
  taskTitle: string;
  actionDate: Date | null;
  slackPermalink?: string;
  memo?: string;
}): string {
  const lines = [
    '📌 *새 할 일 배정됨*',
    '',
    `*${input.taskTitle}*`,
    `• 마감일: ${formatDate(input.actionDate)}`,
  ];

  if (input.memo?.trim()) {
    lines.push(`• 메모: ${input.memo.trim()}`);
  }

  lines.push('', `원본: ${input.slackPermalink || '없음'}`);
  return lines.join('\n');
}

async function callSlack<T>(path: string, token: string, init: RequestInit): Promise<T> {
  const res = await fetch(`https://slack.com/api/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
      ...(init.headers || {}),
    },
  });

  if (!res.ok) {
    throw new Error(`Slack HTTP ${res.status}`);
  }

  return res.json() as Promise<T>;
}

export async function notifyStudentTaskAssigned(input: {
  ownerName: string;
  taskTitle: string;
  actionDate: Date | null;
  slackPermalink?: string;
  memo?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const token = env.SLACK_BOT_TOKEN;
  if (!token) {
    return { ok: false, error: 'SLACK_BOT_TOKEN is not configured' };
  }
  if (!env.LAB_ID) {
    return { ok: false, error: 'LAB_ID is not configured' };
  }

  try {
    const member = await prisma.labMember.findFirst({
      where: {
        labId: env.LAB_ID,
        active: true,
        OR: [
          { name: input.ownerName },
          { nameEn: input.ownerName },
        ],
      },
      select: { email: true, name: true },
    });

    if (!member?.email) {
      return { ok: false, error: `No active lab member email found for ${input.ownerName}` };
    }

    const lookup = await callSlack<SlackLookupResponse>(
      `users.lookupByEmail?email=${encodeURIComponent(member.email)}`,
      token,
      { method: 'GET' },
    );

    if (!lookup.ok || !lookup.user?.id) {
      return { ok: false, error: lookup.error || `Slack user not found for ${member.email}` };
    }

    const posted = await callSlack<SlackPostMessageResponse>('chat.postMessage', token, {
      method: 'POST',
      body: JSON.stringify({
        channel: lookup.user.id,
        text: slackMessage(input),
        unfurl_links: false,
        unfurl_media: false,
      }),
    });

    if (!posted.ok) {
      return { ok: false, error: posted.error || 'Slack chat.postMessage failed' };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Unknown Slack error' };
  }
}
