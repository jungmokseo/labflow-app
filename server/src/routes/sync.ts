/**
 * Sync routes — 외부 워커가 호출하는 server-to-server endpoint.
 *
 * 인증: X-Sync-Token 헤더 (env LABFLOW_SYNC_TOKEN). Bearer JWT 미사용.
 * authMiddleware를 거치지 않고 별도 plugin scope로 등록한다.
 *
 * 현재 endpoint:
 *  - POST /api/sync/bliss-task
 *      bliss-slack-worker가 BLISS Lab Notion `📝 연구실 할 일·요청 DB`의
 *      확정/진행중/완료 항목을 Capture 모델로 동기화한다.
 *      notionPageId 기반 idempotent upsert.
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { basePrismaClient as prisma } from '../config/prisma.js';
import { Priority } from '@prisma/client';

const blissTaskSchema = z.object({
  notionPageId: z.string().min(1),
  title: z.string().min(1),
  status: z.string(),                              // '확정' | '진행중' | '완료' | '보류' | '취소' | '검토대기'
  kind: z.string().optional(),                     // 'task' | 'request' | 'decision'
  dueDate: z.string().nullable().optional(),
  requester: z.string().optional(),
  assignee: z.string().optional(),
  channel: z.string().optional(),
  sourceUrl: z.string().nullable().optional(),
  originalMessage: z.string().optional(),
  ownerUserClerkId: z.string().optional(),         // 기본 = LAB_OWNER_CLERK_ID env
});

export async function syncRoutes(app: FastifyInstance) {
  // 이 plugin scope는 authMiddleware 미적용 (별도 등록).
  // 각 라우트 내부에서 X-Sync-Token 검증.

  app.post('/api/sync/bliss-task', async (request, reply) => {
    const syncToken = request.headers['x-sync-token'] as string | undefined;
    const expected = process.env.LABFLOW_SYNC_TOKEN;
    if (!expected) {
      return reply.code(503).send({ error: 'LABFLOW_SYNC_TOKEN not configured on server' });
    }
    if (!syncToken || syncToken !== expected) {
      return reply.code(401).send({ error: 'invalid sync token' });
    }

    const body = blissTaskSchema.parse(request.body);

    // owner User 결정 (서정목)
    const ownerClerkId = body.ownerUserClerkId || process.env.LAB_OWNER_CLERK_ID || 'dev-user-seo';
    let user = await prisma.user.findFirst({ where: { clerkId: ownerClerkId } });
    if (!user) {
      user = await prisma.user.create({
        data: {
          clerkId: ownerClerkId,
          email: process.env.LAB_OWNER_EMAIL || `${ownerClerkId}@labflow.app`,
          name: 'Jungmok Seo',
        },
      });
    }

    const completed = body.status === '완료' || body.status === '취소';
    const archived = body.status === '취소' || body.status === '보류';
    const statusStr = archived ? 'archived' : completed ? 'completed' : 'active';

    // 본문 컴포지션
    const lines: string[] = [body.title];
    if (body.requester) lines.push(`요청자: ${body.requester}`);
    if (body.assignee) lines.push(`담당자: ${body.assignee}`);
    if (body.channel) lines.push(`원채널: ${body.channel}`);
    if (body.dueDate) lines.push(`마감일: ${body.dueDate}`);
    if (body.originalMessage) lines.push('', body.originalMessage);
    if (body.sourceUrl) lines.push('', `Slack: ${body.sourceUrl}`);
    const content = lines.join('\n').slice(0, 5000);

    // priority 추정
    let priority: Priority = 'MEDIUM';
    if (body.dueDate) {
      const due = new Date(body.dueDate);
      const days = (due.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
      if (days <= 1) priority = 'HIGH';
      else if (days > 14) priority = 'LOW';
    }

    const tagSet = new Set<string>(['bliss-slack', 'notion-sync']);
    if (body.kind) tagSet.add(body.kind);
    if (body.channel) tagSet.add(body.channel);
    const tags = Array.from(tagSet);

    const metadata = {
      source: 'bliss-notion-sync',
      notionPageId: body.notionPageId,
      notionStatus: body.status,
      kind: body.kind,
      requester: body.requester,
      assignee: body.assignee,
      channel: body.channel,
      sourceUrl: body.sourceUrl,
      syncedAt: new Date().toISOString(),
    };

    const existing = await prisma.capture.findFirst({
      where: {
        userId: user.id,
        metadata: { path: ['notionPageId'], equals: body.notionPageId },
      },
    });

    let capture;
    let action: 'created' | 'updated';
    if (existing) {
      capture = await prisma.capture.update({
        where: { id: existing.id },
        data: {
          content,
          summary: body.title.slice(0, 200),
          category: 'TASK',
          tags,
          priority,
          actionDate: body.dueDate ? new Date(body.dueDate) : null,
          completed,
          completedAt: completed ? (existing.completedAt || new Date()) : null,
          status: statusStr,
          metadata,
        },
      });
      action = 'updated';
    } else {
      capture = await prisma.capture.create({
        data: {
          userId: user.id,
          content,
          summary: body.title.slice(0, 200),
          category: 'TASK',
          tags,
          priority,
          confidence: 1.0,
          actionDate: body.dueDate ? new Date(body.dueDate) : null,
          modelUsed: 'bliss-notion-sync',
          completed,
          completedAt: completed ? new Date() : null,
          status: statusStr,
          reviewed: true,
          metadata,
        },
      });
      action = 'created';
    }

    return reply.send({
      success: true,
      action,
      taskId: capture.id,
      notionPageId: body.notionPageId,
    });
  });
}
