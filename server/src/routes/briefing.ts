/**
 * Morning Briefing API — 모닝 브리핑 (Push + Pull)
 *
 * GET  /api/briefing          → 오늘의 브리핑 생성 (이메일 + 논문 + 캡처 + 미팅)
 * GET  /api/briefing/history  → 브리핑 히스토리 (주간 리포트용)
 * POST /api/briefing/feedback → 브리핑 항목 클릭/스킵 피드백
 *
 * 기존 데이터 소스를 종합하는 orchestration layer.
 * 새 DB 모델 없이 기존 모델들을 조합.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { basePrismaClient } from '../config/prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import { aiRateLimiter } from '../middleware/rate-limiter.js';
import { env } from '../config/env.js';
import { getTodayEvents } from '../services/calendar.js';

// ── Schemas ──────────────────────────────────────
const briefingQuerySchema = z.object({
  date: z.string().optional(), // ISO date (기본: 오늘)
});

const feedbackSchema = z.object({
  briefingDate: z.string(),
  itemType: z.enum(['email', 'paper', 'capture', 'meeting']),
  itemId: z.string(),
  action: z.enum(['clicked', 'skipped', 'dismissed']),
});

// ── Types ──────────────────────────────────────
interface BriefingItem {
  type: 'email' | 'paper' | 'capture' | 'meeting';
  id: string;
  priority: 'urgent' | 'important' | 'info';
  title: string;
  summary: string;
  metadata?: Record<string, unknown>;
}

interface BriefingResponse {
  date: string;
  generatedAt: string;
  urgent: BriefingItem[];
  important: BriefingItem[];
  info: BriefingItem[];
  stats: {
    totalEmails: number;
    newPapers: number;
    pendingCaptures: number;
    upcomingMeetings: number;
    calendarEvents?: number;
  };
}

// ── Helper: Gmail 이메일 요약 수집 ──────────────
async function getEmailSummary(userId: string): Promise<BriefingItem[]> {
  const items: BriefingItem[] = [];

  try {
    const gmailToken = await basePrismaClient.gmailToken.findFirst({
      where: { userId },
      orderBy: { primary: 'desc' },
    });
    if (!gmailToken) return items;

    const { google } = await import('googleapis');
    const oauth2Client = new google.auth.OAuth2(
      env.GOOGLE_CLIENT_ID,
      env.GOOGLE_CLIENT_SECRET,
      env.GOOGLE_REDIRECT_URI,
    );
    oauth2Client.setCredentials({
      access_token: gmailToken.accessToken,
      refresh_token: gmailToken.refreshToken || undefined,
      expiry_date: gmailToken.expiresAt?.getTime(),
    });

    // 토큰 자동 갱신 시 DB 업데이트
    oauth2Client.on('tokens', async (tokens) => {
      try {
        await basePrismaClient.gmailToken.update({
          where: { id: gmailToken.id },
          data: {
            accessToken: tokens.access_token!,
            expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
            ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
          },
        });
      } catch {
        // 토큰 갱신 실패는 무시
      }
    });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // 오늘 기준 unread 이메일 (최대 20개)
    const today = new Date();
    const afterStr = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}`;

    const listRes = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 20,
      q: `is:unread after:${afterStr} -category:promotions -category:social`,
    });

    const messages = listRes.data.messages || [];

    for (const msg of messages.slice(0, 10)) {
      try {
        const detail = await gmail.users.messages.get({
          userId: 'me',
          id: msg.id!,
          format: 'metadata',
          metadataHeaders: ['From', 'Subject', 'Date'],
        });

        const headers = detail.data.payload?.headers || [];
        const from = headers.find(h => h.name === 'From')?.value || '알 수 없음';
        const subject = headers.find(h => h.name === 'Subject')?.value || '(제목 없음)';

        // 간단한 우선순위 판단: 내부 이메일(.ac.kr, .edu 등 교육기관) = important
        const isInternal = from.includes('.ac.kr') || from.includes('.edu') || from.includes('.ac.');
        const hasUrgentKeyword = subject.includes('긴급') || subject.includes('urgent') || subject.includes('deadline') || subject.includes('마감');

        items.push({
          type: 'email',
          id: msg.id!,
          priority: hasUrgentKeyword ? 'urgent' : isInternal ? 'important' : 'info',
          title: subject,
          summary: `From: ${from.replace(/<.*>/, '').trim()}`,
          metadata: { from, threadId: msg.threadId },
        });
      } catch {
        // 개별 이메일 조회 실패는 스킵
      }
    }
  } catch (err) {
    console.warn('Briefing: Gmail fetch failed:', err);
  }

  return items;
}

// ── Helper: 논문 알림 수집 ──────────────
async function getPaperAlerts(labId: string): Promise<BriefingItem[]> {
  const items: BriefingItem[] = [];

  try {
    const results = await basePrismaClient.paperAlertResult.findMany({
      where: {
        alert: { labId },
        read: false,
        createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }, // 최근 7일
      },
      orderBy: { relevance: 'desc' },
      take: 5,
      include: { alert: { select: { keywords: true } } },
    });

    for (const r of results) {
      items.push({
        type: 'paper',
        id: r.id,
        priority: r.relevance > 0.7 ? 'important' : 'info',
        title: r.title,
        summary: r.aiSummary || r.journal || '논문 알림',
        metadata: { journal: r.journal, url: r.url, relevance: r.relevance },
      });
    }
  } catch (err) {
    console.warn('Briefing: Paper alerts fetch failed:', err);
  }

  return items;
}

// ── Helper: 미완료 캡처 (태스크) 수집 ──────────────
async function getPendingCaptures(userId: string): Promise<BriefingItem[]> {
  const items: BriefingItem[] = [];

  try {
    const captures = await prisma.capture.findMany({
      where: {
        userId,
        completed: false,
        category: 'TASK',
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });

    for (const c of captures) {
      const isOverdue = c.actionDate && c.actionDate < new Date();
      items.push({
        type: 'capture',
        id: c.id,
        priority: isOverdue ? 'urgent' : c.priority === 'HIGH' ? 'important' : 'info',
        title: c.summary || c.content.slice(0, 60),
        summary: c.tags.length > 0 ? `태그: ${c.tags.join(', ')}` : '미완료 태스크',
        metadata: { category: c.category, actionDate: c.actionDate },
      });
    }
  } catch (err) {
    console.warn('Briefing: Captures fetch failed:', err);
  }

  return items;
}

// ── Helper: 오늘 미팅 수집 ──────────────
async function getTodayMeetings(userId: string): Promise<BriefingItem[]> {
  const items: BriefingItem[] = [];

  try {
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

    const meetings = await prisma.meeting.findMany({
      where: {
        userId,
        createdAt: { gte: startOfDay, lt: endOfDay },
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });

    for (const m of meetings) {
      items.push({
        type: 'meeting',
        id: m.id,
        priority: 'important',
        title: m.title,
        summary: m.summary?.slice(0, 100) || '미팅 노트',
        metadata: { duration: m.duration },
      });
    }
  } catch (err) {
    console.warn('Briefing: Meetings fetch failed:', err);
  }

  return items;
}

// ── Helper: Google Calendar 오늘 일정 ──────────────
async function getCalendarEvents(userId: string): Promise<BriefingItem[]> {
  const items: BriefingItem[] = [];
  try {
    const events = await getTodayEvents(userId);
    for (const e of events) {
      const startTime = e.start.includes('T')
        ? new Date(e.start).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
        : '종일';
      items.push({
        type: 'meeting', // 캘린더 일정도 meeting 타입으로 분류
        id: e.id,
        priority: 'important',
        title: e.title,
        summary: `${startTime}${e.location ? ` · ${e.location}` : ''}`,
        metadata: { source: 'google-calendar', htmlLink: e.htmlLink, allDay: e.allDay },
      });
    }
  } catch { /* ignore */ }
  return items;
}

// ── Routes ──────────────────────────────────────
export async function briefingRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authMiddleware);
  app.addHook('onRequest', aiRateLimiter);

  /**
   * GET /api/briefing — 오늘의 브리핑 생성
   */
  app.get('/api/briefing', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId!;
    const labId = request.labId;

    // 모든 데이터 소스를 병렬 수집 (캘린더 포함)
    const [emails, papers, captures, meetings, calendarEvents] = await Promise.all([
      getEmailSummary(userId),
      labId ? getPaperAlerts(labId) : Promise.resolve([]),
      getPendingCaptures(userId),
      getTodayMeetings(userId),
      getCalendarEvents(userId),
    ]);

    // 전체 항목 합치기
    const allItems = [...emails, ...papers, ...captures, ...meetings, ...calendarEvents];

    // 우선순위별 분류
    const urgent = allItems.filter(i => i.priority === 'urgent');
    const important = allItems.filter(i => i.priority === 'important');
    const info = allItems.filter(i => i.priority === 'info');

    const briefing: BriefingResponse = {
      date: new Date().toISOString().split('T')[0],
      generatedAt: new Date().toISOString(),
      urgent,
      important,
      info,
      stats: {
        totalEmails: emails.length,
        newPapers: papers.length,
        pendingCaptures: captures.length,
        upcomingMeetings: meetings.length + calendarEvents.length,
        calendarEvents: calendarEvents.length,
      },
    };

    // 브리핑 생성 시각 기록 (다음 브리핑의 T_last)
    try {
      await basePrismaClient.emailProfile.upsert({
        where: { userId },
        update: { lastBriefingAt: new Date() },
        create: {
          userId,
          lastBriefingAt: new Date(),
          classifyByGroup: false,
          groups: [],
        },
      });
    } catch {
      // 프로필 업데이트 실패는 무시
    }

    // 브리핑 내역을 Memo로 저장 (히스토리 + 주간 리포트용)
    try {
      const briefingSummary = [
        urgent.length > 0 ? `🔴 긴급 ${urgent.length}건: ${urgent.map(i => i.title).join(', ')}` : null,
        important.length > 0 ? `🟡 확인 필요 ${important.length}건` : null,
        info.length > 0 ? `✅ 참고 ${info.length}건` : null,
      ].filter(Boolean).join('\n');

      await basePrismaClient.memo.create({
        data: {
          userId,
          labId: labId || undefined,
          title: `📋 브리핑 ${briefing.date}`,
          content: briefingSummary || '오늘은 확인할 사항이 없습니다.',
          tags: ['briefing', 'auto'],
          source: 'briefing',
        },
      });
    } catch {
      // 메모 저장 실패는 무시
    }

    return reply.send(briefing);
  });

  /**
   * GET /api/briefing/history — 브리핑 히스토리 (주간 리포트용)
   */
  app.get('/api/briefing/history', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId!;
    const query = z.object({
      days: z.coerce.number().min(1).max(30).default(7),
    }).parse(request.query);

    const since = new Date(Date.now() - query.days * 24 * 60 * 60 * 1000);

    const memos = await prisma.memo.findMany({
      where: {
        userId,
        source: 'briefing',
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'desc' },
    });

    return reply.send({
      period: { from: since.toISOString().split('T')[0], to: new Date().toISOString().split('T')[0] },
      briefings: memos.map(m => ({
        date: m.createdAt.toISOString().split('T')[0],
        summary: m.content,
        title: m.title,
      })),
      count: memos.length,
    });
  });

  /**
   * POST /api/briefing/feedback — 브리핑 항목 피드백 (클릭/스킵 추적)
   */
  app.post('/api/briefing/feedback', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId!;
    const body = feedbackSchema.parse(request.body);

    // UserPreference에 피드백 저장 (preference-learning 연동)
    try {
      const existing = await prisma.userPreference.findUnique({
        where: { userId_featureType: { userId, featureType: 'briefing' } },
      });

      const currentRules = (existing?.rules as Record<string, unknown>) || {};
      const feedbackLog = (currentRules.feedbackLog as Array<unknown>) || [];

      feedbackLog.push({
        date: body.briefingDate,
        type: body.itemType,
        id: body.itemId,
        action: body.action,
        ts: new Date().toISOString(),
      });

      // 최근 100개만 유지
      const trimmed = feedbackLog.slice(-100);

      await prisma.userPreference.upsert({
        where: { userId_featureType: { userId, featureType: 'briefing' } },
        update: {
          rules: { ...currentRules, feedbackLog: trimmed },
          version: { increment: 1 },
        },
        create: {
          userId,
          featureType: 'briefing',
          rules: { feedbackLog: trimmed },
        },
      });
    } catch (err) {
      console.error('Briefing feedback save failed:', err);
      return reply.code(500).send({ error: '피드백 저장 실패' });
    }

    return reply.send({ ok: true });
  });
}
