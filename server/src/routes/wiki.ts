/**
 * Wiki Routes — Karpathy 스타일 지식 위키 API
 *
 * GET    /api/wiki              → 위키 아티클 목록 (category 필터 가능)
 * GET    /api/wiki/status       → 위키 상태
 * GET    /api/wiki/:id          → 특정 아티클
 * POST   /api/wiki/ingest       → 수동 ingest 트리거 (OWNER만)
 * POST   /api/wiki/synthesis    → 수동 deep synthesis 트리거 (OWNER만)
 * PUT    /api/wiki/:id          → 아티클 수정 (OWNER만)
 * DELETE /api/wiki/:id          → 아티클 삭제 (OWNER만)
 *
 * NOTE: requirePermission preHandler 사용 금지 — request.labId 미설정 타이밍 버그.
 *       대신 resolveLabId(userId) 후 직접 owner 체크.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../config/prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import { logError } from '../services/error-logger.js';
import { enqueueNewData, ingestAndCompile, deepSynthesis, getWikiStatus } from '../services/wiki-engine.js';

/** userId로 lab을 조회 (owner 우선, 그 다음 member) */
async function resolveLabId(userId: string): Promise<string | null> {
  const owned = await prisma.lab.findFirst({ where: { ownerId: userId }, select: { id: true } });
  if (owned) return owned.id;
  const membership = await prisma.labMember.findFirst({
    where: { userId, active: true },
    select: { labId: true },
  });
  return membership?.labId ?? null;
}

/** userId가 labId의 owner인지 확인 */
async function isLabOwner(userId: string, labId: string): Promise<boolean> {
  const lab = await prisma.lab.findFirst({ where: { id: labId, ownerId: userId }, select: { id: true } });
  return !!lab;
}

export async function wikiRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authMiddleware);

  // ── GET /api/wiki — 아티클 목록 ──────────────────────────
  app.get('/api/wiki', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId!;
    const labId = await resolveLabId(userId);
    if (!labId) return reply.code(400).send({ error: '연구실이 설정되지 않았습니다' });

    const query = request.query as Record<string, string>;
    const category = query.category;
    const limit = Math.min(parseInt(query.limit || '50', 10), 200);

    try {
      const articles = await prisma.wikiArticle.findMany({
        where: {
          labId,
          ...(category ? { category } : {}),
        },
        select: {
          id: true,
          title: true,
          category: true,
          tags: true,
          version: true,
          sources: true,
          updatedAt: true,
          createdAt: true,
        },
        orderBy: { updatedAt: 'desc' },
        take: limit,
      });

      return reply.send({ articles, total: articles.length });
    } catch (err) {
      logError('background', 'GET /api/wiki 실패', { labId })(err);
      return reply.code(500).send({ error: '위키 목록 조회 실패' });
    }
  });

  // ── GET /api/wiki/status — 위키 상태 ─────────────────────
  app.get('/api/wiki/status', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId!;
    const labId = await resolveLabId(userId);
    if (!labId) return reply.code(400).send({ error: '연구실이 설정되지 않았습니다' });

    try {
      const status = await getWikiStatus(labId);
      return reply.send(status);
    } catch (err) {
      logError('background', 'GET /api/wiki/status 실패', { labId })(err);
      return reply.code(500).send({ error: '위키 상태 조회 실패' });
    }
  });

  // ── GET /api/wiki/:id — 특정 아티클 ─────────────────────
  app.get('/api/wiki/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId!;
    const labId = await resolveLabId(userId);
    if (!labId) return reply.code(400).send({ error: '연구실이 설정되지 않았습니다' });

    const { id } = request.params as { id: string };

    try {
      const article = await prisma.wikiArticle.findFirst({
        where: { id, labId },
      });

      if (!article) return reply.code(404).send({ error: '아티클을 찾을 수 없습니다' });
      return reply.send(article);
    } catch (err) {
      logError('background', 'GET /api/wiki/:id 실패', { labId })(err);
      return reply.code(500).send({ error: '아티클 조회 실패' });
    }
  });

  // ── POST /api/wiki/ingest — 수동 ingest 트리거 (OWNER만) ─
  // 즉시 202 반환 후 백그라운드에서 처리 (Vercel 30s proxy 타임아웃 우회)
  app.post('/api/wiki/ingest', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId!;
    const labId = await resolveLabId(userId);
    if (!labId) return reply.code(400).send({ error: '연구실이 설정되지 않았습니다' });

    if (!(await isLabOwner(userId, labId))) {
      return reply.code(403).send({ error: 'OWNER 권한이 필요합니다' });
    }

    // 즉시 응답 — 백그라운드에서 실제 처리
    reply.code(202).send({ message: 'Ingest 시작됨', status: 'processing' });

    // 백그라운드 처리 (응답과 무관하게 실행)
    setImmediate(async () => {
      try {
        const enqueued = await enqueueNewData(labId, userId);
        console.log(`[wiki] enqueued ${enqueued} items for labId ${labId}`);

        let rounds = 0;
        const maxRounds = 10;
        while (rounds < maxRounds) {
          const result = await ingestAndCompile(labId, userId);
          console.log(`[wiki] round ${rounds + 1}: processed ${result.processed}, updated ${result.updated.length}`);
          rounds++;
          if (result.processed === 0) break;
        }
        console.log(`[wiki] ingest complete after ${rounds} rounds`);
      } catch (err) {
        logError('background', '[wiki] background ingest 실패', { labId })(err);
      }
    });
  });

  // ── POST /api/wiki/synthesis — 수동 synthesis 트리거 (OWNER만) ─
  // 즉시 202 반환 후 백그라운드에서 처리 (Vercel 30s proxy 타임아웃 우회)
  app.post('/api/wiki/synthesis', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId!;
    const labId = await resolveLabId(userId);
    if (!labId) return reply.code(400).send({ error: '연구실이 설정되지 않았습니다' });

    if (!(await isLabOwner(userId, labId))) {
      return reply.code(403).send({ error: 'OWNER 권한이 필요합니다' });
    }

    reply.code(202).send({ message: 'Deep synthesis 시작됨', status: 'processing' });

    setImmediate(async () => {
      try {
        await deepSynthesis(labId);
        console.log('[wiki] deepSynthesis complete');
      } catch (err) {
        logError('background', '[wiki] background deepSynthesis 실패', { labId })(err);
      }
    });
  });

  // ── PUT /api/wiki/:id — 아티클 수정 (OWNER만) ───────────
  app.put('/api/wiki/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId!;
    const labId = await resolveLabId(userId);
    if (!labId) return reply.code(400).send({ error: '연구실이 설정되지 않았습니다' });

    if (!(await isLabOwner(userId, labId))) {
      return reply.code(403).send({ error: 'OWNER 권한이 필요합니다' });
    }

    const { id } = request.params as { id: string };
    const body = request.body as { title?: string; category?: string; content?: string; tags?: string[] };

    try {
      const article = await prisma.wikiArticle.findFirst({ where: { id, labId } });
      if (!article) return reply.code(404).send({ error: '아티클을 찾을 수 없습니다' });

      const updated = await prisma.wikiArticle.update({
        where: { id },
        data: {
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.category !== undefined ? { category: body.category } : {}),
          ...(body.content !== undefined ? { content: body.content } : {}),
          ...(body.tags !== undefined ? { tags: body.tags } : {}),
          version: { increment: 1 },
        },
      });
      return reply.send(updated);
    } catch (err) {
      logError('background', 'PUT /api/wiki/:id 실패', { labId })(err);
      return reply.code(500).send({ error: '아티클 수정 실패' });
    }
  });

  // ── DELETE /api/wiki/:id — 아티클 삭제 (OWNER만) ─────────
  app.delete('/api/wiki/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId!;
    const labId = await resolveLabId(userId);
    if (!labId) return reply.code(400).send({ error: '연구실이 설정되지 않았습니다' });

    if (!(await isLabOwner(userId, labId))) {
      return reply.code(403).send({ error: 'OWNER 권한이 필요합니다' });
    }

    const { id } = request.params as { id: string };

    try {
      const article = await prisma.wikiArticle.findFirst({ where: { id, labId } });
      if (!article) return reply.code(404).send({ error: '아티클을 찾을 수 없습니다' });

      await prisma.wikiArticle.delete({ where: { id } });
      return reply.send({ message: '아티클 삭제 완료', id });
    } catch (err) {
      logError('background', 'DELETE /api/wiki/:id 실패', { labId })(err);
      return reply.code(500).send({ error: '아티클 삭제 실패' });
    }
  });
}
