/**
 * Internal Trigger Routes — X-Sync-Token 인증으로 cron을 즉시 실행.
 *
 * 목적: 사용자(PI) Bearer 토큰 없이도 검증/디버깅 위해 cron을 trigger할 수 있는 path.
 * /api/automations/run/* 는 OWNER 권한이 필요해 외부에서 호출 어려움.
 * 이 endpoint는 inbox-summary.ts와 같은 X-Sync-Token 패턴 — bliss-slack-bot 인증과 동일.
 *
 * 보안: LABFLOW_SYNC_TOKEN을 알고 있어야만 호출 가능 (Railway env 또는 sync-token 보유자).
 *
 * 사용 예:
 *   curl -X POST https://labflow-app-production.up.railway.app/api/internal/run-general-email-briefing \
 *        -H "X-Sync-Token: $LABFLOW_SYNC_TOKEN"
 *
 * 응답: cron의 result JSON 그대로 + briefingMarkdown 필드 포함.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../config/env.js';
import { runGeneralEmailBriefing } from '../services/cron-general-email-briefing.js';

function requireSyncToken(token: string | undefined) {
  const expected = env.LABFLOW_SYNC_TOKEN;
  if (!expected) return { ok: false as const, status: 503, error: 'LABFLOW_SYNC_TOKEN not configured on server' };
  if (!token || token !== expected) return { ok: false as const, status: 401, error: 'invalid sync token' };
  return { ok: true as const };
}

export async function internalTriggerRoutes(app: FastifyInstance) {
  // POST /api/internal/run-general-email-briefing — 일반 이메일 브리핑 즉시 실행
  // ResearchFlow 알고리즘 (keywords + importanceRules + 동적 groups) 검증용.
  app.post(
    '/api/internal/run-general-email-briefing',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const auth = requireSyncToken(request.headers['x-sync-token'] as string | undefined);
      if (!auth.ok) return reply.code(auth.status).send({ error: auth.error });

      try {
        const result = await runGeneralEmailBriefing();
        return reply.send({ ok: true, result });
      } catch (e: any) {
        console.error('[internal-trigger:general-email-briefing] 실패:', e?.message || e);
        return reply.code(500).send({ ok: false, error: e?.message || 'unknown' });
      }
    },
  );
}
