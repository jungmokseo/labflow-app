/**
 * 캘린더 연동 Routes
 *
 * GET    /api/calendar/today           → 오늘 일정 (Google Calendar)
 * GET    /api/calendar/week            → 이번주 일정
 * GET    /api/calendar/pending         → 등록 대기 중인 감지된 일정
 * POST   /api/calendar/pending/:id/approve → 일정 승인 → Google Calendar 등록
 * POST   /api/calendar/pending/:id/dismiss → 일정 무시
 * POST   /api/calendar/create          → 수동 일정 생성
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  getTodayEvents,
  getWeekEvents,
  createCalendarEvent,
  type DetectedEvent,
} from '../services/calendar.js';

// 감지된 일정을 Memo에 저장 (source: 'pending-event')
// content에 JSON으로 이벤트 정보 저장

export async function calendarRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authMiddleware);

  // ── GET /api/calendar/today ──────────────────────
  app.get('/api/calendar/today', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId!;
    const events = await getTodayEvents(userId);
    return reply.send({ success: true, events, count: events.length });
  });

  // ── GET /api/calendar/week ───────────────────────
  app.get('/api/calendar/week', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId!;
    const events = await getWeekEvents(userId);
    return reply.send({ success: true, events, count: events.length });
  });

  // ── GET /api/calendar/pending ────────────────────
  app.get('/api/calendar/pending', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId!;
    const memos = await prisma.memo.findMany({
      where: {
        userId,
        source: 'pending-event',
        tags: { has: 'pending' }, // 아직 처리 안 된 것만
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    const pending = memos.map(m => {
      let event: any = {};
      try { event = JSON.parse(m.content); } catch { /* ignore */ }
      return {
        id: m.id,
        ...event,
        createdAt: m.createdAt,
      };
    });

    return reply.send({ success: true, pending, count: pending.length });
  });

  // ── POST /api/calendar/pending/:id/approve ───────
  app.post('/api/calendar/pending/:id/approve', async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const userId = request.userId!;
    const memo = await prisma.memo.findFirst({
      where: { id: request.params.id, userId, source: 'pending-event' },
    });
    if (!memo) return reply.code(404).send({ error: '대기 중인 일정을 찾을 수 없습니다' });

    let event: any = {};
    try { event = JSON.parse(memo.content); } catch {
      return reply.code(400).send({ error: '일정 데이터를 파싱할 수 없습니다' });
    }

    // Google Calendar에 등록
    const result = await createCalendarEvent(userId, {
      title: event.title,
      date: event.date,
      time: event.time || undefined,
      endTime: event.endTime || undefined,
      location: event.location || undefined,
      description: event.description || undefined,
    });

    if (!result) {
      return reply.code(500).send({ error: 'Google Calendar 등록 실패. Google 연동을 확인해주세요.' });
    }

    // 승인 완료 표시
    await prisma.memo.update({
      where: { id: memo.id },
      data: { tags: ['approved', 'calendar'], source: 'calendar-event' },
    });

    return reply.send({
      success: true,
      eventId: result.eventId,
      htmlLink: result.htmlLink,
      message: `"${event.title}" 일정이 캘린더에 등록되었습니다`,
    });
  });

  // ── POST /api/calendar/pending/:id/dismiss ───────
  app.post('/api/calendar/pending/:id/dismiss', async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const userId = request.userId!;
    await prisma.memo.updateMany({
      where: { id: request.params.id, userId, source: 'pending-event' },
      data: { tags: ['dismissed'], source: 'dismissed-event' },
    });
    return reply.send({ success: true });
  });

  // ── POST /api/calendar/create ────────────────────
  app.post('/api/calendar/create', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId!;
    const body = z.object({
      title: z.string().min(1),
      date: z.string().min(1),
      time: z.string().optional(),
      endTime: z.string().optional(),
      duration: z.number().optional(),
      location: z.string().optional(),
      description: z.string().optional(),
    }).parse(request.body);

    const result = await createCalendarEvent(userId, body);
    if (!result) {
      return reply.code(500).send({ error: 'Google Calendar 등록 실패' });
    }

    return reply.code(201).send({
      success: true,
      eventId: result.eventId,
      htmlLink: result.htmlLink,
    });
  });
}

/**
 * 감지된 일정을 pending으로 저장 (다른 서비스에서 호출)
 */
export async function savePendingEvent(
  userId: string,
  labId: string | undefined,
  event: DetectedEvent,
) {
  await prisma.memo.create({
    data: {
      userId,
      labId: labId || undefined,
      title: `[일정] ${event.title} (${event.date})`,
      content: JSON.stringify(event),
      tags: ['pending'],
      source: 'pending-event',
    },
  });
}
