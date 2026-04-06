/**
 * Google Calendar 연동 서비스
 *
 * 읽기: 오늘/이번주 일정 조회 → 모닝 브리핑
 * 쓰기: 유저 승인 후 이벤트 등록 (이메일, 미팅, 캡처, 과제에서 감지)
 */

import { google } from 'googleapis';
import { basePrismaClient } from '../config/prisma.js';
import { env } from '../config/env.js';
import { encryptToken, decryptToken, isEncrypted } from '../utils/crypto.js';

function safeDecrypt(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try { return isEncrypted(value) ? decryptToken(value) : value; } catch { return value; }
}

function createOAuth2Client() {
  return new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI,
  );
}

async function getCalendarClient(userId: string) {
  const token = await basePrismaClient.gmailToken.findFirst({
    where: { userId },
    orderBy: { primary: 'desc' },
  });
  if (!token) return null;

  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({
    access_token: safeDecrypt(token.accessToken),
    refresh_token: safeDecrypt(token.refreshToken),
    expiry_date: token.expiresAt?.getTime(),
  });

  oauth2Client.on('tokens', async (tokens) => {
    try {
      await basePrismaClient.gmailToken.update({
        where: { id: token.id },
        data: {
          accessToken: encryptToken(tokens.access_token!),
          expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
          ...(tokens.refresh_token ? { refreshToken: encryptToken(tokens.refresh_token) } : {}),
        },
      });
    } catch { /* ignore */ }
  });

  return google.calendar({ version: 'v3', auth: oauth2Client });
}

// ── 읽기: 오늘/기간 일정 조회 ────────────────────────
export interface CalendarEvent {
  id: string;
  title: string;
  start: string;       // ISO datetime or date
  end: string;
  location?: string;
  description?: string;
  allDay: boolean;
  htmlLink?: string;
}

export async function getTodayEvents(userId: string): Promise<CalendarEvent[]> {
  const calendar = await getCalendarClient(userId);
  if (!calendar) return [];

  try {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 20,
    });

    return (res.data.items || []).map(e => ({
      id: e.id!,
      title: e.summary || '(제목 없음)',
      start: e.start?.dateTime || e.start?.date || '',
      end: e.end?.dateTime || e.end?.date || '',
      location: e.location || undefined,
      description: e.description || undefined,
      allDay: !e.start?.dateTime,
      htmlLink: e.htmlLink || undefined,
    }));
  } catch (err: any) {
    const msg = err?.message || '';
    if (msg.includes('invalid_grant') || msg.includes('Token has been expired')) {
      throw new Error('Google Calendar 토큰이 만료되었습니다. 설정에서 Gmail 재연동이 필요합니다.');
    }
    console.warn('Calendar fetch failed:', msg);
    return [];
  }
}

export async function getWeekEvents(userId: string): Promise<CalendarEvent[]> {
  const calendar = await getCalendarClient(userId);
  if (!calendar) return [];

  try {
    const now = new Date();
    const endOfWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: endOfWeek.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50,
    });

    return (res.data.items || []).map(e => ({
      id: e.id!,
      title: e.summary || '(제목 없음)',
      start: e.start?.dateTime || e.start?.date || '',
      end: e.end?.dateTime || e.end?.date || '',
      location: e.location || undefined,
      description: e.description || undefined,
      allDay: !e.start?.dateTime,
      htmlLink: e.htmlLink || undefined,
    }));
  } catch (err: any) {
    const msg = err?.message || '';
    if (msg.includes('invalid_grant') || msg.includes('Token has been expired')) {
      throw new Error('Google Calendar 토큰이 만료되었습니다. 설정에서 Gmail 재연동이 필요합니다.');
    }
    console.warn('Calendar week fetch failed:', msg);
    return [];
  }
}

// ── 쓰기: 승인된 이벤트를 캘린더에 등록 ──────────────
export async function createCalendarEvent(
  userId: string,
  event: {
    title: string;
    date: string;       // YYYY-MM-DD
    time?: string;       // HH:mm (없으면 종일)
    endTime?: string;    // HH:mm
    duration?: number;   // minutes (기본 60)
    location?: string;
    description?: string;
    timezone?: string;
  },
): Promise<{ eventId: string; htmlLink: string } | null> {
  const calendar = await getCalendarClient(userId);
  if (!calendar) return null;

  const tz = event.timezone || 'Asia/Seoul';

  let start: any, end: any;
  if (event.time) {
    const startDt = `${event.date}T${event.time}:00`;
    const endDate = new Date(startDt);
    if (event.endTime) {
      end = { dateTime: `${event.date}T${event.endTime}:00`, timeZone: tz };
    } else {
      endDate.setMinutes(endDate.getMinutes() + (event.duration || 60));
      end = { dateTime: endDate.toISOString(), timeZone: tz };
    }
    start = { dateTime: startDt, timeZone: tz };
  } else {
    start = { date: event.date };
    end = { date: event.date };
  }

  try {
    const res = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: event.title,
        location: event.location || undefined,
        description: event.description || undefined,
        start,
        end,
      },
    });
    return {
      eventId: res.data.id!,
      htmlLink: res.data.htmlLink!,
    };
  } catch (err) {
    console.error('Calendar event creation failed:', err);
    return null;
  }
}

// ── 일정 감지 (텍스트에서 날짜/시간 추출) ────────────
export interface DetectedEvent {
  title: string;
  date: string;        // YYYY-MM-DD
  time?: string;       // HH:mm
  endTime?: string;
  location?: string;
  description?: string;
  source: 'email' | 'meeting' | 'capture' | 'project';
  sourceId: string;
  confidence: number;  // 0~1
}

export async function detectEventsFromText(
  text: string,
  source: DetectedEvent['source'],
  sourceId: string,
): Promise<DetectedEvent[]> {
  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const today = new Date().toISOString().split('T')[0];
    const result = await model.generateContent(
      `다음 텍스트에서 캘린더에 등록할 만한 일정/마감일/이벤트를 추출하세요.
오늘 날짜: ${today}

텍스트:
${text.slice(0, 2000)}

JSON 배열로만 응답. 일정이 없으면 빈 배열 [].
[
  {
    "title": "일정 제목",
    "date": "YYYY-MM-DD",
    "time": "HH:mm 또는 null (종일이면 null)",
    "endTime": "HH:mm 또는 null",
    "location": "장소 또는 null",
    "description": "간단한 설명",
    "confidence": 0.0~1.0
  }
]`
    );

    const match = result.response.text().trim().match(/\[[\s\S]*\]/);
    if (!match) return [];

    const parsed = JSON.parse(match[0]);
    return parsed
      .filter((e: any) => e.date && e.title)
      .map((e: any) => ({
        title: e.title,
        date: e.date,
        time: e.time || undefined,
        endTime: e.endTime || undefined,
        location: e.location || undefined,
        description: e.description || undefined,
        source,
        sourceId,
        confidence: Math.min(1, Math.max(0, e.confidence || 0.5)),
      }));
  } catch {
    return [];
  }
}
