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
import { basePrismaClient as prisma } from '../config/prisma.js';
import { env } from '../config/env.js';

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
  const parts = period.split(/~|–|—|-(?=\s)/).map(s => s.trim());
  const endStr = parts[parts.length - 1];
  if (!endStr) return null;

  // ISO: 2027-02-28
  const iso = endStr.match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  if (iso) return new Date(`${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`);

  // 짧은 연도: 30.02.28 → 2030-02-28
  const short = endStr.match(/(\d{2})\.(\d{1,2})\.(\d{1,2})/);
  if (short) {
    const yr = Number(short[1]);
    const fullYear = yr < 50 ? 2000 + yr : 1900 + yr;
    return new Date(`${fullYear}-${short[2].padStart(2, '0')}-${short[3].padStart(2, '0')}`);
  }
  return null;
}

function daysUntil(d: Date): number {
  return Math.ceil((d.getTime() - Date.now()) / 86400000);
}

export async function grantRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  const labIdOrThrow = (request: FastifyRequest): string | null => {
    return env.LAB_ID || (request as any).labId || null;
  };

  // ── GET 목록 + KPI ──────────────────────────
  app.get('/api/grants', async (request, reply) => {
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

      // KPI
      const counts = {
        active: enriched.filter(g => g.status === 'active').length,
        endingSoon: enriched.filter(g => g.daysToEnd !== null && g.daysToEnd >= 0 && g.daysToEnd <= 90).length,
        submitted: enriched.filter(g => g.status === 'submitted' || g.status === 'preparing').length,
        completed: enriched.filter(g => g.status === 'completed' || (g.daysToEnd !== null && g.daysToEnd < 0)).length,
        total: enriched.length,
        milestonesDueSoon: enriched.reduce((sum, g) => sum + g.milestoneStats.dueSoon, 0),
      };

      return reply.send({ items: enriched, counts });
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
  app.patch('/api/grants/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = updateSchema.parse(request.body || {});

      const existing = await prisma.project.findUnique({ where: { id } });
      if (!existing) return reply.code(404).send({ error: '과제 없음' });

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
  app.post('/api/grants/:id/milestones', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = addMilestoneSchema.parse(request.body || {});
      const existing = await prisma.project.findUnique({ where: { id } });
      if (!existing) return reply.code(404).send({ error: '과제 없음' });

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
  app.patch('/api/grants/:id/milestones/:mid', async (request, reply) => {
    try {
      const { id, mid } = request.params as { id: string; mid: string };
      const body = patchMsSchema.parse(request.body || {});
      const existing = await prisma.project.findUnique({ where: { id } });
      if (!existing) return reply.code(404).send({ error: '과제 없음' });

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

  // ── DELETE 마일스톤 ──────────────────────────
  app.delete('/api/grants/:id/milestones/:mid', async (request, reply) => {
    try {
      const { id, mid } = request.params as { id: string; mid: string };
      const existing = await prisma.project.findUnique({ where: { id } });
      if (!existing) return reply.code(404).send({ error: '과제 없음' });
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
