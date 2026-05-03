/**
 * 이메일 답장 대기 → Capture 자동 동기화.
 *
 * 'urgent' / 'action-needed' 카테고리 이메일을 /tasks 탭에 자동 등록 (TASK).
 * idempotency: messageId 기반 — 같은 messageId 이미 있으면 skip.
 *
 * 호출 시점: GET /api/email/briefing 또는 narrative-briefing 직후 (백그라운드).
 */

import { Prisma } from '@prisma/client';
import { basePrismaClient } from '../config/prisma.js';

export interface BriefingItemForSync {
  sender: string;
  senderName?: string;
  subject: string;
  summary?: string;
  category: string;
  messageId?: string;
  threadId?: string;
  date?: string;
}

const REPLY_NEEDED_CATEGORIES = new Set(['urgent', 'action-needed']);

export async function syncReplyNeededCaptures(
  userId: string,
  labId: string | null,
  briefings: BriefingItemForSync[],
): Promise<{ created: number; skipped: number }> {
  let created = 0;
  let skipped = 0;

  for (const b of briefings) {
    if (!REPLY_NEEDED_CATEGORIES.has(b.category)) continue;
    if (!b.messageId) continue;

    // idempotent — 같은 messageId면 skip (status 무관 — 이미 archive된 경우도 다시 만들지 않음)
    const existing = await basePrismaClient.capture.findFirst({
      where: {
        userId,
        sourceType: 'email',
        metadata: { path: ['emailMessageId'], equals: b.messageId },
      },
      select: { id: true },
    });
    if (existing) { skipped++; continue; }

    const isUrgent = b.category === 'urgent';
    const senderLabel = b.senderName || b.sender;
    const dateLabel = b.date ? ` · ${new Date(b.date).toLocaleDateString('ko-KR')}` : '';
    const content = [
      `[${isUrgent ? '긴급' : '대응'}] ${b.subject}`,
      `발신: ${senderLabel}${dateLabel}`,
      '',
      b.summary || '',
    ].join('\n').slice(0, 5000);

    try {
      await basePrismaClient.capture.create({
        data: {
          userId,
          labId,
          content,
          summary: `이메일 답장 대기: ${b.subject}`.slice(0, 200),
          category: 'TASK',
          tags: ['email', 'reply-needed', b.category],
          priority: isUrgent ? 'HIGH' : 'MEDIUM',
          confidence: 1.0,
          modelUsed: 'email-reply-sync',
          sourceType: 'email',
          reviewed: false,
          status: 'active',
          metadata: {
            emailMessageId: b.messageId,
            emailThreadId: b.threadId,
            emailSender: b.sender,
            emailSenderName: b.senderName,
            emailSubject: b.subject,
            emailCategory: b.category,
            emailDate: b.date,
            syncedAt: new Date().toISOString(),
          } as Prisma.InputJsonValue,
        },
      });
      created++;
    } catch (err: any) {
      console.warn('[email-capture-sync] 생성 실패:', err?.message);
    }
  }

  return { created, skipped };
}
