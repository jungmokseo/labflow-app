/**
 * 인증 미들웨어 — Clerk JWT + Dev Mode 병행 지원
 *
 * 인증 우선순위:
 * 1. Clerk JWT (Bearer 토큰) — Clerk Secret Key가 있으면 검증
 * 2. X-Dev-User-Id 헤더 — MVP/개발 중 간이 인증
 * 3. 401 반환
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../config/env.js';
import { requestContext } from './prisma-filter.js';
import { basePrismaClient } from '../config/prisma.js';

// 인증된 요청에 userId와 labId를 추가
declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
    labId?: string;
  }
}

export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  // ── 1. Bearer 토큰 (Clerk JWT) ───────────────────
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);

    if (env.CLERK_SECRET_KEY) {
      // Clerk Secret Key가 있으면 JWT 검증 시도
      try {
        // 동적 import — @clerk/fastify가 미설치면 catch로
        const { verifyToken } = await import('@clerk/backend' as string);
        const payload = await verifyToken(token, {
          secretKey: env.CLERK_SECRET_KEY,
        });
        request.userId = payload.sub;
        return;
      } catch (err: any) {
        // 검증 실패 시 로그만 남기고 dev header로 fallback
        request.log.warn({ err: err.message }, 'Clerk JWT verification failed');
      }
    } else {
      // Clerk 미설정 — Bearer 토큰이 있으면 임시 사용자로 허용
      request.userId = 'bearer-user';
      return;
    }
  }

  // ── 2. X-Dev-User-Id (MVP 개발 모드) ──────────────
  const devUserId = request.headers['x-dev-user-id'] as string;
  if (devUserId) {
    // clerkId로 실제 User를 조회하여 DB의 UUID를 사용
    try {
      const user = await basePrismaClient.user.findFirst({
        where: { clerkId: devUserId },
        select: { id: true },
      });
      request.userId = user?.id || devUserId;
    } catch {
      request.userId = devUserId;
    }
    return;
  }

  // ── 3. Development: 기본 사용자 ────────────────────
  if (env.NODE_ENV === 'development') {
    try {
      const user = await basePrismaClient.user.findFirst({
        where: { clerkId: 'dev-user-seo' },
        select: { id: true },
      });
      request.userId = user?.id || 'dev-user-seo';
    } catch {
      request.userId = 'dev-user-seo';
    }
    return;
  }

  // ── 4. 인증 없음 → 401 ────────────────────────────
  return reply.code(401).send({
    error: '인증이 필요합니다',
    hint: 'Authorization: Bearer <token> 또는 X-Dev-User-Id 헤더를 포함해주세요.',
  });
}

/**
 * 선택적 인증 (로그인 안 해도 접근 가능한 라우트)
 */
export async function optionalAuth(
  request: FastifyRequest,
  _reply: FastifyReply,
) {
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    // Clerk 검증은 생략 — 선택적 인증이므로
    request.userId = 'bearer-user';
    return;
  }
  const devUserId = request.headers['x-dev-user-id'] as string;
  if (devUserId) {
    try {
      const user = await basePrismaClient.user.findFirst({
        where: { clerkId: devUserId },
        select: { id: true },
      });
      request.userId = user?.id || devUserId;
    } catch {
      request.userId = devUserId;
    }
  }
}

/**
 * requestContext를 설정하는 Fastify onRequest 훅
 * auth 미들웨어 실행 후 userId가 설정된 상태에서 호출됨
 */
export function setupRequestContextHook(app: import('fastify').FastifyInstance) {
  app.addHook('onRequest', async (request) => {
    if (request.userId) {
      // Lab을 조회하여 labId를 자동 설정 (prisma-filter에서 사용)
      // NOTE: requestContext.enterWith()로 동기적 설정 — Fastify는 async_hooks와 호환
      requestContext.enterWith({
        userId: request.userId,
        labId: request.labId,
      });
    }
  });
}
