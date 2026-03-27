/**
 * Soft / Selective Reset API
 *
 * POST /api/user/reset        — soft(세션 초기화) 또는 selective(기능별 preference 초기화)
 * POST /api/user/reset/restore — selective reset 이전 상태로 복원
 *
 * Hard Reset은 구현하지 않음 (향후 탈퇴 기능 개발 시 구현).
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { authMiddleware } from '../middleware/auth.js';

// ── Zod 스키마 ──────────────────────────────────────
const resetBodySchema = z.object({
  type: z.enum(['soft', 'selective']),
  feature: z.enum(['email', 'memo', 'meeting', 'general']).optional(),
});

const restoreBodySchema = z.object({
  feature: z.enum(['email', 'memo', 'meeting', 'general']),
});

// ── 기능별 기본 규칙 ──────────────────────────────────
const DEFAULT_RULES: Record<string, object> = {
  email: {
    sender_priority: {},
    keyword_boost: [],
    keyword_suppress: [],
    response_mode: 'summary_only',
  },
  memo: {},
  meeting: {},
  general: {},
};

// ── 헬퍼: User 확인 ─────────────────────────────────
async function findUser(clerkId: string) {
  return prisma.user.findFirst({ where: { clerkId } });
}

// ── 라우트 등록 ──────────────────────────────────────
export async function resetRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // ── POST /api/user/reset ───────────────────────
  app.post('/api/user/reset', async (request, reply) => {
    const body = resetBodySchema.parse(request.body);
    const userId = request.userId!;

    const user = await findUser(userId);
    if (!user) return reply.code(404).send({ error: '사용자를 찾을 수 없습니다' });

    if (body.type === 'soft') {
      // ── Soft Reset: L1 작업기억 클리어 ──
      // 세션 컨텍스트만 초기화, L2~L5 및 Preference 유지
      // User.metadata에 lastSessionReset 기록
      await prisma.user.update({
        where: { id: user.id },
        data: {
          metadata: {
            ...(user.metadata as object || {}),
            lastSessionReset: new Date().toISOString(),
          },
        },
      });

      return reply.send({
        success: true,
        message: 'Soft reset 완료 — 세션 컨텍스트가 초기화되었습니다',
        type: 'soft',
      });
    }

    if (body.type === 'selective') {
      // ── Selective Reset: 지정된 feature의 UserPreference 초기화 ──
      if (!body.feature) {
        return reply.code(400).send({ error: 'selective reset에는 feature 필드가 필요합니다' });
      }

      const pref = await prisma.userPreference.findUnique({
        where: { userId_featureType: { userId: user.id, featureType: body.feature } },
      });

      if (!pref) {
        return reply.send({
          success: true,
          message: `${body.feature} preference가 존재하지 않아 초기화할 내용이 없습니다`,
          type: 'selective',
          feature: body.feature,
        });
      }

      // 현재 rules를 snapshotData에 백업 후, rules 초기화 + version++
      await prisma.userPreference.update({
        where: { id: pref.id },
        data: {
          snapshotData: pref.rules as any,                 // 복원용 백업
          rules: (DEFAULT_RULES[body.feature] || {}) as any,  // 초기값으로 리셋
          version: pref.version + 1,
        },
      });

      return reply.send({
        success: true,
        message: `${body.feature} preference가 초기화되었습니다 (v${pref.version} → v${pref.version + 1})`,
        type: 'selective',
        feature: body.feature,
        previousVersion: pref.version,
        newVersion: pref.version + 1,
        canRestore: true,
      });
    }

    return reply.code(400).send({ error: '지원하지 않는 reset type' });
  });

  // ── POST /api/user/reset/restore ───────────────
  app.post('/api/user/reset/restore', async (request, reply) => {
    const body = restoreBodySchema.parse(request.body);
    const userId = request.userId!;

    const user = await findUser(userId);
    if (!user) return reply.code(404).send({ error: '사용자를 찾을 수 없습니다' });

    const pref = await prisma.userPreference.findUnique({
      where: { userId_featureType: { userId: user.id, featureType: body.feature } },
    });

    if (!pref) {
      return reply.code(404).send({ error: `${body.feature} preference가 존재하지 않습니다` });
    }

    if (!pref.snapshotData) {
      return reply.code(400).send({ error: '복원할 스냅샷이 없습니다 (이전 reset 기록이 없음)' });
    }

    // snapshotData에서 이전 rules를 복원
    await prisma.userPreference.update({
      where: { id: pref.id },
      data: {
        rules: pref.snapshotData as any,
        snapshotData: null as any,   // 스냅샷 소비 완료
        version: pref.version + 1,
      },
    });

    return reply.send({
      success: true,
      message: `${body.feature} preference가 이전 상태로 복원되었습니다`,
      feature: body.feature,
      restoredVersion: pref.version + 1,
    });
  });
}
