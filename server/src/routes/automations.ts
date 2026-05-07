/**
 * Automation manual trigger endpoints.
 *
 * cron으로 정기 실행되는 자동화를 즉시 수동 실행할 수 있게 OWNER 권한 endpoint 제공.
 * 디버깅/검증/응급 실행 용도. 정상 운영은 cron이 처리.
 *
 * 모든 endpoint는 /api/automations/run/{name} 패턴, OWNER 전용.
 */

import { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { env } from '../config/env.js';
import { runDeadlineReminders } from '../services/cron-deadline-reminders.js';
import { runPaperMonitoring } from '../services/cron-paper-monitoring.js';
import { runEmailBriefing } from '../services/cron-email-briefing.js';
import { runIrisMonitoring } from '../services/cron-iris-monitoring.js';
import { runGeneralEmailBriefing } from '../services/cron-general-email-briefing.js';
import { runProcessSlackInbox } from '../services/cron-process-slack-inbox.js';

async function runWith(reply: FastifyReply, label: string, fn: () => Promise<unknown>) {
  try {
    const result = await fn();
    return reply.send({ ok: true, result });
  } catch (e: any) {
    console.error(`[automation:${label}] 실패:`, e?.message || e);
    return reply.code(500).send({ ok: false, error: e?.message || 'unknown' });
  }
}

export async function automationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);
  // env.LAB_ID 단일 lab 배포에서도 권한 미들웨어가 작동하도록 request.labId 채움
  app.addHook('preHandler', async (request) => {
    if (!request.labId && env.LAB_ID) request.labId = env.LAB_ID;
  });

  // POST /api/automations/run/deadline-reminders — 마감일 리마인더 즉시 실행
  app.post('/api/automations/run/deadline-reminders', { preHandler: requirePermission('OWNER') }, async (_req, reply) => {
    return runWith(reply, 'deadline-reminders', () => runDeadlineReminders());
  });

  // POST /api/automations/run/paper-monitoring — 논문 모니터링 즉시 실행
  app.post('/api/automations/run/paper-monitoring', { preHandler: requirePermission('OWNER') }, async (_req, reply) => {
    return runWith(reply, 'paper-monitoring', () => runPaperMonitoring());
  });

  // POST /api/automations/run/email-briefing — 학생/회사 주간보고 즉시 실행
  // body: { scope?: 'student' | 'company' | 'both' } — 기본 'both'
  const emailBriefingSchema = z.object({
    scope: z.enum(['student', 'company', 'both']).optional(),
  });
  app.post('/api/automations/run/email-briefing', { preHandler: requirePermission('OWNER') }, async (request, reply) => {
    const body = emailBriefingSchema.parse(request.body || {});
    return runWith(reply, 'email-briefing', () => runEmailBriefing(body.scope ?? 'both'));
  });

  // POST /api/automations/run/iris-monitoring — IRIS R&D 공고 즉시 실행
  app.post('/api/automations/run/iris-monitoring', { preHandler: requirePermission('OWNER') }, async (_req, reply) => {
    return runWith(reply, 'iris-monitoring', () => runIrisMonitoring());
  });

  // POST /api/automations/run/general-email-briefing — 일반 이메일 브리핑 즉시 실행
  app.post('/api/automations/run/general-email-briefing', { preHandler: requirePermission('OWNER') }, async (_req, reply) => {
    return runWith(reply, 'general-email-briefing', () => runGeneralEmailBriefing());
  });

  // POST /api/automations/run/process-slack-inbox — Slack inbox 처리 즉시 실행
  app.post('/api/automations/run/process-slack-inbox', { preHandler: requirePermission('OWNER') }, async (_req, reply) => {
    return runWith(reply, 'process-slack-inbox', () => runProcessSlackInbox());
  });
}
