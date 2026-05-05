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

  // ── PATCH /:id 종합 편집 ─────────────────────
  // 모든 필드 in-place 편집. DB + 노션 양쪽 갱신.
  const updateSchema = z.object({
    title: z.string().min(1).max(300).optional(),
    stage: z.enum(['작성', '심사 중', '대응 중', '억셉', '게재 완료']).optional(),
    whoseTurn: z.enum(['PI', '학생', '저널']).nullable().optional(),
    firstAuthors: z.string().max(300).nullable().optional(),
    piRole: z.enum(['교신', '공저']).nullable().optional(),
    currentJournal: z.string().max(200).nullable().optional(),
    impactFactor: z.number().min(0).max(100).nullable().optional(),
    attempts: z.number().int().min(1).max(20).nullable().optional(),
    rejectHistory: z.string().max(500).nullable().optional(),
    manuscriptNum: z.string().max(100).nullable().optional(),
    submittedAt: z.string().nullable().optional(),  // ISO date
    revisionDueAt: z.string().nullable().optional(),
    publishedAt: z.string().nullable().optional(),
    doi: z.string().nullable().optional(),
    memo: z.string().max(2000).nullable().optional(),
  });
  app.patch('/api/manuscripts/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = updateSchema.parse(request.body || {});

      // DB 갱신 (Date 변환)
      const dbData: any = { lastActivityAt: new Date() };
      if (body.title !== undefined) dbData.title = body.title;
      if (body.stage !== undefined) dbData.stage = body.stage;
      if (body.whoseTurn !== undefined) dbData.whoseTurn = body.whoseTurn;
      if (body.firstAuthors !== undefined) dbData.firstAuthors = body.firstAuthors;
      if (body.piRole !== undefined) dbData.piRole = body.piRole;
      if (body.currentJournal !== undefined) dbData.currentJournal = body.currentJournal;
      if (body.impactFactor !== undefined) dbData.impactFactor = body.impactFactor;
      if (body.attempts !== undefined) dbData.attempts = body.attempts;
      if (body.rejectHistory !== undefined) dbData.rejectHistory = body.rejectHistory;
      if (body.manuscriptNum !== undefined) dbData.manuscriptNum = body.manuscriptNum;
      if (body.doi !== undefined) dbData.doi = body.doi;
      if (body.memo !== undefined) dbData.memo = body.memo;
      if (body.submittedAt !== undefined) dbData.submittedAt = body.submittedAt ? new Date(body.submittedAt) : null;
      if (body.revisionDueAt !== undefined) dbData.revisionDueAt = body.revisionDueAt ? new Date(body.revisionDueAt) : null;
      if (body.publishedAt !== undefined) dbData.publishedAt = body.publishedAt ? new Date(body.publishedAt) : null;

      await prisma.manuscript.update({ where: { id }, data: dbData });

      // 노션 property 갱신 (best-effort, 실패해도 DB는 이미 갱신됨)
      const props: any = {};
      if (body.title !== undefined) props["제목"] = { title: [{ text: { content: body.title } }] };
      if (body.stage !== undefined) props["단계"] = { select: { name: body.stage } };
      if (body.whoseTurn !== undefined) props["차례"] = body.whoseTurn ? { select: { name: body.whoseTurn } } : { select: null };
      if (body.firstAuthors !== undefined) props["1저자 학생"] = { rich_text: body.firstAuthors ? [{ text: { content: body.firstAuthors } }] : [] };
      if (body.piRole !== undefined) props["PI 역할"] = body.piRole ? { select: { name: body.piRole } } : { select: null };
      if (body.currentJournal !== undefined) props["현재/타겟 저널"] = { rich_text: body.currentJournal ? [{ text: { content: body.currentJournal } }] : [] };
      if (body.impactFactor !== undefined) props["Impact Factor"] = { number: body.impactFactor };
      if (body.attempts !== undefined) props["시도 횟수"] = { number: body.attempts };
      if (body.rejectHistory !== undefined) props["리젝 이력"] = { rich_text: body.rejectHistory ? [{ text: { content: body.rejectHistory } }] : [] };
      if (body.manuscriptNum !== undefined) props["Manuscript ID"] = { rich_text: body.manuscriptNum ? [{ text: { content: body.manuscriptNum } }] : [] };
      if (body.doi !== undefined) props["DOI"] = { url: body.doi };
      if (body.memo !== undefined) props["메모"] = { rich_text: body.memo ? [{ text: { content: body.memo } }] : [] };
      if (body.submittedAt !== undefined) props["제출일"] = { date: body.submittedAt ? { start: body.submittedAt } : null };
      if (body.revisionDueAt !== undefined) props["리비전 마감"] = { date: body.revisionDueAt ? { start: body.revisionDueAt } : null };
      if (body.publishedAt !== undefined) props["게재일"] = { date: body.publishedAt ? { start: body.publishedAt } : null };

      const notionOk = Object.keys(props).length > 0
        ? await patchManuscriptProperty(id, props)
        : true;
      return reply.send({ ok: true, notionUpdated: notionOk });
    } catch (err: any) {
      if (err instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid input', details: err.errors });
      return reply.code(500).send({ error: '편집 실패', message: err.message });
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
