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
import { prisma } from '../config/prisma.js';
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

  // POST /api/automations/test-models — 현재 코드에서 사용 중인 모든 모델 ID로 minimal API call.
  // Production env의 키로 실측. 모델 ID 변경/deprecation 검증용.
  //
  // 응답 schema:
  //   {
  //     ok: boolean,
  //     providers: [
  //       {
  //         name: 'Anthropic' | 'Google Gemini' | 'OpenAI',
  //         icon: string,
  //         envVar: string,
  //         envSet: boolean,
  //         models: [
  //           {
  //             id: string,                    // API ID (e.g. 'claude-sonnet-4-6')
  //             displayName: string,           // UI 표시명 (e.g. 'Sonnet 4.6')
  //             usage: string,                 // 한 줄 사용처 설명
  //             ok: boolean,
  //             ms?: number,
  //             output?: string,
  //             error?: string,
  //           },
  //           ...
  //         ]
  //       },
  //     ],
  //     results: { [modelId]: entry }        // backward-compat flat 형태도 유지
  //   }
  app.post('/api/automations/test-models', { preHandler: requirePermission('OWNER') }, async (_req, reply) => {
    type ModelEntry = {
      id: string;
      displayName: string;
      usage: string;
      ok: boolean;
      ms?: number;
      output?: string;
      error?: string;
    };
    type Provider = {
      name: string;
      icon: string;
      envVar: string;
      envSet: boolean;
      models: ModelEntry[];
    };

    const providers: Provider[] = [];
    const flatResults: Record<string, { ok: boolean; ms?: number; error?: string; output?: string }> = {};

    // ── Anthropic ──
    const anthropicModels: Array<{ id: string; displayName: string; usage: string }> = [
      {
        id: 'claude-sonnet-4-6',
        displayName: 'Sonnet 4.6',
        usage: '기본 LLM — 이메일 분류·brain chat·논문 분석·모든 cron 자동화',
      },
      {
        id: 'claude-opus-4-7',
        displayName: 'Opus 4.7',
        usage: 'papers tool·paper deep summary·wiki deep synthesis (1M context)',
      },
    ];
    const anthropicProvider: Provider = {
      name: 'Anthropic',
      icon: '🅰️',
      envVar: 'ANTHROPIC_API_KEY',
      envSet: !!env.ANTHROPIC_API_KEY,
      models: [],
    };
    if (env.ANTHROPIC_API_KEY) {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
      for (const meta of anthropicModels) {
        const t0 = Date.now();
        try {
          const r = await client.messages.create({
            model: meta.id,
            max_tokens: 10,
            messages: [{ role: 'user', content: 'ping' }],
          });
          const text = r.content.find(b => b.type === 'text');
          const entry: ModelEntry = {
            ...meta,
            ok: true,
            ms: Date.now() - t0,
            output: text?.type === 'text' ? text.text.slice(0, 50) : '(non-text)',
          };
          anthropicProvider.models.push(entry);
          flatResults[meta.id] = { ok: entry.ok, ms: entry.ms, output: entry.output };
        } catch (e: any) {
          const entry: ModelEntry = {
            ...meta,
            ok: false,
            ms: Date.now() - t0,
            error: e?.message?.slice(0, 200) || 'unknown',
          };
          anthropicProvider.models.push(entry);
          flatResults[meta.id] = { ok: false, ms: entry.ms, error: entry.error };
        }
      }
    } else {
      for (const meta of anthropicModels) {
        const entry: ModelEntry = { ...meta, ok: false, error: 'ANTHROPIC_API_KEY 미설정' };
        anthropicProvider.models.push(entry);
        flatResults[meta.id] = { ok: false, error: entry.error };
      }
    }
    providers.push(anthropicProvider);

    // ── Google Gemini ──
    const geminiModels: Array<{ id: string; displayName: string; usage: string }> = [
      {
        id: 'gemini-3.1-flash-lite',
        displayName: 'Flash-Lite (stable)',
        usage: '경량 작업 — 이메일 stage1·capture classify·calendar 추출·STT·번역·labflow-member chat lite',
      },
      {
        id: 'gemini-3.1-pro-preview',
        displayName: 'Pro Preview',
        usage: 'labflow-member RAG engine (rag-engine.ts)',
      },
      {
        id: 'gemini-3.1-pro-preview-customtools',
        displayName: 'Pro Custom Tools',
        usage: 'labflow-member FAQ tool-use (chat.ts·slack-command.ts /질문)',
      },
    ];
    const geminiProvider: Provider = {
      name: 'Google Gemini',
      icon: '🟦',
      envVar: 'GEMINI_API_KEY',
      envSet: !!env.GEMINI_API_KEY,
      models: [],
    };
    if (env.GEMINI_API_KEY) {
      for (const meta of geminiModels) {
        const t0 = Date.now();
        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${meta.id}:generateContent?key=${env.GEMINI_API_KEY}`;
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: 'ping' }] }],
              generationConfig: { maxOutputTokens: 10 },
            }),
          });
          const data = (await res.json()) as any;
          if (res.ok && data.candidates?.[0]) {
            const entry: ModelEntry = {
              ...meta,
              ok: true,
              ms: Date.now() - t0,
              output: (data.candidates[0].content?.parts?.[0]?.text || '').slice(0, 50),
            };
            geminiProvider.models.push(entry);
            flatResults[meta.id] = { ok: entry.ok, ms: entry.ms, output: entry.output };
          } else {
            const entry: ModelEntry = {
              ...meta,
              ok: false,
              ms: Date.now() - t0,
              error: data.error?.message?.slice(0, 200) || `HTTP ${res.status}`,
            };
            geminiProvider.models.push(entry);
            flatResults[meta.id] = { ok: false, ms: entry.ms, error: entry.error };
          }
        } catch (e: any) {
          const entry: ModelEntry = { ...meta, ok: false, error: e?.message || 'unknown' };
          geminiProvider.models.push(entry);
          flatResults[meta.id] = { ok: false, error: entry.error };
        }
      }
    } else {
      for (const meta of geminiModels) {
        const entry: ModelEntry = { ...meta, ok: false, error: 'GEMINI_API_KEY 미설정' };
        geminiProvider.models.push(entry);
        flatResults[meta.id] = { ok: false, error: entry.error };
      }
    }
    providers.push(geminiProvider);

    // ── OpenAI ──
    const openaiProvider: Provider = {
      name: 'OpenAI',
      icon: '🟢',
      envVar: 'OPENAI_API_KEY',
      envSet: !!env.OPENAI_API_KEY,
      models: [],
    };
    if (env.OPENAI_API_KEY) {
      // 1) gpt-realtime-2 — model metadata 조회 (WebSocket 실측 X, 존재 확인만)
      {
        const meta = {
          id: 'gpt-realtime-2',
          displayName: 'Realtime 2',
          usage: 'labflow-app voice chatbot (routes/voice-chatbot.ts)',
        };
        const t0 = Date.now();
        try {
          const res = await fetch('https://api.openai.com/v1/models/gpt-realtime-2', {
            headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
          });
          const data = (await res.json()) as any;
          if (res.ok && data.id === 'gpt-realtime-2') {
            const entry: ModelEntry = {
              ...meta,
              ok: true,
              ms: Date.now() - t0,
              output: `id=${data.id}, owned_by=${data.owned_by}`,
            };
            openaiProvider.models.push(entry);
            flatResults[meta.id] = { ok: entry.ok, ms: entry.ms, output: entry.output };
          } else {
            const entry: ModelEntry = {
              ...meta,
              ok: false,
              ms: Date.now() - t0,
              error: data.error?.message?.slice(0, 200) || `HTTP ${res.status}`,
            };
            openaiProvider.models.push(entry);
            flatResults[meta.id] = { ok: false, ms: entry.ms, error: entry.error };
          }
        } catch (e: any) {
          const entry: ModelEntry = { ...meta, ok: false, error: e?.message || 'unknown' };
          openaiProvider.models.push(entry);
          flatResults[meta.id] = { ok: false, error: entry.error };
        }
      }

      // 2) text-embedding-3-small — minimal embedding API call로 실측
      {
        const meta = {
          id: 'text-embedding-3-small',
          displayName: 'Embedding 3 Small',
          usage: 'labflow-member RAG embedding (paper/wiki/memo). 변경 시 전체 재인덱싱 필요',
        };
        const t0 = Date.now();
        try {
          const res = await fetch('https://api.openai.com/v1/embeddings', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${env.OPENAI_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: 'text-embedding-3-small',
              input: 'ping',
            }),
          });
          const data = (await res.json()) as any;
          if (res.ok && Array.isArray(data.data) && data.data[0]?.embedding) {
            const dim = data.data[0].embedding.length;
            const entry: ModelEntry = {
              ...meta,
              ok: true,
              ms: Date.now() - t0,
              output: `dim=${dim}, tokens=${data.usage?.total_tokens ?? '?'}`,
            };
            openaiProvider.models.push(entry);
            flatResults[meta.id] = { ok: entry.ok, ms: entry.ms, output: entry.output };
          } else {
            const entry: ModelEntry = {
              ...meta,
              ok: false,
              ms: Date.now() - t0,
              error: data.error?.message?.slice(0, 200) || `HTTP ${res.status}`,
            };
            openaiProvider.models.push(entry);
            flatResults[meta.id] = { ok: false, ms: entry.ms, error: entry.error };
          }
        } catch (e: any) {
          const entry: ModelEntry = { ...meta, ok: false, error: e?.message || 'unknown' };
          openaiProvider.models.push(entry);
          flatResults[meta.id] = { ok: false, error: entry.error };
        }
      }
    } else {
      for (const meta of [
        { id: 'gpt-realtime-2', displayName: 'Realtime 2', usage: 'voice chatbot' },
        { id: 'text-embedding-3-small', displayName: 'Embedding 3 Small', usage: 'RAG embedding' },
      ]) {
        const entry: ModelEntry = { ...meta, ok: false, error: 'OPENAI_API_KEY 미설정' };
        openaiProvider.models.push(entry);
        flatResults[meta.id] = { ok: false, error: entry.error };
      }
    }
    providers.push(openaiProvider);

    const allOk = providers.every(p => p.models.every(m => m.ok));
    return reply.code(allOk ? 200 : 207).send({
      ok: allOk,
      providers,
      results: flatResults, // backward-compat
    });
  });

  // POST /api/automations/slack-canary — Slack 발송 경로 end-to-end QA (OWNER)
  //
  // 검증 항목:
  //   1) auth.test    — bot identity + workspace
  //   2) bot info     — granted scopes (chat:write, users:read, users:read.email 등)
  //   3) chat.postMessage — ADMIN_USER_ID(PI)에게 QA DM 1회 (자기 자신이라 학생 spam 0)
  //   4) (옵션) users.lookupByEmail — labMember email로 user id 매칭 검증
  //
  // body: { lookupEmail?: string } — 있으면 그 email로 lookupByEmail 호출하여 매칭 검증
  // 학생에게 spam 발송 안 함 — admin에게만.
  app.post<{ Body: { lookupEmail?: string } }>('/api/automations/slack-canary', { preHandler: requirePermission('OWNER') }, async (request, reply) => {
    const token = env.SLACK_BOT_TOKEN;
    const adminUserId = env.ADMIN_USER_ID;
    if (!token) return reply.code(503).send({ ok: false, error: 'SLACK_BOT_TOKEN 미설정' });
    if (!adminUserId) return reply.code(503).send({ ok: false, error: 'ADMIN_USER_ID 미설정' });

    const lookupEmail = request.body?.lookupEmail?.trim();
    const out: any = { ok: true, steps: {} };

    // 1) auth.test
    try {
      const r = await fetch('https://slack.com/api/auth.test', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await r.json() as any;
      out.steps.authTest = {
        ok: d.ok,
        botUserId: d.user_id || null,
        botUsername: d.user || null,
        workspace: d.team || null,
        url: d.url || null,
        scopes: r.headers.get('x-oauth-scopes')?.split(',').map(s => s.trim()).sort() || [],
        error: d.error || null,
      };
      if (!d.ok) {
        out.ok = false;
        return reply.send(out);
      }
    } catch (e: any) {
      out.ok = false;
      out.steps.authTest = { ok: false, error: e?.message };
      return reply.send(out);
    }

    // 2) lookupByEmail (옵션)
    if (lookupEmail) {
      try {
        const r = await fetch(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(lookupEmail)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const d = await r.json() as any;
        out.steps.lookupByEmail = {
          ok: d.ok,
          email: lookupEmail,
          userId: d.user?.id || null,
          name: d.user?.real_name || d.user?.name || null,
          error: d.error || null,
        };
      } catch (e: any) {
        out.steps.lookupByEmail = { ok: false, error: e?.message };
      }
    }

    // 3) admin DM canary
    try {
      const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
      const text = [
        '🧪 *Slack QA 테스트*',
        '',
        `시각: ${now} KST`,
        `발신: ResearchFlow Settings (slack-canary endpoint)`,
        '',
        `이 메시지는 Slack 발송 경로 검증용이며, 별도 조치 불필요합니다.`,
      ].join('\n');
      const r = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          channel: adminUserId,
          text,
          unfurl_links: false,
          unfurl_media: false,
        }),
      });
      const d = await r.json() as any;
      out.steps.adminDm = {
        ok: d.ok,
        channel: d.channel || null,
        ts: d.ts || null,
        error: d.error || null,
      };
      if (!d.ok) out.ok = false;
    } catch (e: any) {
      out.ok = false;
      out.steps.adminDm = { ok: false, error: e?.message };
    }

    return reply.send(out);
  });

  // GET /api/automations/cron-status — OWNER 인증으로 cron 진단 (internal-trigger와 동일 데이터, sync-token 불필요)
  app.get('/api/automations/cron-status', { preHandler: requirePermission('OWNER') }, async (_req, reply) => {
    const { CRON_STATUS } = await import('../services/cron-utils.js');
    const crons = Array.from(CRON_STATUS.values()).sort((a, b) => a.label.localeCompare(b.label));
    const envHealth = {
      LAB_ID: !!env.LAB_ID,
      NOTION_API_KEY: !!env.NOTION_API_KEY,
      NOTION_TASK_DB_ID: !!env.NOTION_TASK_DB_ID,
      ADMIN_USER_ID: !!env.ADMIN_USER_ID,
      SLACK_BOT_TOKEN: !!env.SLACK_BOT_TOKEN,
      // Slack ↔ ResearchFlow 양방향 동기화 인증 토큰
      LABFLOW_SYNC_TOKEN: !!env.LABFLOW_SYNC_TOKEN,
      // labflow-member /api/slack-command 인증 (bliss-slack-bot이 호출)
      SLACK_RELAY_SECRET: !!env.SLACK_RELAY_SECRET,
      // labflow-member URL — inbox-summary가 follow-up/vacations 조회
      LABFLOW_MEMBER_URL: env.LABFLOW_MEMBER_URL ? 'configured' : null,
      ANTHROPIC_API_KEY: !!env.ANTHROPIC_API_KEY,
      GEMINI_API_KEY: !!env.GEMINI_API_KEY,
      GOOGLE_CLIENT_ID: !!env.GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: !!env.GOOGLE_CLIENT_SECRET,
      GOOGLE_REFRESH_TOKEN: !!env.GOOGLE_REFRESH_TOKEN,
      LAB_OWNER_EMAIL: env.LAB_OWNER_EMAIL || null,
      LAB_OWNER_CLERK_ID: env.LAB_OWNER_CLERK_ID || null,
    };

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
      nowIso: new Date().toISOString(),
      envHealth,
      cronCount: crons.length,
      crons,
      hints,
    });
  });

  // POST /api/automations/run-all — 6개 cron 즉시 실행 + 결과 요약 (OWNER)
  app.post('/api/automations/run-all', { preHandler: requirePermission('OWNER') }, async (_req, reply) => {
    const { manualRunCron } = await import('../services/cron-utils.js');
    const runners: Record<string, () => Promise<unknown>> = {
      'deadline-reminder-cron': runDeadlineReminders,
      'paper-monitoring-cron': runPaperMonitoring,
      'email-briefing-cron': () => runEmailBriefing('both'),
      'iris-monitoring-cron': runIrisMonitoring,
      'general-email-briefing-cron': runGeneralEmailBriefing,
      'process-slack-inbox-cron': runProcessSlackInbox,
    };
    const summary: Array<{ label: string; ok: boolean; error?: string; ms: number }> = [];
    for (const [label, runner] of Object.entries(runners)) {
      const t0 = Date.now();
      try {
        await manualRunCron(label, async () => { await runner(); });
        summary.push({ label, ok: true, ms: Date.now() - t0 });
      } catch (e: any) {
        summary.push({ label, ok: false, error: e?.message || 'unknown', ms: Date.now() - t0 });
      }
    }
    return reply.send({ ok: summary.every(s => s.ok), summary });
  });

  // GET /api/automations/model-usage — AiCostLog에서 service별 today/7d/30d 집계
  //
  // 응답 schema:
  //   {
  //     ok: true,
  //     today:  { service: { cost: number, count: number } },
  //     last7:  { service: { cost: number, count: number } },
  //     last30: { service: { cost: number, count: number } },
  //     totals: { today: number, last7: number, last30: number }   // 전체 cost 합
  //   }
  //
  // service 종류 (cost-logger.ts deriveService):
  //   claude-opus / claude-sonnet / claude-haiku
  //   gemini-pro / gemini-flash
  //   openai-realtime / openai-embedding (현재 client WebSocket으로 호출 → 미측정)
  app.get('/api/automations/model-usage', { preHandler: requirePermission('OWNER') }, async (_req, reply) => {
    try {
      const now = new Date();
      const todayStart = new Date(now);
      todayStart.setHours(0, 0, 0, 0);
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      // 한 번에 30일 데이터 fetch 후 메모리에서 group by — DB raw aggregate 3번 round trip보다 빠름
      const logs = await prisma.aiCostLog.findMany({
        where: { createdAt: { gte: thirtyDaysAgo } },
        select: { service: true, cost: true, createdAt: true },
      });

      type Bucket = Record<string, { cost: number; count: number }>;
      const today: Bucket = {};
      const last7: Bucket = {};
      const last30: Bucket = {};
      let totalToday = 0;
      let totalLast7 = 0;
      let totalLast30 = 0;

      for (const log of logs) {
        const svc = log.service || 'unknown';
        const cost = log.cost || 0;

        // last30 — 모든 로그 포함
        if (!last30[svc]) last30[svc] = { cost: 0, count: 0 };
        last30[svc].cost += cost;
        last30[svc].count += 1;
        totalLast30 += cost;

        // last7
        if (log.createdAt >= sevenDaysAgo) {
          if (!last7[svc]) last7[svc] = { cost: 0, count: 0 };
          last7[svc].cost += cost;
          last7[svc].count += 1;
          totalLast7 += cost;
        }

        // today
        if (log.createdAt >= todayStart) {
          if (!today[svc]) today[svc] = { cost: 0, count: 0 };
          today[svc].cost += cost;
          today[svc].count += 1;
          totalToday += cost;
        }
      }

      return reply.send({
        ok: true,
        today,
        last7,
        last30,
        totals: {
          today: totalToday,
          last7: totalLast7,
          last30: totalLast30,
        },
        // 측정 불가 안내 (frontend 표시용)
        notMeasured: {
          'openai-realtime': 'voice-chatbot은 client-side WebSocket으로 호출되어 서버 추적 불가. OpenAI dashboard에서 직접 확인.',
          'openai-embedding': 'labflow-member embedding-service에 logApiCost 미연결. 추가 작업 필요.',
        },
      });
    } catch (e: any) {
      console.error('[automation:model-usage] 실패:', e?.message || e);
      return reply.code(500).send({ ok: false, error: e?.message || 'unknown' });
    }
  });
}
