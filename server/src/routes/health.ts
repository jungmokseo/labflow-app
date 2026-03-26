/**
 * 헬스체크 & 유틸리티 라우트
 */

import { FastifyInstance } from 'fastify';
import { prisma } from '../config/prisma.js';

export async function healthRoutes(app: FastifyInstance) {
  // ── GET / — 서버 정보 ─────────────────────────────
  app.get('/', async () => ({
    name: 'LabFlow API',
    version: '1.0.0',
    status: 'running',
    timestamp: new Date().toISOString(),
  }));

  // ── GET /health — DB 연결 확인 ────────────────────
  app.get('/health', async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'healthy', database: 'connected' };
    } catch (error) {
      return reply.code(503).send({
        status: 'unhealthy',
        database: 'disconnected',
        error: String(error),
      });
    }
  });
}
