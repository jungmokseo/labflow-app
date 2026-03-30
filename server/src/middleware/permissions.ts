/**
 * 권한 미들웨어 — Lab 멤버 권한 기반 접근 제어
 *
 * 권한 계층:
 * OWNER  > ADMIN > EDITOR > VIEWER
 *
 * 사용법:
 *   app.get('/api/lab/settings', { preHandler: requirePermission('ADMIN') }, handler)
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import { basePrismaClient } from '../config/prisma.js';

type Permission = 'OWNER' | 'ADMIN' | 'EDITOR' | 'VIEWER';

const PERMISSION_LEVEL: Record<Permission, number> = {
  OWNER: 4,
  ADMIN: 3,
  EDITOR: 2,
  VIEWER: 1,
};

/**
 * 현재 유저의 Lab 권한을 확인하고 request에 추가
 */
export async function resolveLabPermission(
  request: FastifyRequest,
  _reply: FastifyReply,
) {
  const userId = request.userId;
  const labId = request.labId;
  if (!userId || !labId) return;

  // Lab owner는 항상 OWNER
  try {
    const lab = await basePrismaClient.lab.findUnique({
      where: { id: labId },
      select: { ownerId: true },
    });
    if (lab?.ownerId === userId) {
      (request as any).labPermission = 'OWNER' as Permission;
      return;
    }
  } catch { /* ignore */ }

  // LabMember에서 권한 조회
  try {
    const member = await basePrismaClient.labMember.findFirst({
      where: { labId, userId, active: true },
      select: { permission: true },
    });
    if (member) {
      (request as any).labPermission = member.permission as Permission;
    }
  } catch { /* ignore */ }
}

/**
 * 특정 권한 이상을 요구하는 미들웨어 생성
 */
export function requirePermission(minPermission: Permission) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    // 먼저 권한 해석
    if (!(request as any).labPermission) {
      await resolveLabPermission(request, reply);
    }

    const userPermission = (request as any).labPermission as Permission | undefined;

    if (!userPermission) {
      return reply.code(403).send({
        error: '이 연구실에 접근 권한이 없습니다',
        required: minPermission,
      });
    }

    if (PERMISSION_LEVEL[userPermission] < PERMISSION_LEVEL[minPermission]) {
      return reply.code(403).send({
        error: `${minPermission} 이상의 권한이 필요합니다`,
        current: userPermission,
        required: minPermission,
      });
    }
  };
}

/**
 * Fastify request에 labPermission 타입 추가
 */
declare module 'fastify' {
  interface FastifyRequest {
    labPermission?: Permission;
  }
}
