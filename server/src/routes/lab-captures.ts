/**
 * Lab 기반 캡처 라우트 — 빠른 캡처 (메모/태스크/아이디어)
 *
 * POST   /api/lab/:labId/captures           — 텍스트 캡처 생성 (AI 자동분류)
 * POST   /api/lab/:labId/captures/voice      — 음성 캡처 (STT + 분류)
 * GET    /api/lab/:labId/captures            — 캡처 목록 조회 (필터/정렬)
 * PATCH  /api/lab/:labId/captures/:captureId — 캡처 상태 변경
 * DELETE /api/lab/:labId/captures/completed  — 완료된 캡처 일괄 삭제
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { Readable } from 'node:stream';
import { prisma } from '../config/prisma.js';
import { classifyCapture, typeToCategory, urgencyToPriority } from '../services/capture-classifier.js';
import { transcribeAndClassify } from '../services/voice-transcriber.js';
import { enqueueCaptureProcessing } from '../services/capture-queue.js';
import { authMiddleware } from '../middleware/auth.js';
import { CaptureCategory, Priority } from '@prisma/client';

// ── Zod 스키마 ──────────────────────────────────────
const createCaptureBody = z.object({
  content: z.string().min(1).max(5000),
});

const listCaptureQuery = z.object({
  type: z.enum(['idea', 'task', 'memo']).optional(),
  status: z.enum(['active', 'completed', 'archived']).optional(),
  tag: z.string().optional(),
  sort: z.enum(['newest', 'urgency', 'dueDate']).default('newest'),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(50),
});

const patchCaptureBody = z.object({
  status: z.enum(['active', 'completed', 'archived']).optional(),
  content: z.string().min(1).max(5000).optional(),
  tags: z.array(z.string()).optional(),
});

// ── 헬퍼: Lab 소유권 확인 ────────────────────────────────
async function findLabAndUser(labId: string, clerkId: string) {
  const user = await prisma.user.findFirst({ where: { clerkId } });
  if (!user) return null;

  const lab = await prisma.lab.findUnique({ where: { id: labId } });
  if (!lab || lab.ownerId !== user.id) return null;

  return { user, lab };
}

// ── 라우트 등록 ──────────────────────────────────────
export async function labCaptureRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // ── POST /api/lab/:labId/captures — 텍스트 캡처 생성 ──
  app.post('/api/lab/:labId/captures', async (request: FastifyRequest<{ Params: { labId: string } }>, reply: FastifyReply) => {
    const { labId } = request.params;
    const body = createCaptureBody.parse(request.body);
    const userId = request.userId!;

    const ctx = await findLabAndUser(labId, userId);
    if (!ctx) return reply.code(404).send({ error: 'Lab을 찾을 수 없거나 권한이 없습니다' });

    // Gemini Flash 자동 분류
    const classification = await classifyCapture(body.content);

    // DB 저장
    const capture = await prisma.capture.create({
      data: {
        userId: ctx.user.id,
        labId: ctx.lab.id,
        content: body.content,
        summary: classification.summary,
        category: typeToCategory(classification.type),
        tags: classification.tags,
        priority: urgencyToPriority(classification.urgency),
        confidence: classification.confidence,
        actionDate: classification.dueDate ? new Date(classification.dueDate) : null,
        modelUsed: 'gemini-flash',
        sourceType: 'text',
        status: 'active',
      },
    });

    // 비동기 L5 지식 그래프 추출 큐 발행
    enqueueCaptureProcessing({
      captureId: capture.id,
      labId: ctx.lab.id,
      userId: ctx.user.id,
      content: body.content,
      type: classification.type,
    });

    return reply.code(201).send({
      success: true,
      data: formatLabCapture(capture, classification),
    });
  });

  // ── POST /api/lab/:labId/captures/voice — 음성 캡처 ──
  app.post('/api/lab/:labId/captures/voice', async (request: FastifyRequest<{ Params: { labId: string } }>, reply: FastifyReply) => {
    const { labId } = request.params;
    const userId = request.userId!;

    const ctx = await findLabAndUser(labId, userId);
    if (!ctx) return reply.code(404).send({ error: 'Lab을 찾을 수 없거나 권한이 없습니다' });

    // multipart 오디오 파일 파싱
    const data = await request.file();
    if (!data) return reply.code(400).send({ error: '오디오 파일이 필요합니다' });

    const chunks: Buffer[] = [];
    for await (const chunk of data.file as unknown as Readable) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    const audioBuffer = Buffer.concat(chunks);

    if (audioBuffer.length === 0) return reply.code(400).send({ error: '빈 오디오 파일입니다' });
    if (audioBuffer.length > 5 * 1024 * 1024) return reply.code(413).send({ error: '오디오 파일이 너무 큽니다 (최대 5MB)' });

    const mimeType = data.mimetype || 'audio/webm';

    try {
      // Gemini로 전사(STT) + 분류
      const result = await transcribeAndClassify(audioBuffer, mimeType);
      if (!result.transcription) {
        return reply.code(422).send({ error: '음성을 인식할 수 없습니다. 다시 시도해주세요.' });
      }

      // DB 저장
      const capture = await prisma.capture.create({
        data: {
          userId: ctx.user.id,
          labId: ctx.lab.id,
          content: result.transcription,
          summary: result.summary,
          category: result.category as CaptureCategory,
          tags: result.tags,
          priority: result.priority as Priority,
          confidence: result.confidence,
          actionDate: result.actionDate ? new Date(result.actionDate) : null,
          modelUsed: result.modelUsed,
          sourceType: 'voice',
          rawInput: result.transcription,
          status: 'active',
        },
      });

      // 비동기 L5 추출
      enqueueCaptureProcessing({
        captureId: capture.id,
        labId: ctx.lab.id,
        userId: ctx.user.id,
        content: result.transcription,
        type: result.category.toLowerCase(),
      });

      return reply.code(201).send({
        success: true,
        data: {
          ...formatLabCapture(capture),
          transcription: result.transcription,
        },
      });
    } catch (error: any) {
      console.error('[LabCapture] 음성 캡처 실패:', error);
      return reply.code(500).send({ error: '음성 처리 중 오류가 발생했습니다' });
    }
  });

  // ── GET /api/lab/:labId/captures — 목록 조회 ──────────
  app.get('/api/lab/:labId/captures', async (request: FastifyRequest<{ Params: { labId: string } }>, reply: FastifyReply) => {
    const { labId } = request.params;
    const query = listCaptureQuery.parse(request.query);
    const userId = request.userId!;

    const ctx = await findLabAndUser(labId, userId);
    if (!ctx) return reply.code(404).send({ error: 'Lab을 찾을 수 없거나 권한이 없습니다' });

    // 필터 조건
    const where: any = { labId: ctx.lab.id };
    if (query.type) where.category = typeToCategory(query.type);
    if (query.status) {
      if (query.status === 'completed') {
        where.completed = true;
        where.status = 'completed';
      } else if (query.status === 'archived') {
        where.status = 'archived';
      } else {
        where.completed = false;
        where.status = 'active';
      }
    }
    if (query.tag) {
      where.tags = { has: query.tag };
    }

    // 정렬: 태스크는 긴급도순, 나머지는 최신순
    let orderBy: any[];
    switch (query.sort) {
      case 'urgency':
        // HIGH → MEDIUM → LOW, 그 다음 최신순
        orderBy = [{ priority: 'asc' }, { createdAt: 'desc' }];
        break;
      case 'dueDate':
        orderBy = [{ actionDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }];
        break;
      default: // newest
        orderBy = [{ createdAt: 'desc' }];
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

    // 카테고리별 통계
    const counts = await prisma.capture.groupBy({
      by: ['category'],
      where: { labId: ctx.lab.id, status: 'active' },
      _count: true,
    });

    // 긴급도 색상 매핑
    const urgencyColors: Record<string, string> = {
      HIGH: '#EF4444',    // 빨강
      MEDIUM: '#F97316',  // 주황
      LOW: '#3B82F6',     // 파랑
    };

    return reply.send({
      success: true,
      data: captures.map((c: any) => ({
        ...formatLabCapture(c),
        urgencyColor: c.category === 'TASK' ? urgencyColors[c.priority] || '#3B82F6' : null,
      })),
      meta: {
        total,
        page: query.page,
        limit: query.limit,
        totalPages: Math.ceil(total / query.limit),
        counts: {
          all: total,
          idea: counts.find((c: any) => c.category === 'IDEA')?._count || 0,
          task: counts.find((c: any) => c.category === 'TASK')?._count || 0,
          memo: counts.find((c: any) => c.category === 'MEMO')?._count || 0,
        },
      },
    });
  });

  // ── PATCH /api/lab/:labId/captures/:captureId — 상태 변경 ──
  app.patch('/api/lab/:labId/captures/:captureId', async (
    request: FastifyRequest<{ Params: { labId: string; captureId: string } }>,
    reply: FastifyReply,
  ) => {
    const { labId, captureId } = request.params;
    const body = patchCaptureBody.parse(request.body);
    const userId = request.userId!;

    const ctx = await findLabAndUser(labId, userId);
    if (!ctx) return reply.code(404).send({ error: 'Lab을 찾을 수 없거나 권한이 없습니다' });

    const existing = await prisma.capture.findFirst({
      where: { id: captureId, labId: ctx.lab.id },
    });
    if (!existing) return reply.code(404).send({ error: '캡처를 찾을 수 없습니다' });

    const updateData: any = {};
    if (body.status !== undefined) {
      updateData.status = body.status;
      if (body.status === 'completed') {
        updateData.completed = true;
        updateData.completedAt = new Date();
      } else if (body.status === 'active') {
        updateData.completed = false;
        updateData.completedAt = null;
      }
    }
    if (body.content !== undefined) updateData.content = body.content;
    if (body.tags !== undefined) updateData.tags = body.tags;

    const capture = await prisma.capture.update({
      where: { id: captureId },
      data: updateData,
    });

    return reply.send({ success: true, data: formatLabCapture(capture) });
  });

  // ── DELETE /api/lab/:labId/captures/completed — 완료 일괄 삭제 ──
  app.delete('/api/lab/:labId/captures/completed', async (
    request: FastifyRequest<{ Params: { labId: string } }>,
    reply: FastifyReply,
  ) => {
    const { labId } = request.params;
    const userId = request.userId!;

    const ctx = await findLabAndUser(labId, userId);
    if (!ctx) return reply.code(404).send({ error: 'Lab을 찾을 수 없거나 권한이 없습니다' });

    const result = await prisma.capture.deleteMany({
      where: { labId: ctx.lab.id, completed: true },
    });

    return reply.send({ success: true, deleted: result.count });
  });
}

// ── 응답 포매터 ──────────────────────────────────────
function formatLabCapture(capture: any, classification?: any) {
  return {
    id: capture.id,
    type: capture.category.toLowerCase(),
    content: capture.content,
    summary: capture.summary,
    tags: capture.tags,
    dueDate: capture.actionDate?.toISOString().split('T')[0] || null,
    urgency: capture.category === 'TASK'
      ? capture.priority.toLowerCase()
      : null,
    status: capture.status || (capture.completed ? 'completed' : 'active'),
    sourceType: capture.sourceType || 'text',
    confidence: capture.confidence,
    modelUsed: capture.modelUsed,
    createdAt: capture.createdAt.toISOString(),
    updatedAt: capture.updatedAt.toISOString(),
  };
}
