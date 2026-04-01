/**
 * 캡처 CRUD API 라우트
 *
 * POST   /api/captures          — 새 캡처 생성 (AI 자동분류)
 * GET    /api/captures          — 캡처 목록 조회 (필터/정렬/페이지네이션)
 * GET    /api/captures/:id      — 단일 캡처 조회
 * PATCH  /api/captures/:id      — 캡처 수정 (카테고리 변경, 완료 토글 등)
 * DELETE /api/captures/:id      — 캡처 삭제
 * DELETE /api/captures/completed — 완료된 캡처 일괄 삭제
 * POST   /api/captures/classify — AI 분류만 (저장 없이)
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Readable } from 'node:stream';
import { prisma } from '../config/prisma.js';
import { classify } from '../services/gemini-classifier.js';
import { transcribeAndClassify } from '../services/voice-transcriber.js';
import { authMiddleware } from '../middleware/auth.js';
import { CaptureCategory, Priority, Prisma } from '@prisma/client';

// ── Zod 스키마 ──────────────────────────────────────
const createCaptureSchema = z.object({
  content: z.string().min(1).max(5000),
  useAI: z.boolean().default(true),
  // 수동 오버라이드 (선택)
  category: z.enum(['IDEA', 'TASK', 'MEMO']).optional(),
  tags: z.array(z.string()).optional(),
});

const updateCaptureSchema = z.object({
  content: z.string().min(1).max(5000).optional(),
  category: z.enum(['IDEA', 'TASK', 'MEMO']).optional(),
  tags: z.array(z.string()).optional(),
  priority: z.enum(['HIGH', 'MEDIUM', 'LOW']).optional(),
  completed: z.boolean().optional(),
  actionDate: z.string().nullable().optional(),
  reviewed: z.boolean().optional(),
});

const listQuerySchema = z.object({
  category: z.enum(['IDEA', 'TASK', 'MEMO']).optional(),
  completed: z.enum(['true', 'false']).optional(),
  sort: z.enum(['oldest', 'newest', 'dueDate']).default('newest'),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(50),
  search: z.string().optional(),
});

const classifyOnlySchema = z.object({
  content: z.string().min(1).max(5000),
});

// ── 라우트 등록 ──────────────────────────────────────
export async function captureRoutes(app: FastifyInstance) {
  // 모든 캡처 라우트에 인증 적용
  app.addHook('preHandler', authMiddleware);

  // ── POST /api/captures — 새 캡처 생성 ──────────────
  app.post('/api/captures', async (request, reply) => {
    const body = createCaptureSchema.parse(request.body);
    const userId = request.userId!;

    // 사용자 확인/생성 (첫 요청 시 자동 생성)
    let user = await prisma.user.findFirst({ where: { id: userId } });
    if (!user) {
      user = await prisma.user.create({
        data: {
          clerkId: userId,
          email: `${userId}@dev.labflow.app`,
          name: 'Dev User',
        },
      });
    }

    // AI 분류
    let classification;
    if (body.category) {
      // 수동 카테고리 지정 시 AI 생략
      classification = {
        category: body.category as CaptureCategory,
        confidence: 1.0,
        summary: body.content.substring(0, 50),
        tags: body.tags || [],
        actionDate: null,
        priority: 'MEDIUM' as Priority,
        modelUsed: 'manual',
      };
    } else {
      // AI 자동분류
      classification = await classify(body.content, body.useAI);
    }

    // DB 저장
    const capture = await prisma.capture.create({
      data: {
        userId: user.id,
        content: body.content,
        summary: classification.summary,
        category: classification.category as CaptureCategory,
        tags: classification.tags,
        priority: classification.priority as Priority,
        confidence: classification.confidence,
        actionDate: classification.actionDate ? new Date(classification.actionDate) : null,
        modelUsed: classification.modelUsed,
      },
    });

    return reply.code(201).send({
      success: true,
      data: formatCapture(capture),
    });
  });

  // ── GET /api/captures — 목록 조회 ──────────────────
  app.get('/api/captures', async (request, reply) => {
    const query = listQuerySchema.parse(request.query);
    const userId = request.userId!;

    const user = await prisma.user.findFirst({ where: { id: userId } });
    if (!user) {
      return reply.send({ success: true, data: [], meta: { total: 0, page: 1, limit: query.limit } });
    }

    // 필터 조건
    const where: Prisma.CaptureWhereInput = { userId: user.id };
    if (query.category) where.category = query.category as CaptureCategory;
    if (query.completed) where.completed = query.completed === 'true';
    if (query.search) {
      where.OR = [
        { content: { contains: query.search, mode: 'insensitive' } },
        { summary: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    // 정렬
    let orderBy: Prisma.CaptureOrderByWithRelationInput[];
    switch (query.sort) {
      case 'oldest':
        orderBy = [{ completed: 'asc' }, { createdAt: 'asc' }];
        break;
      case 'dueDate':
        orderBy = [{ completed: 'asc' }, { actionDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }];
        break;
      default: // newest
        orderBy = [{ completed: 'asc' }, { createdAt: 'desc' }];
    }

    const [captures, total] = await Promise.all([
      prisma.capture.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      prisma.capture.count({ where }),
    ]);

    // 카운트 통계
    const counts = await prisma.capture.groupBy({
      by: ['category'],
      where: { userId: user.id },
      _count: true,
    });

    const taskStats = await prisma.capture.groupBy({
      by: ['completed'],
      where: { userId: user.id, category: 'TASK' },
      _count: true,
    });

    return reply.send({
      success: true,
      data: captures.map(formatCapture),
      meta: {
        total,
        page: query.page,
        limit: query.limit,
        totalPages: Math.ceil(total / query.limit),
        counts: {
          all: total,
          idea: counts.find(c => c.category === 'IDEA')?._count || 0,
          task: counts.find(c => c.category === 'TASK')?._count || 0,
          memo: counts.find(c => c.category === 'MEMO')?._count || 0,
        },
        taskStats: {
          total: taskStats.reduce((sum, t) => sum + t._count, 0),
          completed: taskStats.find(t => t.completed)?._count || 0,
          pending: taskStats.find(t => !t.completed)?._count || 0,
        },
      },
    });
  });

  // ── GET /api/captures/:id — 단일 조회 ──────────────
  app.get('/api/captures/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.userId!;

    const user = await prisma.user.findFirst({ where: { id: userId } });
    if (!user) return reply.code(404).send({ error: '사용자를 찾을 수 없습니다' });

    const capture = await prisma.capture.findFirst({
      where: { id, userId: user.id },
    });

    if (!capture) {
      return reply.code(404).send({ error: '캡처를 찾을 수 없습니다' });
    }

    return reply.send({ success: true, data: formatCapture(capture) });
  });

  // ── PATCH /api/captures/:id — 수정 ────────────────
  app.patch('/api/captures/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = updateCaptureSchema.parse(request.body);
    const userId = request.userId!;

    const user = await prisma.user.findFirst({ where: { id: userId } });
    if (!user) return reply.code(404).send({ error: '사용자를 찾을 수 없습니다' });

    // 소유권 확인
    const existing = await prisma.capture.findFirst({ where: { id, userId: user.id } });
    if (!existing) {
      return reply.code(404).send({ error: '캡처를 찾을 수 없습니다' });
    }

    // 업데이트 데이터 구성
    const updateData: any = {};
    if (body.content !== undefined) updateData.content = body.content;
    if (body.category !== undefined) updateData.category = body.category as CaptureCategory;
    if (body.tags !== undefined) updateData.tags = body.tags;
    if (body.priority !== undefined) updateData.priority = body.priority as Priority;
    if (body.actionDate !== undefined) {
      updateData.actionDate = body.actionDate ? new Date(body.actionDate) : null;
    }
    if (body.completed !== undefined) {
      updateData.completed = body.completed;
      updateData.completedAt = body.completed ? new Date() : null;
    }
    if (body.reviewed !== undefined) updateData.reviewed = body.reviewed;

    const capture = await prisma.capture.update({
      where: { id },
      data: updateData,
    });

    return reply.send({ success: true, data: formatCapture(capture) });
  });

  // ── DELETE /api/captures/completed — 완료 일괄 삭제 ─
  app.delete('/api/captures/completed', async (request, reply) => {
    const userId = request.userId!;
    const user = await prisma.user.findFirst({ where: { id: userId } });
    if (!user) return reply.code(404).send({ error: '사용자를 찾을 수 없습니다' });

    const result = await prisma.capture.deleteMany({
      where: { userId: user.id, completed: true },
    });

    return reply.send({ success: true, deleted: result.count });
  });

  // ── DELETE /api/captures/:id — 단일 삭제 ───────────
  app.delete('/api/captures/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.userId!;

    const user = await prisma.user.findFirst({ where: { id: userId } });
    if (!user) return reply.code(404).send({ error: '사용자를 찾을 수 없습니다' });

    const existing = await prisma.capture.findFirst({ where: { id, userId: user.id } });
    if (!existing) {
      return reply.code(404).send({ error: '캡처를 찾을 수 없습니다' });
    }

    await prisma.capture.delete({ where: { id } });
    return reply.send({ success: true });
  });

  // ── POST /api/captures/classify — AI 분류만 ────────
  app.post('/api/captures/classify', async (request, reply) => {
    const body = classifyOnlySchema.parse(request.body);
    const result = await classify(body.content, true);
    return reply.send({ success: true, data: result });
  });

  // ── POST /api/captures/voice — 음성 캡처 (전사+분류+저장) ─
  app.post('/api/captures/voice', async (request, reply) => {
    const userId = request.userId!;

    // 사용자 찾기/생성
    let user = await prisma.user.findFirst({ where: { id: userId } });
    if (!user) {
      user = await prisma.user.create({
        data: { clerkId: userId, email: `${userId}@dev.labflow.ai` },
      });
    }

    // multipart 데이터 파싱
    const data = await request.file();
    if (!data) {
      return reply.code(400).send({ error: '오디오 파일이 필요합니다' });
    }

    // 오디오 버퍼로 읽기
    const chunks: Buffer[] = [];
    for await (const chunk of data.file as unknown as Readable) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    const audioBuffer = Buffer.concat(chunks);

    if (audioBuffer.length === 0) {
      return reply.code(400).send({ error: '빈 오디오 파일입니다' });
    }

    // 5MB 제한
    if (audioBuffer.length > 5 * 1024 * 1024) {
      return reply.code(413).send({ error: '오디오 파일이 너무 큽니다 (최대 5MB)' });
    }

    const mimeType = data.mimetype || 'audio/webm';

    try {
      // Gemini로 전사 + 분류
      const result = await transcribeAndClassify(audioBuffer, mimeType);

      if (!result.transcription) {
        return reply.code(422).send({ error: '음성을 인식할 수 없습니다. 다시 시도해주세요.' });
      }

      // DB에 저장
      const capture = await prisma.capture.create({
        data: {
          userId: user.id,
          content: result.transcription,
          summary: result.summary,
          category: result.category as CaptureCategory,
          tags: result.tags,
          priority: result.priority as Priority,
          confidence: result.confidence,
          actionDate: result.actionDate ? new Date(result.actionDate) : null,
          modelUsed: result.modelUsed,
        },
      });

      return reply.code(201).send({
        success: true,
        data: {
          ...formatCapture(capture),
          transcription: result.transcription,
        },
      });
    } catch (error: any) {
      console.error('🎤 음성 캡처 실패:', error);
      return reply.code(500).send({
        error: '음성 처리 중 오류가 발생했습니다',
        details: error.message,
      });
    }
  });

  // ── POST /api/captures/voice/transcribe — 전사만 (저장 없이) ─
  app.post('/api/captures/voice/transcribe', async (request, reply) => {
    const data = await request.file();
    if (!data) {
      return reply.code(400).send({ error: '오디오 파일이 필요합니다' });
    }

    const chunks: Buffer[] = [];
    for await (const chunk of data.file as unknown as Readable) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    const audioBuffer = Buffer.concat(chunks);
    const mimeType = data.mimetype || 'audio/webm';

    try {
      const result = await transcribeAndClassify(audioBuffer, mimeType);
      return reply.send({
        success: true,
        data: {
          transcription: result.transcription,
          classification: {
            category: result.category,
            confidence: result.confidence,
            summary: result.summary,
            tags: result.tags,
            actionDate: result.actionDate,
            priority: result.priority,
          },
        },
      });
    } catch (error: any) {
      console.error('🎤 음성 전사 실패:', error);
      return reply.code(500).send({ error: '음성 전사 중 오류가 발생했습니다' });
    }
  });
}

// ── 응답 포매터 ──────────────────────────────────────
function formatCapture(capture: any) {
  return {
    id: capture.id,
    content: capture.content,
    summary: capture.summary,
    category: capture.category.toLowerCase(),
    tags: capture.tags,
    priority: capture.priority.toLowerCase(),
    confidence: capture.confidence,
    actionDate: capture.actionDate?.toISOString().split('T')[0] || null,
    modelUsed: capture.modelUsed,
    completed: capture.completed,
    completedAt: capture.completedAt?.toISOString() || null,
    status: capture.status || 'active',
    reviewed: capture.reviewed ?? false,
    sourceType: capture.sourceType || 'text',
    createdAt: capture.createdAt.toISOString(),
    updatedAt: capture.updatedAt.toISOString(),
  };
}
