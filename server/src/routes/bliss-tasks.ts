import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Capture, Prisma, Priority } from '@prisma/client';
import { basePrismaClient as prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { authMiddleware } from '../middleware/auth.js';
import { notifyStudentTaskAssigned } from '../services/slack-notify.js';

const captureSchema = z.object({
  title: z.string().min(1).max(300),
  originalMessage: z.string().min(1).max(5000),
  requesterName: z.string().min(1).max(120),
  sourceChannel: z.string().min(1).max(120),
  slackPermalink: z.string().url().optional(),
  slackUserId: z.string().min(1).max(80).optional(),
});

const confirmSchema = z.object({
  actionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ownerName: z.string().min(1).max(120),
  priority: z.enum(['HIGH', 'MEDIUM', 'LOW']).optional(),
  memo: z.string().max(2000).optional(),
});

type BlissSource = {
  sourceChannel?: string;
  slackPermalink?: string;
  slackUserId?: string;
  requesterName?: string;
};

function jsonObject(value: Prisma.JsonValue | null | undefined): Prisma.JsonObject {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Prisma.JsonObject;
  }
  return {};
}

function getBlissSource(value: Prisma.JsonValue | null | undefined): BlissSource {
  const metadata = jsonObject(value);
  const source = metadata.blissSource;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  return source as BlissSource;
}

function parseDateOnly(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function appendMemo(content: string, memo?: string): string {
  const trimmed = memo?.trim();
  if (!trimmed) return content;
  return `${content}\n\n[교수 메모]\n${trimmed}`.slice(0, 5000);
}

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

  const lab = await prisma.lab.findFirst({
    where: { ownerId: user.id },
    select: { id: true },
  });

  return { user, labId: lab?.id ?? null };
}

function requireSyncToken(requestToken: string | undefined) {
  const expected = env.LABFLOW_SYNC_TOKEN;
  if (!expected) return { ok: false as const, status: 503, error: 'LABFLOW_SYNC_TOKEN not configured on server' };
  if (!requestToken || requestToken !== expected) return { ok: false as const, status: 401, error: 'invalid sync token' };
  return { ok: true as const };
}

function formatReviewItem(capture: Pick<Capture, 'id' | 'summary' | 'content' | 'metadata' | 'createdAt'>) {
  return {
    id: capture.id,
    title: capture.summary,
    content: capture.content,
    metadata: capture.metadata,
    createdAt: capture.createdAt,
  };
}

async function findReviewCapture(id: string, userId: string) {
  return prisma.capture.findFirst({
    where: {
      id,
      userId,
      category: 'TASK',
      status: 'active',
      metadata: { path: ['blissSource'], not: Prisma.JsonNull },
    },
  });
}

export async function blissTasksRoutes(app: FastifyInstance) {
  app.post('/api/bliss-tasks/captures', async (request, reply) => {
    const syncToken = request.headers['x-sync-token'] as string | undefined;
    const auth = requireSyncToken(syncToken);
    if (!auth.ok) return reply.code(auth.status).send({ error: auth.error });

    const body = captureSchema.parse(request.body);
    const { user, labId } = await resolveOwner();

    const capture = await prisma.capture.create({
      data: {
        userId: user.id,
        labId,
        content: body.originalMessage,
        summary: body.title.slice(0, 200),
        category: 'TASK',
        tags: ['bliss-slack', 'review-queue'],
        priority: 'MEDIUM',
        confidence: 1.0,
        modelUsed: 'bliss-task-capture',
        sourceType: 'slack',
        reviewed: false,
        status: 'active',
        metadata: {
          blissSource: {
            sourceChannel: body.sourceChannel,
            slackPermalink: body.slackPermalink,
            slackUserId: body.slackUserId,
            requesterName: body.requesterName,
          },
          capturedAt: new Date().toISOString(),
        },
      },
    });

    return reply.code(201).send({ success: true, captureId: capture.id });
  });

  app.get('/api/bliss-tasks/review-queue', { preHandler: authMiddleware }, async (request) => {
    const captures = await prisma.capture.findMany({
      where: {
        userId: request.userId!,
        reviewed: false,
        category: 'TASK',
        status: 'active',
        metadata: { path: ['blissSource'], not: Prisma.JsonNull },
      },
      select: {
        id: true,
        summary: true,
        content: true,
        metadata: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    return captures.map(formatReviewItem);
  });

  app.patch('/api/bliss-tasks/:id/confirm', { preHandler: authMiddleware }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = confirmSchema.parse(request.body);
    const capture = await findReviewCapture(id, request.userId!);
    if (!capture) return reply.code(404).send({ error: '검토 대기 항목을 찾을 수 없습니다' });

    const currentMetadata = jsonObject(capture.metadata);
    const blissSource = getBlissSource(capture.metadata);
    const actionDate = parseDateOnly(body.actionDate);
    const notificationAt = new Date().toISOString();

    await prisma.capture.update({
      where: { id: capture.id },
      data: {
        reviewed: true,
        actionDate,
        priority: (body.priority || capture.priority) as Priority,
        content: appendMemo(capture.content, body.memo),
        metadata: {
          ...currentMetadata,
          notifiedAt: notificationAt,
          assignedOwner: body.ownerName,
        },
      },
    });

    const notifyResult = await notifyStudentTaskAssigned({
      ownerName: body.ownerName,
      taskTitle: capture.summary,
      actionDate,
      slackPermalink: blissSource.slackPermalink,
      memo: body.memo,
    });

    return {
      success: true,
      notified: notifyResult.ok,
      ...(notifyResult.ok ? {} : { error: notifyResult.error }),
    };
  });

  app.patch('/api/bliss-tasks/:id/hold', { preHandler: authMiddleware }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const capture = await findReviewCapture(id, request.userId!);
    if (!capture) return reply.code(404).send({ error: '검토 대기 항목을 찾을 수 없습니다' });

    await prisma.capture.update({
      where: { id: capture.id },
      data: {
        metadata: {
          ...jsonObject(capture.metadata),
          heldAt: new Date().toISOString(),
        },
      },
    });

    return { success: true };
  });

  app.patch('/api/bliss-tasks/:id/archive', { preHandler: authMiddleware }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const capture = await findReviewCapture(id, request.userId!);
    if (!capture) return reply.code(404).send({ error: '검토 대기 항목을 찾을 수 없습니다' });

    await prisma.capture.update({
      where: { id: capture.id },
      data: { status: 'archived' },
    });

    return { success: true };
  });
}
