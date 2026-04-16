/**
 * Wiki Routes — Karpathy 스타일 지식 위키 API
 *
 * GET    /api/wiki              → 위키 아티클 목록 (category 필터 가능)
 * GET    /api/wiki/status       → 위키 상태
 * GET    /api/wiki/:id          → 특정 아티클
 * POST   /api/wiki/ingest       → 수동 ingest 트리거 (OWNER만)
 * POST   /api/wiki/synthesis    → 수동 deep synthesis 트리거 (OWNER만)
 * PUT    /api/wiki/:id          → 아티클 수정 (OWNER만)
 * DELETE /api/wiki/:id          → 아티클 삭제 (OWNER만)
 *
 * NOTE: requirePermission preHandler 사용 금지 — request.labId 미설정 타이밍 버그.
 *       대신 resolveLabId(userId) 후 직접 owner 체크.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../config/prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import { logError } from '../services/error-logger.js';
import { enqueueNewData, ingestAndCompile, deepSynthesis, getWikiStatus, diagnoseNotion, logIngestEvent, getIngestLogs, clearIngestLogs } from '../services/wiki-engine.js';
import { generateWeeklyBriefing } from '../services/weekly-briefing.js';

// labId별 ingest 실행 락 — 동일 lab 중복 실행 방지
// (Railway는 단일 컨테이너 기준. 멀티 인스턴스면 DB 락 필요)
const ingestLocks = new Set<string>();

/** userId로 lab을 조회 (owner 우선, 그 다음 member) */
async function resolveLabId(userId: string): Promise<string | null> {
  const owned = await prisma.lab.findFirst({ where: { ownerId: userId }, select: { id: true } });
  if (owned) return owned.id;
  const membership = await prisma.labMember.findFirst({
    where: { userId, active: true },
    select: { labId: true },
  });
  return membership?.labId ?? null;
}

/** userId가 labId의 owner인지 확인 */
async function isLabOwner(userId: string, labId: string): Promise<boolean> {
  const lab = await prisma.lab.findFirst({ where: { id: labId, ownerId: userId }, select: { id: true } });
  return !!lab;
}

export async function wikiRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authMiddleware);

  // ── GET /api/wiki — 아티클 목록 ──────────────────────────
  app.get('/api/wiki', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId!;
    const labId = await resolveLabId(userId);
    if (!labId) return reply.code(400).send({ error: '연구실이 설정되지 않았습니다' });

    const query = request.query as Record<string, string>;
    const category = query.category;
    const limit = Math.min(parseInt(query.limit || '50', 10), 200);

    try {
      const articles = await prisma.wikiArticle.findMany({
        where: {
          labId,
          ...(category ? { category } : {}),
        },
        select: {
          id: true,
          title: true,
          category: true,
          tags: true,
          version: true,
          sources: true,
          updatedAt: true,
          createdAt: true,
        },
        orderBy: { updatedAt: 'desc' },
        take: limit,
      });

      return reply.send({ articles, total: articles.length });
    } catch (err) {
      logError('background', 'GET /api/wiki 실패', { labId })(err);
      return reply.code(500).send({ error: '위키 목록 조회 실패' });
    }
  });

  // ── GET /api/wiki/status — 위키 상태 ─────────────────────
  app.get('/api/wiki/status', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId!;
    const labId = await resolveLabId(userId);
    if (!labId) return reply.code(400).send({ error: '연구실이 설정되지 않았습니다' });

    try {
      const status = await getWikiStatus(labId);
      return reply.send(status);
    } catch (err) {
      logError('background', 'GET /api/wiki/status 실패', { labId })(err);
      return reply.code(500).send({ error: '위키 상태 조회 실패' });
    }
  });

  // ── GET /api/wiki/notion-diagnosis — Notion 연결 진단 (OWNER만) ───
  // :id 라우트보다 먼저 선언 — 정적 경로 우선 매칭 확실히 보장
  app.get('/api/wiki/notion-diagnosis', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId!;
    const labId = await resolveLabId(userId);
    if (!labId) return reply.code(400).send({ error: '연구실이 설정되지 않았습니다' });

    if (!(await isLabOwner(userId, labId))) {
      return reply.code(403).send({ error: 'OWNER 권한이 필요합니다' });
    }

    try {
      const result = await diagnoseNotion();
      return reply.send(result);
    } catch (err) {
      logError('background', 'GET /api/wiki/notion-diagnosis 실패', { labId })(err);
      return reply.code(500).send({ error: 'Notion 진단 실패' });
    }
  });

  // ── GET /api/wiki/:id — 특정 아티클 ─────────────────────
  app.get('/api/wiki/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId!;
    const labId = await resolveLabId(userId);
    if (!labId) return reply.code(400).send({ error: '연구실이 설정되지 않았습니다' });

    const { id } = request.params as { id: string };

    try {
      const article = await prisma.wikiArticle.findFirst({
        where: { id, labId },
      });

      if (!article) return reply.code(404).send({ error: '아티클을 찾을 수 없습니다' });
      return reply.send(article);
    } catch (err) {
      logError('background', 'GET /api/wiki/:id 실패', { labId })(err);
      return reply.code(500).send({ error: '아티클 조회 실패' });
    }
  });

  // ── POST /api/wiki/ingest — 수동 ingest 트리거 (OWNER만) ─
  // 즉시 202 반환 후 백그라운드에서 처리 (Vercel 30s proxy 타임아웃 우회)
  app.post('/api/wiki/ingest', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId!;
    const labId = await resolveLabId(userId);
    if (!labId) return reply.code(400).send({ error: '연구실이 설정되지 않았습니다' });

    if (!(await isLabOwner(userId, labId))) {
      return reply.code(403).send({ error: 'OWNER 권한이 필요합니다' });
    }

    // 이미 실행 중이면 노옵 — 기존 작업이 계속 진행됨
    if (ingestLocks.has(labId)) {
      logIngestEvent(labId, 'info', 'Ingest 요청됨 — 이미 진행 중이라 스킵');
      return reply.code(202).send({ message: '이미 Ingest 진행 중', status: 'already_running' });
    }

    // 락 획득 + 즉시 응답 — 백그라운드에서 실제 처리
    ingestLocks.add(labId);
    clearIngestLogs(labId); // 새 Ingest 시작 시 이전 로그 초기화
    logIngestEvent(labId, 'info', 'Ingest 시작');
    reply.code(202).send({ message: 'Ingest 시작됨', status: 'processing' });

    // 백그라운드 처리 (응답과 무관하게 실행)
    setImmediate(async () => {
      try {
        const enqueued = await enqueueNewData(labId, userId);
        logIngestEvent(labId, 'info', `큐 추가 완료: 총 ${enqueued}건 신규`);

        let rounds = 0;
        const maxRounds = 10;
        while (rounds < maxRounds) {
          rounds++;
          logIngestEvent(labId, 'info', `라운드 ${rounds}/${maxRounds} 시작`);
          const result = await ingestAndCompile(labId, userId);
          logIngestEvent(labId, 'info', `라운드 ${rounds} 종료: 큐 ${result.processed}개, 아티클 ${result.updated.length}개`);
          if (result.processed === 0) break;
        }
        logIngestEvent(labId, 'info', `배치 완료 (${rounds} 라운드 수행)`);
      } catch (err) {
        logIngestEvent(labId, 'error', `배치 실패: ${(err as any)?.message ?? err}`);
        logError('background', '[wiki] background ingest 실패', { labId })(err);
      } finally {
        ingestLocks.delete(labId);
      }
    });
  });

  // ── GET /api/wiki/ingest-log — Ingest 이벤트 로그 조회 ────
  app.get('/api/wiki/ingest-log', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId!;
    const labId = await resolveLabId(userId);
    if (!labId) return reply.code(400).send({ error: '연구실이 설정되지 않았습니다' });

    const query = request.query as Record<string, string>;
    const sinceTs = query.since ? parseInt(query.since, 10) : undefined;

    const events = getIngestLogs(labId, sinceTs);
    const isRunning = ingestLocks.has(labId);
    return reply.send({ events, isRunning });
  });

  // ── POST /api/wiki/reset-notion — Notion 큐 재처리 초기화 (OWNER만) ─
  // 처리 완료된 모든 notion_page 큐 항목을 삭제하여 다음 Ingest 시 전부 재처리
  app.post('/api/wiki/reset-notion', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId!;
    const labId = await resolveLabId(userId);
    if (!labId) return reply.code(400).send({ error: '연구실이 설정되지 않았습니다' });

    if (!(await isLabOwner(userId, labId))) {
      return reply.code(403).send({ error: 'OWNER 권한이 필요합니다' });
    }

    try {
      const result = await prisma.wikiRawQueue.deleteMany({
        where: { labId, sourceType: 'notion_page' },
      });
      return reply.send({
        message: `Notion 큐 초기화 완료 — ${result.count}건 삭제됨`,
        deleted: result.count,
      });
    } catch (err) {
      logError('background', 'POST /api/wiki/reset-notion 실패', { labId })(err);
      return reply.code(500).send({ error: 'Notion 큐 초기화 실패' });
    }
  });

  // ── POST /api/wiki/weekly-briefing — 주간 브리핑 생성 (OWNER만) ─
  app.post('/api/wiki/weekly-briefing', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId!;
    const labId = await resolveLabId(userId);
    if (!labId) return reply.code(400).send({ error: '연구실이 설정되지 않았습니다' });
    if (!(await isLabOwner(userId, labId))) {
      return reply.code(403).send({ error: 'OWNER 권한이 필요합니다' });
    }

    const query = request.query as Record<string, string>;
    const days = query.days ? Math.max(1, Math.min(30, parseInt(query.days, 10))) : 7;

    try {
      const result = await generateWeeklyBriefing(labId, userId, days);
      return reply.send({
        message: `주간 브리핑 생성 완료 — "${result.savedArticleTitle}"`,
        title: result.savedArticleTitle,
        stats: result.stats,
        briefing: result.briefingMarkdown,
      });
    } catch (err: any) {
      logError('background', 'POST /api/wiki/weekly-briefing 실패', { labId })(err);
      return reply.code(500).send({ error: `브리핑 생성 실패: ${err.message}` });
    }
  });

  // ── POST /api/wiki/synthesis — 수동 synthesis 트리거 (OWNER만) ─
  // 즉시 202 반환 후 백그라운드에서 처리 (Vercel 30s proxy 타임아웃 우회)
  app.post('/api/wiki/synthesis', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId!;
    const labId = await resolveLabId(userId);
    if (!labId) return reply.code(400).send({ error: '연구실이 설정되지 않았습니다' });

    if (!(await isLabOwner(userId, labId))) {
      return reply.code(403).send({ error: 'OWNER 권한이 필요합니다' });
    }

    reply.code(202).send({ message: 'Deep synthesis 시작됨', status: 'processing' });

    setImmediate(async () => {
      try {
        await deepSynthesis(labId);
        console.log('[wiki] deepSynthesis complete');
      } catch (err) {
        logError('background', '[wiki] background deepSynthesis 실패', { labId })(err);
      }
    });
  });

  // ── PUT /api/wiki/:id — 아티클 수정 (OWNER만) ───────────
  app.put('/api/wiki/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId!;
    const labId = await resolveLabId(userId);
    if (!labId) return reply.code(400).send({ error: '연구실이 설정되지 않았습니다' });

    if (!(await isLabOwner(userId, labId))) {
      return reply.code(403).send({ error: 'OWNER 권한이 필요합니다' });
    }

    const { id } = request.params as { id: string };
    const body = request.body as { title?: string; category?: string; content?: string; tags?: string[] };

    try {
      const article = await prisma.wikiArticle.findFirst({ where: { id, labId } });
      if (!article) return reply.code(404).send({ error: '아티클을 찾을 수 없습니다' });

      const updated = await prisma.wikiArticle.update({
        where: { id },
        data: {
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.category !== undefined ? { category: body.category } : {}),
          ...(body.content !== undefined ? { content: body.content } : {}),
          ...(body.tags !== undefined ? { tags: body.tags } : {}),
          version: { increment: 1 },
        },
      });
      return reply.send(updated);
    } catch (err) {
      logError('background', 'PUT /api/wiki/:id 실패', { labId })(err);
      return reply.code(500).send({ error: '아티클 수정 실패' });
    }
  });

  // ── DELETE /api/wiki/:id — 아티클 삭제 (OWNER만) ─────────
  app.delete('/api/wiki/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId!;
    const labId = await resolveLabId(userId);
    if (!labId) return reply.code(400).send({ error: '연구실이 설정되지 않았습니다' });

    if (!(await isLabOwner(userId, labId))) {
      return reply.code(403).send({ error: 'OWNER 권한이 필요합니다' });
    }

    const { id } = request.params as { id: string };

    try {
      const article = await prisma.wikiArticle.findFirst({ where: { id, labId } });
      if (!article) return reply.code(404).send({ error: '아티클을 찾을 수 없습니다' });

      await prisma.wikiArticle.delete({ where: { id } });
      return reply.send({ message: '아티클 삭제 완료', id });
    } catch (err) {
      logError('background', 'DELETE /api/wiki/:id 실패', { labId })(err);
      return reply.code(500).send({ error: '아티클 삭제 실패' });
    }
  });
}
