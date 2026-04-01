/**
 * 헬스체크 & 유틸리티 라우트
 */

import { FastifyInstance } from 'fastify';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';

export async function healthRoutes(app: FastifyInstance) {
  // ── GET / — 서버 정보 ─────────────────────────────
  app.get('/', async () => ({
    name: 'LabFlow API',
    version: '1.0.0',
    status: 'running',
    timestamp: new Date().toISOString(),
  }));

  // ── GET /health/auth — 인증 설정 상태 확인 ─────────
  app.get('/health/auth', async (request) => {
    const result: any = {
      supabaseConfigured: !!(env.SUPABASE_URL && env.SUPABASE_ANON_KEY),
      clerkConfigured: !!env.CLERK_SECRET_KEY,
      hasAuthHeader: !!request.headers.authorization,
      userId: request.userId || null,
    };

    // Bearer 토큰이 있으면 Supabase getUser로 검증
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ') && env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
      const token = authHeader.slice(7);
      try {
        const { createClient } = await import('@supabase/supabase-js');
        const sb = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
        const { data, error } = await sb.auth.getUser(token);
        result.jwtValid = !error;
        result.jwtSub = data.user?.id || null;
        result.jwtEmail = data.user?.email || null;
        if (error) result.jwtError = error.message;
      } catch (err: any) {
        result.jwtValid = false;
        result.jwtError = err.message;
      }
    }

    return result;
  });

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
