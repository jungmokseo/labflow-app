/**
 * Follow-up Proxy — BLISS-bot 미답변 질문을 labflow-member에서 가져와 web에 노출.
 *
 * 인증: Clerk auth (PI만 접근).
 * 백엔드: labflow-member의 /api/follow-up endpoint를 X-Sync-Token으로 프록시.
 *
 * Endpoints (web):
 *   GET    /api/follow-up?status=pending|answered|all
 *   GET    /api/follow-up/:id
 *   PATCH  /api/follow-up/:id/answer
 *   PATCH  /api/follow-up/:id/skip
 *   DELETE /api/follow-up/:id
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../config/env.js';
import { authMiddleware } from '../middleware/auth.js';

function memberUrl(path: string, query?: Record<string, string | undefined>) {
  const base = env.LABFLOW_MEMBER_URL.replace(/\/$/, '');
  const url = new URL(`${base}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v != null && v !== '') url.searchParams.set(k, v);
    }
  }
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
      headers: {
        'Content-Type': 'application/json',
        'X-Sync-Token': expected,
      },
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

export async function followUpRoutes(app: FastifyInstance) {
  // GET /api/follow-up
  app.get('/api/follow-up', { preHandler: authMiddleware }, async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as Record<string, string | undefined>;
    await callMember(reply, {
      method: 'GET',
      path: '/api/follow-up',
      query: { status: q.status, limit: q.limit, cursor: q.cursor },
    });
  });

  // GET /api/follow-up/:id
  app.get('/api/follow-up/:id', { preHandler: authMiddleware }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    await callMember(reply, { method: 'GET', path: `/api/follow-up/${encodeURIComponent(id)}` });
  });

  // PATCH /api/follow-up/:id/answer
  app.patch('/api/follow-up/:id/answer', { preHandler: authMiddleware }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    // 답변자 이름 자동 주입 (PI)
    const resolvedBy = (request as any).userName || (request as any).userEmail || 'PI';
    await callMember(reply, {
      method: 'PATCH',
      path: `/api/follow-up/${encodeURIComponent(id)}/answer`,
      body: { ...body, resolvedBy: body.resolvedBy ?? resolvedBy },
    });
  });

  // PATCH /api/follow-up/:id/skip
  app.patch('/api/follow-up/:id/skip', { preHandler: authMiddleware }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const resolvedBy = (request as any).userName || (request as any).userEmail || 'PI';
    await callMember(reply, {
      method: 'PATCH',
      path: `/api/follow-up/${encodeURIComponent(id)}/skip`,
      body: { ...body, resolvedBy: body.resolvedBy ?? resolvedBy },
    });
  });

  // DELETE /api/follow-up/:id
  app.delete('/api/follow-up/:id', { preHandler: authMiddleware }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    await callMember(reply, { method: 'DELETE', path: `/api/follow-up/${encodeURIComponent(id)}` });
  });
}
