/**
 * 인증 미들웨어 — Supabase JWT (우선) + Clerk JWT (레거시) + Dev Mode
 *
 * 인증 우선순위:
 * 1. Supabase JWT (Bearer 토큰) — SUPABASE_JWT_SECRET이 있으면 검증
 * 2. Clerk JWT (Bearer 토큰) — CLERK_SECRET_KEY가 있으면 검증 (레거시 호환)
 * 3. X-Dev-User-Id 헤더 — development 환경에서만 허용
 * 4. 401 반환
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
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

/**
 * Supabase JWT에서 사용자 ID 추출 및 DB 매핑
 */
async function resolveSupabaseUser(token: string): Promise<string | null> {
  if (!env.SUPABASE_JWT_SECRET) { console.log('[auth] No SUPABASE_JWT_SECRET'); return null; }
  try {
    const payload = jwt.verify(token, env.SUPABASE_JWT_SECRET, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    const supabaseId = payload.sub;
    if (!supabaseId) return null;

    // Supabase UUID로 DB User 조회 (clerkId 필드를 authProviderId로 재사용)
    const user = await basePrismaClient.user.findFirst({
      where: { clerkId: supabaseId },
      select: { id: true },
    });
    if (user) return user.id;

    // DB에 없으면 자동 생성
    const email = payload.email || `${supabaseId}@supabase.user`;
    const newUser = await basePrismaClient.user.create({
      data: { clerkId: supabaseId, email, name: (payload as any).user_metadata?.name || null },
    });
    return newUser.id;
  } catch (err: any) {
    console.error('[auth] Supabase JWT error:', err.message);
    return null;
  }
}

/**
 * Clerk JWT에서 사용자 ID 추출 (레거시 호환)
 */
async function resolveClerkUser(token: string): Promise<string | null> {
  if (!env.CLERK_SECRET_KEY) return null;
  try {
    const { verifyToken } = await import('@clerk/backend' as string);
    const payload = await verifyToken(token, { secretKey: env.CLERK_SECRET_KEY });
    const clerkId = payload.sub;

    const user = await basePrismaClient.user.findFirst({
      where: { clerkId },
      select: { id: true },
    });
    if (user) return user.id;

    const email = (payload as any).email || `${clerkId}@clerk.user`;
    const newUser = await basePrismaClient.user.create({
      data: { clerkId, email, name: (payload as any).name || null },
    });
    return newUser.id;
  } catch {
    return null;
  }
}

/**
 * Dev 모드에서 사용자 ID 해석
 */
async function resolveDevUser(devUserId?: string): Promise<string> {
  const lookupId = devUserId || 'dev-user-seo';
  try {
    const user = await basePrismaClient.user.findFirst({
      where: { clerkId: lookupId },
      select: { id: true },
    });
    return user?.id || lookupId;
  } catch {
    return lookupId;
  }
}

export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  // ── 1. Bearer 토큰 (Supabase JWT → Clerk JWT) ───────
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);

    // Supabase JWT 우선
    const supabaseUserId = await resolveSupabaseUser(token);
    if (supabaseUserId) {
      request.userId = supabaseUserId;
      return;
    }

    // Clerk JWT fallback (레거시)
    const clerkUserId = await resolveClerkUser(token);
    if (clerkUserId) {
      request.userId = clerkUserId;
      return;
    }

    request.log.warn('JWT verification failed for both Supabase and Clerk (token length: %d)', token.length);
  }

  // ── 2. X-Dev-User-Id — development 환경에서만 허용 ──
  if (isDev) {
    const devUserId = request.headers['x-dev-user-id'] as string;
    request.userId = await resolveDevUser(devUserId);
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
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const userId = await resolveSupabaseUser(token) || await resolveClerkUser(token);
    if (userId) request.userId = userId;
    return;
  }
  if (isDev) {
    const devUserId = request.headers['x-dev-user-id'] as string;
    if (devUserId) {
      request.userId = await resolveDevUser(devUserId);
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
      // 1) owner인 Lab 먼저 확인, 2) 소속 멤버인 Lab 확인
      let labId = request.labId;
      if (!labId) {
        try {
          // owner 우선
          const ownedLab = await basePrismaClient.lab.findFirst({
            where: { ownerId: request.userId },
            select: { id: true },
          });
          if (ownedLab) {
            labId = ownedLab.id;
          } else {
            // 멤버로 소속된 Lab 탐색
            const membership = await basePrismaClient.labMember.findFirst({
              where: { userId: request.userId, active: true },
              select: { labId: true },
            });
            if (membership) labId = membership.labId;
          }
          if (labId) request.labId = labId;
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
