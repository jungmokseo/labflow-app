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
import { runDeadlineReminders } from '../services/cron-deadline-reminders.js';
import { runPaperMonitoring } from '../services/cron-paper-monitoring.js';
import { runEmailBriefing } from '../services/cron-email-briefing.js';
import { runIrisMonitoring } from '../services/cron-iris-monitoring.js';
import { runProcessSlackInbox } from '../services/cron-process-slack-inbox.js';
import { CRON_STATUS, manualRunCron } from '../services/cron-utils.js';

function requireSyncToken(token: string | undefined) {
  const expected = env.LABFLOW_SYNC_TOKEN;
  if (!expected) return { ok: false as const, status: 503, error: 'LABFLOW_SYNC_TOKEN not configured on server' };
  if (!token || token !== expected) return { ok: false as const, status: 401, error: 'invalid sync token' };
  return { ok: true as const };
}

// label → 실행 함수 매핑 (manual trigger 용)
const CRON_RUNNERS: Record<string, () => Promise<unknown>> = {
  'deadline-reminder-cron': runDeadlineReminders,
  'paper-monitoring-cron': runPaperMonitoring,
  'email-briefing-cron': () => runEmailBriefing('both'),
  'iris-monitoring-cron': runIrisMonitoring,
  'general-email-briefing-cron': runGeneralEmailBriefing,
  'process-slack-inbox-cron': runProcessSlackInbox,
};

export async function internalTriggerRoutes(app: FastifyInstance) {
  // POST /api/internal/run-general-email-briefing — 일반 이메일 브리핑 즉시 실행
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

  // GET /api/internal/cron-status — 모든 cron의 in-memory status 조회 (진단용)
  //
  // 응답:
  //   {
  //     ok: true,
  //     serverStartedAt: ISO,
  //     envHealth: { LAB_ID, NOTION_API_KEY, ADMIN_USER_ID, SLACK_BOT_TOKEN, ... },
  //     cronCount: number,
  //     crons: [{ label, schedule, scheduledAt, nextRunAt, lastStartedAt, lastCompletedAt, lastSuccess, lastError, runCount, errorCount }]
  //   }
  //
  // 사용 예: curl https://labflow-app-production.up.railway.app/api/internal/cron-status -H "X-Sync-Token: $TOKEN"
  app.get(
    '/api/internal/cron-status',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const auth = requireSyncToken(request.headers['x-sync-token'] as string | undefined);
      if (!auth.ok) return reply.code(auth.status).send({ error: auth.error });

      const crons = Array.from(CRON_STATUS.values()).sort((a, b) => a.label.localeCompare(b.label));
      const envHealth = {
        LAB_ID: !!env.LAB_ID,
        NOTION_API_KEY: !!env.NOTION_API_KEY,
        ADMIN_USER_ID: !!env.ADMIN_USER_ID,
        SLACK_BOT_TOKEN: !!env.SLACK_BOT_TOKEN,
        ANTHROPIC_API_KEY: !!env.ANTHROPIC_API_KEY,
        GEMINI_API_KEY: !!env.GEMINI_API_KEY,
        GOOGLE_CLIENT_ID: !!env.GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET: !!env.GOOGLE_CLIENT_SECRET,
        GOOGLE_REFRESH_TOKEN: !!env.GOOGLE_REFRESH_TOKEN,
        LAB_OWNER_EMAIL: env.LAB_OWNER_EMAIL || null,
        LAB_OWNER_CLERK_ID: env.LAB_OWNER_CLERK_ID || null,
      };

      // 진단 hint — cron이 0개면 LAB_ID/NOTION_API_KEY 미설정 가능성
      const hints: string[] = [];
      if (crons.length === 0) {
        hints.push('등록된 cron이 0개. env.LAB_ID + env.NOTION_API_KEY 둘 다 설정되어야 cron 블록이 실행됨.');
      }
      if (!envHealth.ADMIN_USER_ID) {
        hints.push('ADMIN_USER_ID 미설정 — general-email-briefing cron은 등록되지 않음.');
      }
      if (!envHealth.SLACK_BOT_TOKEN) {
        hints.push('SLACK_BOT_TOKEN 미설정 — Slack 알림이 모두 비활성.');
      }
      // 각 cron의 마지막 실행이 너무 오래됐는지 점검
      const now = Date.now();
      for (const c of crons) {
        if (c.lastCompletedAt) {
          const lastMs = new Date(c.lastCompletedAt).getTime();
          const hoursSince = (now - lastMs) / (60 * 60 * 1000);
          if (hoursSince > 48 && c.schedule.startsWith('매일')) {
            hints.push(`${c.label}: 마지막 성공이 ${Math.round(hoursSince)}h 전 — 비정상 (매일 cron)`);
          }
        } else if (c.runCount > 0 && c.errorCount === c.runCount) {
          hints.push(`${c.label}: 모든 실행 실패 (${c.errorCount}/${c.runCount}). lastError 참조.`);
        }
      }

      return reply.send({
        ok: true,
        serverStartedAt: SERVER_STARTED_AT,
        nowIso: new Date().toISOString(),
        envHealth,
        cronCount: crons.length,
        crons,
        hints,
      });
    },
  );

  // POST /api/internal/run-cron/:label — 특정 cron 즉시 실행 (status 추적 포함)
  // label은 cron-status 응답의 label 그대로 사용.
  app.post<{ Params: { label: string } }>(
    '/api/internal/run-cron/:label',
    async (request, reply) => {
      const auth = requireSyncToken(request.headers['x-sync-token'] as string | undefined);
      if (!auth.ok) return reply.code(auth.status).send({ error: auth.error });

      const { label } = request.params;
      const runner = CRON_RUNNERS[label];
      if (!runner) {
        return reply.code(404).send({
          ok: false,
          error: `Unknown cron label: ${label}`,
          available: Object.keys(CRON_RUNNERS),
        });
      }

      try {
        let result: unknown;
        await manualRunCron(label, async () => {
          result = await runner();
        });
        return reply.send({ ok: true, label, result, status: CRON_STATUS.get(label) });
      } catch (e: any) {
        return reply.code(500).send({ ok: false, error: e?.message || 'unknown', status: CRON_STATUS.get(label) });
      }
    },
  );

  // POST /api/internal/run-all-crons — 모든 cron 순차 실행 + 결과 요약
  // 진단용 — "지금 모든 자동화 즉시 실행하고 어떤 게 fail인지 한 번에 확인".
  app.post(
    '/api/internal/run-all-crons',
    async (request, reply) => {
      const auth = requireSyncToken(request.headers['x-sync-token'] as string | undefined);
      if (!auth.ok) return reply.code(auth.status).send({ error: auth.error });

      const summary: Array<{ label: string; ok: boolean; error?: string; ms: number }> = [];
      for (const [label, runner] of Object.entries(CRON_RUNNERS)) {
        const t0 = Date.now();
        try {
          await manualRunCron(label, async () => {
            await runner();
          });
          summary.push({ label, ok: true, ms: Date.now() - t0 });
        } catch (e: any) {
          summary.push({ label, ok: false, error: e?.message || 'unknown', ms: Date.now() - t0 });
        }
      }
      return reply.send({ ok: summary.every(s => s.ok), summary, statuses: Array.from(CRON_STATUS.values()) });
    },
  );
}

const SERVER_STARTED_AT = new Date().toISOString();
