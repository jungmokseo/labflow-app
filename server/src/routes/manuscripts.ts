/**
 * Manuscripts Routes — 노션 논문 파이프라인 view + 자동화
 *
 * GET    /api/manuscripts                    → 목록 (단계+차례별)
 * GET    /api/manuscripts/published-kpi      → 게재 완료 KPI (승진 자료)
 * POST   /api/manuscripts/sync               → 수동 sync 트리거
 * POST   /api/manuscripts/scan-mail          → Gmail 스캔 트리거 (3개월치)
 * GET    /api/manuscripts/unmatched-events   → 매칭 안 된 Gmail 이벤트 목록
 * POST   /api/manuscripts/events/:id/link    → 미매칭 이벤트를 manuscript에 수동 연결
 */
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { syncManuscripts, getManuscripts, getPublishedKpi, patchManuscriptProperty } from '../services/manuscript-sync.js';
import { monitorManuscriptMail, getUnmatchedEvents, linkUnmatchedEvent } from '../services/manuscript-mail-monitor.js';
import { logError } from '../services/error-logger.js';
import { basePrismaClient as prisma } from '../config/prisma.js';

export async function manuscriptRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // ── GET 목록 + 카운트 ─────────────────────
  app.get('/api/manuscripts', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const items = await getManuscripts({ archived: false });
      const counts = {
        piTurn: items.filter(m => m.whoseTurn === 'PI').length,
        studentTurn: items.filter(m => m.whoseTurn === '학생').length,
        journalTurn: items.filter(m => m.whoseTurn === '저널').length,
        writing: items.filter(m => m.stage === '작성').length,
        review: items.filter(m => m.stage === '심사 중').length,
        responding: items.filter(m => m.stage === '대응 중').length,
        accepted: items.filter(m => m.stage === '억셉').length,
        published: items.filter(m => m.stage === '게재 완료').length,
        revisionDueSoon: items.filter(m => m.revisionDueAt && m.revisionDueAt.getTime() - Date.now() < 7 * 86400000).length,
      };
      return reply.send({ items, counts });
    } catch (err: any) {
      logError('background', 'GET /api/manuscripts 실패', { userId: (request as any).user?.id })(err);
      return reply.code(500).send({ error: '목록 조회 실패' });
    }
  });

  // ── GET 게재 완료 KPI (승진 자료) ────────
  app.get('/api/manuscripts/published-kpi', async (_request, reply) => {
    try {
      const kpi = await getPublishedKpi();
      return reply.send(kpi);
    } catch (err: any) {
      return reply.code(500).send({ error: 'KPI 조회 실패', message: err.message });
    }
  });

  // ── POST 수동 sync ─────────────────────────
  app.post('/api/manuscripts/sync', async (_request, reply) => {
    try {
      const r = await syncManuscripts();
      return reply.send({ ok: true, ...r });
    } catch (err: any) {
      return reply.code(500).send({ error: 'sync 실패', message: err.message });
    }
  });

  // ── POST Gmail 스캔 ──────────────────────
  const scanSchema = z.object({ daysAgo: z.number().int().min(1).max(365).optional() });
  app.post('/api/manuscripts/scan-mail', async (request, reply) => {
    try {
      const body = scanSchema.parse(request.body || {});
      const userId = (request as any).user?.id as string | undefined;
      if (!userId) return reply.code(401).send({ error: 'user 없음' });
      const r = await monitorManuscriptMail({ userId, daysAgo: body.daysAgo ?? 90 });
      return reply.send({ ok: true, ...r });
    } catch (err: any) {
      if (err instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid input', details: err.errors });
      return reply.code(500).send({ error: 'Gmail 스캔 실패', message: err.message });
    }
  });

  // ── GET 미매칭 이벤트 ──────────────────────
  app.get('/api/manuscripts/unmatched-events', async (_request, reply) => {
    try {
      const items = await getUnmatchedEvents();
      return reply.send({ items });
    } catch (err: any) {
      return reply.code(500).send({ error: '미매칭 이벤트 조회 실패', message: err.message });
    }
  });

  // ── POST 미매칭 이벤트 → manuscript 연결 ────
  const linkSchema = z.object({ manuscriptId: z.string().min(1) });
  app.post('/api/manuscripts/events/:id/link', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = linkSchema.parse(request.body || {});
      const r = await linkUnmatchedEvent(id, body.manuscriptId);
      return reply.send(r);
    } catch (err: any) {
      if (err instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid input', details: err.errors });
      return reply.code(500).send({ error: '연결 실패', message: err.message });
    }
  });

  // ── PATCH whoseTurn 토글 ───────────────────
  const turnSchema = z.object({ whoseTurn: z.enum(['PI', '학생', '저널']).nullable() });
  app.patch('/api/manuscripts/:id/turn', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = turnSchema.parse(request.body || {});
      // DB 즉시 갱신
      await prisma.manuscript.update({
        where: { id },
        data: {
          whoseTurn: body.whoseTurn,
          lastActivityAt: new Date(),
        },
      });
      // 노션도 갱신 (best-effort)
      const props: any = body.whoseTurn
        ? { "차례": { select: { name: body.whoseTurn } } }
        : { "차례": { select: null } };
      await patchManuscriptProperty(id, props);
      return reply.send({ ok: true, whoseTurn: body.whoseTurn });
    } catch (err: any) {
      if (err instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid input', details: err.errors });
      return reply.code(500).send({ error: '차례 변경 실패', message: err.message });
    }
  });

  // ── PATCH 단계 변경 ───────────────────────
  const stageSchema = z.object({ stage: z.enum(['작성', '심사 중', '대응 중', '억셉', '게재 완료']) });
  app.patch('/api/manuscripts/:id/stage', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = stageSchema.parse(request.body || {});
      await prisma.manuscript.update({
        where: { id },
        data: { stage: body.stage, lastActivityAt: new Date() },
      });
      await patchManuscriptProperty(id, { "단계": { select: { name: body.stage } } });
      return reply.send({ ok: true, stage: body.stage });
    } catch (err: any) {
      if (err instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid input', details: err.errors });
      return reply.code(500).send({ error: '단계 변경 실패', message: err.message });
    }
  });
}
