/**
 * LabFlow API Server
 *
 * Fastify + Prisma + Supabase PostgreSQL + Gemini Flash
 * 캡처 CRUD, AI 자동분류, Clerk 인증 (준비됨)
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import sensible from '@fastify/sensible';
import { env } from './config/env.js';
import { healthRoutes } from './routes/health.js';
import { captureRoutes } from './routes/captures.js';
import { emailCallbackRoute, emailRoutes } from './routes/email.js';
import { meetingRoutes } from './routes/meetings.js';
import { voiceChatbotRoutes } from './routes/voice-chatbot.js';

async function buildApp() {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === 'development' ? 'info' : 'warn',
      transport: env.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
    },
  });

  // ── 플러그인 ──────────────────────────────────────────
  await app.register(cors, {
    origin: env.CORS_ORIGINS.split(',').map(s => s.trim()),
    credentials: true,
  });
  await app.register(multipart, {
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB 오디오 제한
  });
  await app.register(sensible);

  // ── 글로벌 에러 핸들링 ────────────────────────────
  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    // Zod 유효성 검증 에러
    if (error.name === 'ZodError') {
      return reply.code(400).send({
        error: '입력값이 올바르지 않습니다',
        details: JSON.parse(error.message),
      });
    }

    // 그 외 에러
    app.log.error(error);
    return reply.code(error.statusCode ?? 500).send({
      error: error.message || '서버 오류가 발생했습니다',
    });
  });

  // ── 라우트 등록 ────────────────────────────────────────
  await app.register(healthRoutes);
  await app.register(captureRoutes);
  await app.register(emailCallbackRoute);  // auth 없는 OAuth 콜백 (반드시 emailRoutes보다 먼저)
  await app.register(emailRoutes);
  await app.register(meetingRoutes);
  await app.register(voiceChatbotRoutes);

  return app;
}

// ── 서버 시작 ──────────────────────────────────────────
async function start() {
  try {
    const app = await buildApp();
    await app.listen({ port: env.PORT, host: env.HOST });

    console.log(`
╔═══════════════════════════════════════════════╗
║           🧪 LabFlow API Server               ║
╠═══════════════════════════════════════════════╣
║  URL:    http://${env.HOST}:${env.PORT}              ║
║  Env:    ${env.NODE_ENV.padEnd(36)}║
║  Gemini: ✅ Connected                         ║
║  Auth:   ${env.CLERK_SECRET_KEY ? '✅ Clerk' : '⚠️  Dev mode (no Clerk)'}${''.padEnd(env.CLERK_SECRET_KEY ? 24 : 14)}║
╚═══════════════════════════════════════════════╝
    `);
  } catch (err) {
    console.error('❌ 서버 시작 실패:', err);
    process.exit(1);
  }
}

start();

