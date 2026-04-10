/**
 * Error Log Routes — 운영 에러 모니터링
 *
 * GET    /api/errors              → 에러 목록 (필터링: category, resolved, limit)
 * GET    /api/errors/summary      → 카테고리별 미해결 에러 수
 * PATCH  /api/errors/:id/resolve  → 에러 해결 처리
 * PATCH  /api/errors/resolve-all  → 특정 카테고리 전체 해결 처리
 * DELETE /api/errors/cleanup      → 30일 이상 된 해결 에러 삭제
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { basePrismaClient } from '../config/prisma.js';
import { authMiddleware } from '../middleware/auth.js';

export async function errorRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authMiddleware);

  // ── GET /api/errors — 에러 목록 ───────────────────
  app.get('/api/errors', async (request, reply) => {
    const query = request.query as Record<string, string>;
    const category = query.category || undefined;
    const resolved = query.resolved === 'true' ? true : query.resolved === 'false' ? false : undefined;
    const limit = Math.min(parseInt(query.limit || '100', 10), 500);
    const offset = parseInt(query.offset || '0', 10);

    const where: Record<string, unknown> = {};
    if (category) where.category = category;
    if (resolved !== undefined) where.resolved = resolved;

    const [errors, total] = await Promise.all([
      basePrismaClient.errorLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        select: {
          id: true,
          category: true,
          severity: true,
          message: true,
          context: true,
          resolved: true,
          resolvedAt: true,
          createdAt: true,
        },
      }),
      basePrismaClient.errorLog.count({ where }),
    ]);

    return reply.send({ errors, total, limit, offset });
  });

  // ── GET /api/errors/summary — 카테고리별 미해결 에러 수 ──
  app.get('/api/errors/summary', async (_request, reply) => {
    const results = await basePrismaClient.$queryRaw<
      Array<{ category: string; severity: string; count: bigint }>
    >`
      SELECT category, severity, COUNT(*)::bigint as count
      FROM error_logs
      WHERE resolved = false
      GROUP BY category, severity
      ORDER BY count DESC
    `;

    const summary = results.map(r => ({
      category: r.category,
      severity: r.severity,
      count: Number(r.count),
    }));

    const totalUnresolved = summary.reduce((acc, s) => acc + s.count, 0);

    return reply.send({ summary, totalUnresolved });
  });

  // ── PATCH /api/errors/:id/resolve — 단일 해결 처리 ──
  app.patch('/api/errors/:id/resolve', async (request, reply) => {
    const { id } = request.params as { id: string };

    await basePrismaClient.errorLog.update({
      where: { id },
      data: { resolved: true, resolvedAt: new Date() },
    });

    return reply.send({ success: true });
  });

  // ── PATCH /api/errors/resolve-all — 카테고리 전체 해결 ──
  app.patch('/api/errors/resolve-all', async (request, reply) => {
    const body = request.body as { category?: string };
    const where: Record<string, unknown> = { resolved: false };
    if (body.category) where.category = body.category;

    const { count } = await basePrismaClient.errorLog.updateMany({
      where,
      data: { resolved: true, resolvedAt: new Date() },
    });

    return reply.send({ success: true, resolvedCount: count });
  });

  // ── DELETE /api/errors/cleanup — 오래된 해결 에러 정리 ──
  app.delete('/api/errors/cleanup', async (_request, reply) => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const { count } = await basePrismaClient.errorLog.deleteMany({
      where: {
        resolved: true,
        resolvedAt: { lt: thirtyDaysAgo },
      },
    });

    return reply.send({ success: true, deletedCount: count });
  });
}
