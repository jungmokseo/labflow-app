/**
 * Wiki Routes — Karpathy 스타일 지식 위키 API
 *
 * GET    /api/wiki              → 위키 아티클 목록 (category 필터 가능)
 * GET    /api/wiki/status       → 위키 상태
 * GET    /api/wiki/:id          → 특정 아티클
 * POST   /api/wiki/ingest       → 수동 ingest 트리거 (OWNER만)
 * POST   /api/wiki/synthesis    → 수동 deep synthesis 트리거 (OWNER만)
 * DELETE /api/wiki/:id          → 아티클 삭제 (OWNER만)
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../config/prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { logError } from '../services/error-logger.js';
import { enqueueNewData, ingestAndCompile, deepSynthesis, getWikiStatus } from '../services/wiki-engine.js';

export async function wikiRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authMiddleware);

  // ── GET /api/wiki — 아티클 목록 ──────────────────────────
  app.get('/api/wiki', async (request: FastifyRequest, reply: FastifyReply) => {
    const labId = request.labId;
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
    const labId = request.labId;
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
    const labId = request.labId;
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
  app.post(
    '/api/wiki/ingest',
    { preHandler: requirePermission('OWNER') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const labId = request.labId;
      const userId = request.userId;
      if (!labId || !userId) return reply.code(400).send({ error: '연구실 또는 사용자 정보 없음' });

      try {
        const lab = await prisma.lab.findUnique({ where: { id: labId } });
        if (!lab) return reply.code(404).send({ error: '연구실을 찾을 수 없습니다' });

        const enqueued = await enqueueNewData(labId, userId);
        const result = await ingestAndCompile(labId);

        return reply.send({
          message: '위키 ingest 완료',
          enqueued,
          processed: result.processed,
          updated: result.updated,
        });
      } catch (err) {
        logError('background', 'POST /api/wiki/ingest 실패', { labId })(err);
        return reply.code(500).send({ error: '위키 ingest 실패' });
      }
    },
  );

  // ── POST /api/wiki/synthesis — 수동 synthesis 트리거 (OWNER만) ─
  app.post(
    '/api/wiki/synthesis',
    { preHandler: requirePermission('OWNER') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const labId = request.labId;
      if (!labId) return reply.code(400).send({ error: '연구실이 설정되지 않았습니다' });

      try {
        await deepSynthesis(labId);
        return reply.send({ message: 'Deep synthesis 완료' });
      } catch (err) {
        logError('background', 'POST /api/wiki/synthesis 실패', { labId })(err);
        return reply.code(500).send({ error: 'Deep synthesis 실패' });
      }
    },
  );

  // ── DELETE /api/wiki/:id — 아티클 삭제 (OWNER만) ─────────
  app.delete(
    '/api/wiki/:id',
    { preHandler: requirePermission('OWNER') },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const labId = request.labId;
      if (!labId) return reply.code(400).send({ error: '연구실이 설정되지 않았습니다' });

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
    },
  );
}
