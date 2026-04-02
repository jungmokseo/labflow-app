/**
 * LabFlow API Server
 *
 * Fastify + Prisma + Supabase PostgreSQL + Gemini Flash
 * 캡처 CRUD, AI 자동분류, Supabase 인증
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
import { knowledgeGraphRoutes } from './routes/knowledge-graph.js';
import { resetRoutes } from './routes/reset.js';
import { brainRoutes, archiveOldSessions } from './routes/brain.js';
import { labProfileRoutes } from './routes/lab-profile.js';
import { paperAlertRoutes, startPaperAlertCron } from './routes/paper-alerts.js';
import { paperRoutes } from './routes/papers.js';
import { labCaptureRoutes } from './routes/lab-captures.js';
import { briefingRoutes } from './routes/briefing.js';
import { calendarRoutes } from './routes/calendar.js';
import { setupRequestContextHook } from './middleware/auth.js';
import { resolveLabPermission } from './middleware/permissions.js';

async function buildApp() {
    const app = Fastify({
          logger: {
                  level: env.NODE_ENV === 'development' ? 'info' : 'warn',
                  transport: env.NODE_ENV === 'development'
                    ? { target: 'pino-pretty', options: { colorize: true } }
                            : undefined,
          },
    });

  // ── 플러그인 ──────────────────────────────────────
  const corsOrigins = env.CORS_ORIGINS.trim();
  await app.register(cors, {
        origin: corsOrigins === '*' ? true : corsOrigins.split(',').map(s => s.trim()),
        credentials: corsOrigins !== '*',
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Dev-User-Id'],
  });
    await app.register(multipart, {
          limits: { fileSize: 55 * 1024 * 1024 }, // 55MB (긴 회의 오디오 대응; 개별 라우트에서 추가 제한)
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

  // ── Data isolation context hook ────────────────────
  setupRequestContextHook(app);

  // ── Lab 권한 해석 (auth + context 후에 실행) ──────
  app.addHook('onRequest', resolveLabPermission);

  // ── 라우트 등록 ────────────────────────────────────
  await app.register(healthRoutes);
    await app.register(captureRoutes);
    await app.register(emailCallbackRoute);  // auth 없는 OAuth 콜백 (반드시 emailRoutes보다 먼저)
  await app.register(emailRoutes);
    await app.register(meetingRoutes);
    await app.register(voiceChatbotRoutes);
    await app.register(knowledgeGraphRoutes);
    await app.register(resetRoutes);
    await app.register(brainRoutes);
    await app.register(labProfileRoutes);
    await app.register(paperAlertRoutes);
    await app.register(paperRoutes);
    await app.register(labCaptureRoutes);
    await app.register(briefingRoutes);
    await app.register(calendarRoutes);

  return app;
}

// ── 서버 시작 ──────────────────────────────────────
async function start() {
    try {
          const app = await buildApp();
          await app.listen({ port: env.PORT, host: env.HOST });

      // 논문 알림 cron + 세션 아카이브
      startPaperAlertCron();
      setInterval(() => archiveOldSessions().catch((err) => console.error('[background] archiveOldSessions:', err.message || err)), 24 * 60 * 60 * 1000);

      console.log(`
      ╔═══════════════════════════════════════════════╗
      ║           🧪 LabFlow API Server               ║
      ╠═══════════════════════════════════════════════╣
      ║  URL:    http://${env.HOST}:${env.PORT}              ║
      ║  Env:    ${env.NODE_ENV.padEnd(36)}║
      ║  Gemini: ✅ Connected                         ║
      ║  Auth:   ${env.SUPABASE_JWT_SECRET ? '✅ Supabase' : '⚠️  Dev mode'}${''.padEnd(env.SUPABASE_JWT_SECRET ? 22 : 22)}║
      ╚═══════════════════════════════════════════════╝
          `);
    } catch (err) {
          console.error('❌ 서버 시작 실패:', err);
          process.exit(1);
    }
}

start();
