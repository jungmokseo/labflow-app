/**
 * 인증 미들웨어 — Clerk JWT + Dev Mode 병행 지원
 *
 * 인증 우선순위:
 * 1. Clerk JWT (Bearer 토큰) — Clerk Secret Key가 있으면 검증
 * 2. X-Dev-User-Id 헤더 — development 환경에서만 허용
 * 3. 401 반환
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../config/env.js';
import { requestContext } from './prisma-filter.js';
import { basePrismaClient } from '../config/prisma.js';

const isDev = env.NODE_ENV === 'development';

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
      try {
        const { verifyToken } = await import('@clerk/backend' as string);
        const payload = await verifyToken(token, {
          secretKey: env.CLERK_SECRET_KEY,
        });
        // Clerk ID(payload.sub)로 실제 DB User를 조회하여 cuid를 사용
        const clerkId = payload.sub;
        try {
          const user = await basePrismaClient.user.findFirst({
            where: { clerkId },
            select: { id: true },
          });
          if (user) {
            request.userId = user.id;
          } else {
            // DB에 없는 Clerk 유저 → 자동 생성
            const email = (payload as any).email || `${clerkId}@clerk.user`;
            const newUser = await basePrismaClient.user.create({
              data: { clerkId, email, name: (payload as any).name || null },
            });
            request.userId = newUser.id;
          }
        } catch {
          request.userId = clerkId; // DB 조회 실패 시 fallback
        }
        return;
      } catch (err: any) {
        request.log.warn({ err: err.message }, 'Clerk JWT verification failed');
      }
    }
    // Clerk 미설정 시 Bearer 토큰 무시 — dev mode로 fallback
  }

  // ── 2. X-Dev-User-Id — development 환경에서만 허용 ──
  if (isDev) {
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
      return;
    }

    // 기본 개발 사용자
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

  // ── 3. 인증 없음 → 401 ────────────────────────────
  return reply.code(401).send({
    error: '인증이 필요합니다',
    hint: 'Authorization: Bearer <token> 헤더를 포함해주세요.',
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
  if (authHeader?.startsWith('Bearer ') && env.CLERK_SECRET_KEY) {
    try {
      const { verifyToken } = await import('@clerk/backend' as string);
      const payload = await verifyToken(authHeader.slice(7), {
        secretKey: env.CLERK_SECRET_KEY,
      });
      const user = await basePrismaClient.user.findFirst({
        where: { clerkId: payload.sub },
        select: { id: true },
      });
      request.userId = user?.id || payload.sub;
    } catch {
      // Optional auth — verification failure is OK
    }
    return;
  }
  if (isDev) {
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
}

/**
 * requestContext를 설정하는 Fastify onRequest 훅
 * auth 미들웨어 실행 후 userId가 설정된 상태에서 호출됨
 */
export function setupRequestContextHook(app: import('fastify').FastifyInstance) {
  app.addHook('onRequest', async (request) => {
    if (request.userId) {
      // Lab을 조회하여 labId를 자동 설정 (prisma-filter에서 사용)
      let labId = request.labId;
      if (!labId) {
        try {
          const lab = await basePrismaClient.lab.findFirst({
            where: { ownerId: request.userId },
            select: { id: true },
          });
          if (lab) {
            labId = lab.id;
            request.labId = lab.id;
          }
        } catch {
          // Lab 조회 실패는 무시 — labId 없이 진행
        }
      }
      requestContext.enterWith({
        userId: request.userId,
        labId,
      });
    }
  });
}
