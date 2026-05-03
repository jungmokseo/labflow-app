/**
 * Lab Data Proxy — labflow-member의 read-only 데이터를 web에 노출.
 *
 * 인증: Clerk auth (PI만).
 * 백엔드: labflow-member의 /api/lab-data/* endpoints를 X-Sync-Token으로 프록시.
 *
 * Endpoints (web):
 *   GET /api/lab-data/vacations/recent
 *   GET /api/lab-data/vacations/balance
 *   GET /api/lab-data/lab-accounts
 *   GET /api/lab-data/lab-accounts/:id/password
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../config/env.js';
import { authMiddleware } from '../middleware/auth.js';

function memberUrl(path: string, query?: Record<string, string | undefined>) {
  const base = env.LABFLOW_MEMBER_URL.replace(/\/$/, '');
  const url = new URL(`${base}${path}`);
  if (query) for (const [k, v] of Object.entries(query)) if (v != null && v !== '') url.searchParams.set(k, v);
  return url.toString();
}

async function callMember(
  reply: FastifyReply,
  init: { method: string; path: string; query?: Record<string, string | undefined>; body?: unknown },
): Promise<void> {
  const expected = env.LABFLOW_SYNC_TOKEN;
  if (!expected) {
    reply.code(503).send({ error: 'LABFLOW_SYNC_TOKEN not configured on server' });
    return;
  }
  try {
    const r = await fetch(memberUrl(init.path, init.query), {
      method: init.method,
      headers: { 'Content-Type': 'application/json', 'X-Sync-Token': expected },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await r.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
    reply.code(r.status).send(parsed ?? {});
  } catch (err: any) {
    reply.code(502).send({ error: 'member_unreachable', detail: err?.message });
  }
}

export async function labDataRoutes(app: FastifyInstance) {
  app.get('/api/lab-data/vacations/recent', { preHandler: authMiddleware }, async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;
    await callMember(reply, { method: 'GET', path: '/api/lab-data/vacations/recent', query: { limit: q.limit } });
  });

  app.get('/api/lab-data/vacations/balance', { preHandler: authMiddleware }, async (_req, reply) => {
    await callMember(reply, { method: 'GET', path: '/api/lab-data/vacations/balance' });
  });

  app.get('/api/lab-data/lab-accounts', { preHandler: authMiddleware }, async (_req, reply) => {
    await callMember(reply, { method: 'GET', path: '/api/lab-data/lab-accounts' });
  });

  app.get('/api/lab-data/lab-accounts/:id/password', { preHandler: authMiddleware }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await callMember(reply, { method: 'GET', path: `/api/lab-data/lab-accounts/${encodeURIComponent(id)}/password` });
  });
}
