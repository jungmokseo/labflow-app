/**
 * Inbox Summary — BLISS-Bot Slack App Home에 표시할 PI inbox 통합 요약.
 *
 * 인증: X-Sync-Token (bliss-slack-bot이 호출).
 *
 * 응답 구조:
 *   {
 *     pendingFollowUps: number,           // 미답변 질문 수
 *     reviewQueueTasks: number,           // 검토 대기 task 수
 *     activeTasks: number,                // 진행 중 task 수
 *     recentVacations: number,            // 최근 7일 휴가 신청 수
 *     recentFollowUpItems: [{question, askedBy, createdAt, id}, ...최근 3건],
 *     recentReviewItems: [{title, requesterName, createdAt, id}, ...최근 3건],
 *     fetchedAt: ISO string,
 *   }
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Prisma } from '@prisma/client';
import { basePrismaClient as prisma } from '../config/prisma.js';
import { env } from '../config/env.js';

function requireSyncToken(token: string | undefined) {
  const expected = env.LABFLOW_SYNC_TOKEN;
  if (!expected) return { ok: false as const, status: 503, error: 'LABFLOW_SYNC_TOKEN not configured' };
  if (!token || token !== expected) return { ok: false as const, status: 401, error: 'invalid sync token' };
  return { ok: true as const };
}

function memberUrl(path: string): string {
  return `${env.LABFLOW_MEMBER_URL.replace(/\/$/, '')}${path}`;
}

async function fetchMember<T>(path: string): Promise<T | null> {
  if (!env.LABFLOW_SYNC_TOKEN) return null;
  try {
    const r = await fetch(memberUrl(path), {
      method: 'GET',
      headers: { 'X-Sync-Token': env.LABFLOW_SYNC_TOKEN },
    });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

interface FollowUpResp {
  items: Array<{ id: string; question: string; askedBy: string; createdAt: string }>;
  counts: { pending: number; answered: number };
}

interface VacationsResp {
  items: Array<{ id: string; memberName: string; type: string; startDate: string; endDate: string; days: number; createdAt: string }>;
}

export async function inboxSummaryRoutes(app: FastifyInstance) {
  app.get('/api/inbox-summary', async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = requireSyncToken(request.headers['x-sync-token'] as string | undefined);
    if (!auth.ok) return reply.code(auth.status).send({ error: auth.error });

    // ── 1) labflow-app 자체 데이터 (Capture) ─────────────
    const reviewWhere: Prisma.CaptureWhereInput = {
      reviewed: false,
      category: 'TASK',
      status: 'active',
      metadata: { path: ['blissSource'], not: Prisma.JsonNull },
    };
    const activeWhere: Prisma.CaptureWhereInput = {
      reviewed: true,
      category: 'TASK',
      status: 'active',
      completed: false,
    };

    const [reviewQueueCount, activeCount, recentReview] = await Promise.all([
      prisma.capture.count({ where: reviewWhere }),
      prisma.capture.count({ where: activeWhere }),
      prisma.capture.findMany({
        where: reviewWhere,
        select: { id: true, summary: true, metadata: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 3,
      }),
    ]);

    // ── 2) labflow-member proxy (병렬) ─────────────────
    const [followUp, vacations] = await Promise.all([
      fetchMember<FollowUpResp>('/api/follow-up?status=pending&limit=3'),
      fetchMember<VacationsResp>('/api/lab-data/vacations/recent?limit=20'),
    ]);

    // 최근 7일 휴가 신청 수
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentVacationsCount = (vacations?.items ?? []).filter(
      v => new Date(v.createdAt).getTime() >= sevenDaysAgo,
    ).length;

    return reply.send({
      pendingFollowUps: followUp?.counts.pending ?? 0,
      reviewQueueTasks: reviewQueueCount,
      activeTasks: activeCount,
      recentVacations: recentVacationsCount,
      recentFollowUpItems: (followUp?.items ?? []).slice(0, 3).map(i => ({
        id: i.id,
        question: i.question,
        askedBy: i.askedBy,
        createdAt: i.createdAt,
      })),
      recentReviewItems: recentReview.map(c => {
        const meta = (c.metadata as Prisma.JsonObject | null) ?? {};
        const source = (meta.blissSource as Prisma.JsonObject | null) ?? {};
        return {
          id: c.id,
          title: c.summary,
          requesterName: (source.requesterName as string) || '학생',
          createdAt: c.createdAt,
        };
      }),
      recentVacationItems: (vacations?.items ?? []).slice(0, 3).map(v => ({
        id: v.id,
        memberName: v.memberName,
        type: v.type,
        startDate: v.startDate,
        endDate: v.endDate,
        days: v.days,
        createdAt: v.createdAt,
      })),
      fetchedAt: new Date().toISOString(),
    });
  });
}
