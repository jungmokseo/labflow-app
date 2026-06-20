/**
 * 연구 과제 (Grants) Routes
 *
 * GDrive Sheets ↔ Project 모델 (gdrive-sync가 자동 sync).
 * PI 입력 데이터(목표·담당 학생·마일스톤·메모)는 metadata JSON에 저장 — sync 시 보존됨.
 *
 * GET    /api/grants                  → 목록 + KPI
 * PATCH  /api/grants/:id              → metadata 업데이트 (goal/studentLeads/milestones/notes)
 * POST   /api/grants/:id/milestones   → 마일스톤 추가
 * PATCH  /api/grants/:id/milestones/:mid → 마일스톤 토글/수정
 * DELETE /api/grants/:id/milestones/:mid → 마일스톤 삭제
 */
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { basePrismaClient as prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import {
  syncAllGdriveData,
  resetAuthCache,
  getAuthSource,
  getLastAuthDiagnosis,
} from '../services/gdrive-sync.js';

interface Milestone {
  id: string;
  title: string;
  due?: string | null;     // YYYY-MM-DD
  done?: boolean;
  owner?: string | null;
  note?: string | null;
}

interface GrantMetadata {
  goal?: string;
  studentLeads?: string;
  milestones?: Milestone[];
  notes?: string;
  [k: string]: unknown;     // GDrive sync가 추가할 수 있는 다른 필드 보존
}

function failWith(reply: FastifyReply, status: number, label: string, err: unknown) {
  if (err instanceof z.ZodError) {
    return reply.code(400).send({ error: 'Invalid input', details: err.errors });
  }
  const msg = (err as Error)?.message?.slice(0, 100) || 'unknown';
  console.error(`[grants] FAILED ${label}: ${msg}`);
  return reply.code(status).send({ error: label, message: (err as Error)?.message });
}

/** 과제 기간에서 종료일 추출 — '2024-03-01 ~ 2027-02-28', '25.08.25 ~ 30.02.28', 등 다양 */
function extractEndDate(period: string | null): Date | null {
  if (!period) return null;
  // 구분자 split에 의존하지 않고 기간 내 모든 날짜를 찾아 *마지막*(종료일)을 사용한다.
  // 이전: split(~/-) 후 마지막 조각 → 공백 없는 하이픈 구분('2024.03.01-2027.02.28')은 split 실패 →
  //       전체에서 첫 날짜(시작일)를 종료일로 오인 → 진행 중 과제가 '종료됨'으로 오분류됐음.
  const isoMatches = [...period.matchAll(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/g)];
  if (isoMatches.length > 0) {
    const m = isoMatches[isoMatches.length - 1];
    return new Date(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`);
  }
  // 짧은 연도: 30.02.28 → 2030-02-28 (4자리 연도가 없을 때만)
  const shortMatches = [...period.matchAll(/(\d{2})\.(\d{1,2})\.(\d{1,2})/g)];
  if (shortMatches.length > 0) {
    const m = shortMatches[shortMatches.length - 1];
    const yr = Number(m[1]);
    const fullYear = yr < 50 ? 2000 + yr : 1900 + yr;
    return new Date(`${fullYear}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`);
  }
  return null;
}

function daysUntil(d: Date): number {
  return Math.ceil((d.getTime() - Date.now()) / 86400000);
}

export async function grantRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // env.LAB_ID 단일 lab 배포에서도 권한 미들웨어가 작동하도록 request.labId 채워준다.
  // (resolveLabPermission이 request.labId 기반으로 LabMember/Lab.ownerId 조회.)
  app.addHook('preHandler', async (request) => {
    if (!request.labId && env.LAB_ID) request.labId = env.LAB_ID;
  });

  const labIdOrThrow = (request: FastifyRequest): string | null => {
    return env.LAB_ID || request.labId || null;
  };

  // 같은 분류 규칙을 서버 KPI와 프론트 탭에서 공유 (한 row가 여러 탭에 중복 카운트되지 않도록).
  // 종료됨 → 신청 중 → 종료 임박 → 진행 중 — 프론트 classifyTab()과 1:1 일치.
  function classifyGrantTab(g: { status: string; daysToEnd: number | null }): 'active' | 'endingSoon' | 'submitted' | 'completed' {
    if (g.daysToEnd !== null && g.daysToEnd < 0) return 'completed';
    if (g.status === 'completed') return 'completed';
    if (g.status === 'submitted' || g.status === 'preparing') return 'submitted';
    if ((g.daysToEnd !== null && g.daysToEnd >= 0 && g.daysToEnd <= 90) || g.status === 'ending_soon') return 'endingSoon';
    return 'active';
  }

  // ── GET 목록 + KPI ──────────────────────────
  app.get('/api/grants', { preHandler: requirePermission('VIEWER') }, async (request, reply) => {
    try {
      const labId = labIdOrThrow(request);
      if (!labId) return reply.code(400).send({ error: 'LAB_ID 미설정' });

      const projects = await prisma.project.findMany({
        where: { labId },
        orderBy: [{ status: 'asc' }, { syncedAt: 'desc' }],
      });

      // 종료 D-day 계산 + status auto-correction (DB의 ending_soon 외에 D-90 안 들어오는 케이스 보강)
      const now = Date.now();
      const enriched = projects.map(p => {
        const endDate = extractEndDate(p.period);
        const daysToEnd = endDate ? Math.ceil((endDate.getTime() - now) / 86400000) : null;
        const md = (p.metadata as GrantMetadata | null) || {};
        const milestones = Array.isArray(md.milestones) ? md.milestones : [];
        const milestoneStats = {
          total: milestones.length,
          done: milestones.filter(m => m.done).length,
          dueSoon: milestones.filter(m => !m.done && m.due && daysUntil(new Date(m.due)) <= 14 && daysUntil(new Date(m.due)) >= -1).length,
        };
        return {
          ...p,
          metadata: md,
          endDate: endDate?.toISOString() || null,
          daysToEnd,
          milestoneStats,
        };
      });

      // KPI — classifyGrantTab으로 한 row가 정확히 한 탭에만 카운트되도록 정렬 (UI와 일치)
      const counts = enriched.reduce(
        (acc, g) => {
          const tab = classifyGrantTab(g);
          acc[tab]++;
          acc.milestonesDueSoon += g.milestoneStats.dueSoon;
          return acc;
        },
        { active: 0, endingSoon: 0, submitted: 0, completed: 0, total: enriched.length, milestonesDueSoon: 0 } as {
          active: number; endingSoon: number; submitted: number; completed: number;
          total: number; milestonesDueSoon: number;
        },
      );

      // Caller capabilities — UI에서 학생(VIEWER)에게 sync/편집 컨트롤 숨기기
      const callerPermission = request.labPermission ?? 'VIEWER';
      const caller = {
        permission: callerPermission,
        canEdit: ['EDITOR', 'ADMIN', 'OWNER'].includes(callerPermission),
        canSync: callerPermission === 'OWNER',
      };

      return reply.send({ items: enriched, counts, caller });
    } catch (err) {
      return failWith(reply, 500, '과제 목록 조회 실패', err);
    }
  });

  // ── PATCH metadata 갱신 (goal / studentLeads / notes) ──
  const updateSchema = z.object({
    goal: z.string().max(2000).nullable().optional(),
    studentLeads: z.string().max(300).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
  });
  app.patch('/api/grants/:id', { preHandler: requirePermission('EDITOR') }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = updateSchema.parse(request.body || {});

      const labId = labIdOrThrow(request);
      const existing = await prisma.project.findUnique({ where: { id } });
      if (!existing) return reply.code(404).send({ error: '과제 없음' });
      if (labId && existing.labId !== labId) return reply.code(403).send({ error: '다른 연구실의 과제입니다' });

      const md = ((existing.metadata as GrantMetadata) || {});
      if (body.goal !== undefined) md.goal = body.goal || undefined;
      if (body.studentLeads !== undefined) md.studentLeads = body.studentLeads || undefined;
      if (body.notes !== undefined) md.notes = body.notes || undefined;

      await prisma.project.update({
        where: { id },
        data: { metadata: md as any },
      });
      return reply.send({ ok: true });
    } catch (err) {
      return failWith(reply, 500, '과제 편집 실패', err);
    }
  });

  // ── POST 마일스톤 추가 ───────────────────────
  const addMilestoneSchema = z.object({
    title: z.string().min(1).max(200),
    due: z.string().nullable().optional(),
    owner: z.string().max(100).nullable().optional(),
    note: z.string().max(500).nullable().optional(),
  });
  app.post('/api/grants/:id/milestones', { preHandler: requirePermission('EDITOR') }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = addMilestoneSchema.parse(request.body || {});
      const labId = labIdOrThrow(request);
      const existing = await prisma.project.findUnique({ where: { id } });
      if (!existing) return reply.code(404).send({ error: '과제 없음' });
      if (labId && existing.labId !== labId) return reply.code(403).send({ error: '다른 연구실의 과제입니다' });

      const md = ((existing.metadata as GrantMetadata) || {});
      const milestones = Array.isArray(md.milestones) ? md.milestones : [];
      const newMs: Milestone = {
        id: `ms_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        title: body.title,
        due: body.due || null,
        owner: body.owner || null,
        note: body.note || null,
        done: false,
      };
      md.milestones = [...milestones, newMs];

      await prisma.project.update({ where: { id }, data: { metadata: md as any } });
      return reply.send({ ok: true, milestone: newMs });
    } catch (err) {
      return failWith(reply, 500, '마일스톤 추가 실패', err);
    }
  });

  // ── PATCH 마일스톤 토글/수정 ─────────────────
  const patchMsSchema = z.object({
    title: z.string().max(200).optional(),
    due: z.string().nullable().optional(),
    owner: z.string().max(100).nullable().optional(),
    note: z.string().max(500).nullable().optional(),
    done: z.boolean().optional(),
  });
  app.patch('/api/grants/:id/milestones/:mid', { preHandler: requirePermission('EDITOR') }, async (request, reply) => {
    try {
      const { id, mid } = request.params as { id: string; mid: string };
      const body = patchMsSchema.parse(request.body || {});
      const labId = labIdOrThrow(request);
      const existing = await prisma.project.findUnique({ where: { id } });
      if (!existing) return reply.code(404).send({ error: '과제 없음' });
      if (labId && existing.labId !== labId) return reply.code(403).send({ error: '다른 연구실의 과제입니다' });

      const md = ((existing.metadata as GrantMetadata) || {});
      const milestones = Array.isArray(md.milestones) ? md.milestones : [];
      const idx = milestones.findIndex(m => m.id === mid);
      if (idx === -1) return reply.code(404).send({ error: '마일스톤 없음' });

      milestones[idx] = { ...milestones[idx], ...body };
      md.milestones = milestones;
      await prisma.project.update({ where: { id }, data: { metadata: md as any } });
      return reply.send({ ok: true, milestone: milestones[idx] });
    } catch (err) {
      return failWith(reply, 500, '마일스톤 수정 실패', err);
    }
  });

  // ── POST 수동 GDrive sync 트리거 ────────────
  app.post('/api/grants/sync', { preHandler: requirePermission('OWNER') }, async (request, reply) => {
    try {
      const labId = labIdOrThrow(request);
      if (!labId) return reply.code(400).send({ error: 'LAB_ID 미설정' });

      // OAuth 토큰 캐시 리셋 — 사용자가 /settings에서 재발급한 토큰 즉시 반영
      resetAuthCache();

      const results = await syncAllGdriveData(labId);
      const projectResult = results.find(r => r.file === '과제 정보');

      // detailFields 매칭 통계 — 사용자가 sync 후 결과를 정확히 알 수 있도록
      const allProjects = await prisma.project.findMany({
        where: { labId },
        select: { metadata: true },
      });
      const detailMatched = allProjects.filter(p => {
        const md = (p.metadata as any) || {};
        return md.detailFields && Object.keys(md.detailFields).length > 0;
      }).length;

      return reply.send({
        ok: true,
        results,
        projectRows: projectResult?.rows ?? 0,
        totalProjects: allProjects.length,
        detailMatched,
        authSource: getAuthSource(),
      });
    } catch (err) {
      return failWith(reply, 500, 'GDrive sync 실패', err);
    }
  });

  // ── GET /api/grants/oauth-status — 진단용 ─────
  // OAuth가 어떤 토큰 소스를 사용하고 있는지, 마지막 인증 시 발생한 에러는 무엇인지 확인.
  app.get('/api/grants/oauth-status', { preHandler: requirePermission('ADMIN') }, async (request, reply) => {
    try {
      const diag = getLastAuthDiagnosis();
      const tokenCount = await prisma.gmailToken.count({
        where: { primary: true, refreshToken: { not: null } },
      });
      const ownerToken = env.LAB_OWNER_EMAIL
        ? await prisma.gmailToken.findFirst({
            where: { email: env.LAB_OWNER_EMAIL, refreshToken: { not: null } },
            select: { email: true, updatedAt: true, primary: true },
          })
        : null;
      return reply.send({
        ok: true,
        envTokenSet: !!env.GOOGLE_REFRESH_TOKEN,
        currentAuthSource: getAuthSource(),
        primaryGmailTokens: tokenCount,
        ownerToken,
        lastDiagnosis: diag,
      });
    } catch (err) {
      return failWith(reply, 500, 'OAuth 진단 실패', err);
    }
  });

  // ── DELETE 마일스톤 ──────────────────────────
  app.delete('/api/grants/:id/milestones/:mid', { preHandler: requirePermission('EDITOR') }, async (request, reply) => {
    try {
      const { id, mid } = request.params as { id: string; mid: string };
      const labId = labIdOrThrow(request);
      const existing = await prisma.project.findUnique({ where: { id } });
      if (!existing) return reply.code(404).send({ error: '과제 없음' });
      if (labId && existing.labId !== labId) return reply.code(403).send({ error: '다른 연구실의 과제입니다' });
      const md = ((existing.metadata as GrantMetadata) || {});
      const milestones = Array.isArray(md.milestones) ? md.milestones : [];
      md.milestones = milestones.filter(m => m.id !== mid);
      await prisma.project.update({ where: { id }, data: { metadata: md as any } });
      return reply.send({ ok: true });
    } catch (err) {
      return failWith(reply, 500, '마일스톤 삭제 실패', err);
    }
  });
}
