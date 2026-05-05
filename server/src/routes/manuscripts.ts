/**
 * Manuscripts Routes — 노션 논문 파이프라인 view + 자동화
 *
 * GET    /api/manuscripts                    → 목록 (단계+차례별)
 * GET    /api/manuscripts/published-kpi      → 게재 완료 KPI (승진 자료)
 * POST   /api/manuscripts/sync               → 수동 sync 트리거
 * POST   /api/manuscripts/scan-mail          → Gmail 스캔 트리거
 * GET    /api/manuscripts/unmatched-events   → 매칭 안 된 Gmail 이벤트 목록
 * POST   /api/manuscripts/events/:id/link    → 미매칭 이벤트를 manuscript에 수동 연결
 * PATCH  /api/manuscripts/:id                → 종합 편집 (DB + 노션)
 * PATCH  /api/manuscripts/:id/turn           → whoseTurn 토글 (web 호환)
 * PATCH  /api/manuscripts/:id/stage          → 단계 변경 (web 호환)
 */
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import {
  syncManuscripts,
  getManuscripts,
  getPublishedKpi,
  patchManuscriptProperty,
} from '../services/manuscript-sync.js';
import {
  monitorManuscriptMail,
  getUnmatchedEvents,
  linkUnmatchedEvent,
} from '../services/manuscript-mail-monitor.js';
import { logError } from '../services/error-logger.js';
import { basePrismaClient as prisma } from '../config/prisma.js';

// ─────────────────────────────────────────────
// 공통: 에러 응답 헬퍼
// ─────────────────────────────────────────────

function failWith(reply: FastifyReply, status: number, label: string, err: unknown) {
  if (err instanceof z.ZodError) {
    return reply.code(400).send({ error: 'Invalid input', details: err.errors });
  }
  const msg = (err as Error)?.message?.slice(0, 100) || 'unknown';
  console.error(`[manuscript-routes] FAILED ${label}: ${msg}`);
  return reply.code(status).send({ error: label, message: (err as Error)?.message });
}

// ─────────────────────────────────────────────
// 종합 편집 — DB + 노션 양쪽 갱신
// ─────────────────────────────────────────────

const STAGE_VALUES = ['작성', '심사 중', '대응 중', '억셉', '게재 완료'] as const;
const TURN_VALUES = ['PI', '학생', '저널'] as const;

const updateSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  stage: z.enum(STAGE_VALUES).optional(),
  whoseTurn: z.enum(TURN_VALUES).nullable().optional(),
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
type UpdatePayload = z.infer<typeof updateSchema>;

/** body → Prisma update payload (lastActivityAt 자동) */
function toDbData(body: UpdatePayload): Record<string, unknown> {
  const d: Record<string, unknown> = { lastActivityAt: new Date() };
  if (body.title !== undefined) d.title = body.title;
  if (body.stage !== undefined) d.stage = body.stage;
  if (body.whoseTurn !== undefined) d.whoseTurn = body.whoseTurn;
  if (body.firstAuthors !== undefined) d.firstAuthors = body.firstAuthors;
  if (body.piRole !== undefined) d.piRole = body.piRole;
  if (body.currentJournal !== undefined) d.currentJournal = body.currentJournal;
  if (body.impactFactor !== undefined) d.impactFactor = body.impactFactor;
  if (body.attempts !== undefined) d.attempts = body.attempts;
  if (body.rejectHistory !== undefined) d.rejectHistory = body.rejectHistory;
  if (body.manuscriptNum !== undefined) d.manuscriptNum = body.manuscriptNum;
  if (body.doi !== undefined) d.doi = body.doi;
  if (body.memo !== undefined) d.memo = body.memo;
  if (body.submittedAt !== undefined) d.submittedAt = body.submittedAt ? new Date(body.submittedAt) : null;
  if (body.revisionDueAt !== undefined) d.revisionDueAt = body.revisionDueAt ? new Date(body.revisionDueAt) : null;
  if (body.publishedAt !== undefined) d.publishedAt = body.publishedAt ? new Date(body.publishedAt) : null;
  return d;
}

const richText = (v: string | null | undefined) =>
  v ? { rich_text: [{ text: { content: v } }] } : { rich_text: [] };

const selectOrNull = (v: string | null | undefined) =>
  v ? { select: { name: v } } : { select: null };

const dateOrNull = (v: string | null | undefined) =>
  v ? { date: { start: v } } : { date: null };

/** body → Notion property payload */
function toNotionProps(body: UpdatePayload): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  if (body.title !== undefined) p["제목"] = { title: [{ text: { content: body.title } }] };
  if (body.stage !== undefined) p["단계"] = { select: { name: body.stage } };
  if (body.whoseTurn !== undefined) p["차례"] = selectOrNull(body.whoseTurn);
  if (body.firstAuthors !== undefined) p["1저자 학생"] = richText(body.firstAuthors);
  if (body.piRole !== undefined) p["PI 역할"] = selectOrNull(body.piRole);
  if (body.currentJournal !== undefined) p["현재/타겟 저널"] = richText(body.currentJournal);
  if (body.impactFactor !== undefined) p["Impact Factor"] = { number: body.impactFactor };
  if (body.attempts !== undefined) p["시도 횟수"] = { number: body.attempts };
  if (body.rejectHistory !== undefined) p["리젝 이력"] = richText(body.rejectHistory);
  if (body.manuscriptNum !== undefined) p["Manuscript ID"] = richText(body.manuscriptNum);
  if (body.doi !== undefined) p["DOI"] = { url: body.doi };
  if (body.memo !== undefined) p["메모"] = richText(body.memo);
  if (body.submittedAt !== undefined) p["제출일"] = dateOrNull(body.submittedAt);
  if (body.revisionDueAt !== undefined) p["리비전 마감"] = dateOrNull(body.revisionDueAt);
  if (body.publishedAt !== undefined) p["게재일"] = dateOrNull(body.publishedAt);
  return p;
}

/** 종합 편집 적용 — DB + 노션. 노션 실패는 best-effort. */
async function applyUpdate(id: string, body: UpdatePayload): Promise<{ notionUpdated: boolean }> {
  await prisma.manuscript.update({ where: { id }, data: toDbData(body) });
  const props = toNotionProps(body);
  const notionUpdated = Object.keys(props).length > 0
    ? await patchManuscriptProperty(id, props)
    : true;
  return { notionUpdated };
}

// ─────────────────────────────────────────────
// 라우터
// ─────────────────────────────────────────────

export async function manuscriptRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // GET 목록 + 카운트
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
    } catch (err) {
      logError('background', 'GET /api/manuscripts 실패', { userId: (request as any).user?.id })(err as Error);
      return failWith(reply, 500, '목록 조회 실패', err);
    }
  });

  // GET 게재 완료 KPI
  app.get('/api/manuscripts/published-kpi', async (_request, reply) => {
    try {
      return reply.send(await getPublishedKpi());
    } catch (err) {
      return failWith(reply, 500, 'KPI 조회 실패', err);
    }
  });

  // POST 수동 sync
  app.post('/api/manuscripts/sync', async (_request, reply) => {
    try {
      return reply.send({ ok: true, ...(await syncManuscripts()) });
    } catch (err) {
      return failWith(reply, 500, 'sync 실패', err);
    }
  });

  // POST Gmail 스캔
  const scanSchema = z.object({ daysAgo: z.number().int().min(1).max(365).optional() });
  app.post('/api/manuscripts/scan-mail', async (request, reply) => {
    try {
      const body = scanSchema.parse(request.body || {});
      const userId = (request as any).user?.id as string | undefined;
      if (!userId) return reply.code(401).send({ error: 'user 없음' });
      const r = await monitorManuscriptMail({ userId, daysAgo: body.daysAgo ?? 90 });
      return reply.send({ ok: true, ...r });
    } catch (err) {
      return failWith(reply, 500, 'Gmail 스캔 실패', err);
    }
  });

  // GET 미매칭 이벤트
  app.get('/api/manuscripts/unmatched-events', async (_request, reply) => {
    try {
      return reply.send({ items: await getUnmatchedEvents() });
    } catch (err) {
      return failWith(reply, 500, '미매칭 이벤트 조회 실패', err);
    }
  });

  // POST 미매칭 이벤트 → manuscript 연결
  const linkSchema = z.object({ manuscriptId: z.string().min(1) });
  app.post('/api/manuscripts/events/:id/link', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = linkSchema.parse(request.body || {});
      return reply.send(await linkUnmatchedEvent(id, body.manuscriptId));
    } catch (err) {
      return failWith(reply, 500, '연결 실패', err);
    }
  });

  // PATCH /:id — 종합 편집
  app.patch('/api/manuscripts/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = updateSchema.parse(request.body || {});
      const r = await applyUpdate(id, body);
      return reply.send({ ok: true, notionUpdated: r.notionUpdated });
    } catch (err) {
      return failWith(reply, 500, '편집 실패', err);
    }
  });

  // PATCH /:id/turn — whoseTurn 토글 (web 호환 endpoint, 종합 PATCH로 위임)
  const turnSchema = z.object({ whoseTurn: z.enum(TURN_VALUES).nullable() });
  app.patch('/api/manuscripts/:id/turn', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = turnSchema.parse(request.body || {});
      await applyUpdate(id, { whoseTurn: body.whoseTurn });
      return reply.send({ ok: true, whoseTurn: body.whoseTurn });
    } catch (err) {
      return failWith(reply, 500, '차례 변경 실패', err);
    }
  });

  // PATCH /:id/stage — 단계 변경 (web 호환 endpoint, 종합 PATCH로 위임)
  const stageSchema = z.object({ stage: z.enum(STAGE_VALUES) });
  app.patch('/api/manuscripts/:id/stage', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = stageSchema.parse(request.body || {});
      await applyUpdate(id, { stage: body.stage });
      return reply.send({ ok: true, stage: body.stage });
    } catch (err) {
      return failWith(reply, 500, '단계 변경 실패', err);
    }
  });
}
