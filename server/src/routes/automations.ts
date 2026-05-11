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
}
