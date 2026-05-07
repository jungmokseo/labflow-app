/**
 * Automation manual trigger endpoints.
 *
 * cron으로 정기 실행되는 자동화를 즉시 수동 실행할 수 있게 OWNER 권한 endpoint 제공.
 * 디버깅/검증/응급 실행 용도. 정상 운영은 cron이 처리.
 *
 * 모든 endpoint는 /api/automations/run/{name} 패턴, OWNER 전용.
 */

import { FastifyInstance } from 'fastify';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { env } from '../config/env.js';
import { runDeadlineReminders } from '../services/cron-deadline-reminders.js';

export async function automationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);
  // env.LAB_ID 단일 lab 배포에서도 권한 미들웨어가 작동하도록 request.labId 채움
  app.addHook('preHandler', async (request) => {
    if (!request.labId && env.LAB_ID) request.labId = env.LAB_ID;
  });

  // POST /api/automations/run/deadline-reminders — 마감일 리마인더 즉시 실행
  app.post('/api/automations/run/deadline-reminders', { preHandler: requirePermission('OWNER') }, async (_request, reply) => {
    try {
      const result = await runDeadlineReminders();
      return reply.send({ ok: true, result });
    } catch (e: any) {
      return reply.code(500).send({ ok: false, error: e?.message || 'unknown' });
    }
  });
}
