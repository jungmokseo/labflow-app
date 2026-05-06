/**
 * 휴가 → BLISS Lab Google Calendar 자동 등록.
 *
 * 흐름:
 * 1. 매시간 cron: labflow-member에서 최근 휴가 목록 fetch
 * 2. 신규 휴가(아직 캘린더에 등록 안 됨)에 대해 Google Calendar API로 종일 이벤트 생성
 * 3. vacation_calendar_sync 테이블에 매핑 저장 (vacation_id → event_id) → 중복 방지
 * 4. CANCELLED 상태이고 이미 등록된 이벤트는 캘린더에서 삭제
 *
 * 캘린더: env.BLISS_LAB_CALENDAR_ID (없으면 'primary')
 *   - 사용자가 'BLISS Lab' 캘린더를 별도로 만들었으면 캘린더 ID 입력 (Google Calendar 설정 → 캘린더 ID 복사)
 *   - 미설정 시 사용자 primary calendar에 등록
 */

import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';
import { getCalendarClient } from './calendar.js';

const prisma = new PrismaClient();

interface VacationItem {
  id: string;
  memberName: string;
  type: 'ANNUAL' | 'SICK' | 'SPECIAL' | 'OFFICIAL';
  startDate: string;  // ISO date or datetime
  endDate: string;
  days: number;
  reason: string | null;
  status: 'APPROVED' | 'CANCELLED';
  createdAt: string;
}

const TYPE_LABEL: Record<VacationItem['type'], string> = {
  ANNUAL: '연차',
  SICK: '병가',
  SPECIAL: '특별 휴가',
  OFFICIAL: '공무 휴가',
};

/** vacation_calendar_sync 테이블 보장 (raw SQL — Prisma schema 외) */
export async function ensureVacationCalendarTable(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS vacation_calendar_sync (
      vacation_id TEXT PRIMARY KEY,
      calendar_event_id TEXT NOT NULL,
      calendar_id TEXT NOT NULL,
      member_name TEXT,
      start_date DATE,
      end_date DATE,
      status TEXT,
      synced_at TIMESTAMP DEFAULT NOW(),
      cancelled_at TIMESTAMP
    )
  `);
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS vacation_calendar_sync_synced_idx ON vacation_calendar_sync(synced_at DESC)`,
  );
}

/** 사용자 캘린더 list에서 'BLISS Lab' 매칭 — env BLISS_LAB_CALENDAR_ID 미설정 시 fallback. */
let cachedBlissCalendarId: string | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;  // 24h

async function findBlissLabCalendar(calendar: any): Promise<string | null> {
  try {
    const res = await calendar.calendarList.list({ maxResults: 250, showHidden: true });
    const items = res.data.items || [];
    // 'BLISS' / 'BLISS Lab' / 'bliss-lab' / '비스 랩' 등 케이스
    const match = items.find((c: any) => {
      const name = (c.summaryOverride || c.summary || '').toLowerCase();
      return /\bbliss\b/.test(name) && (name.includes('lab') || name.includes('연구실') || items.length === 1);
    }) || items.find((c: any) => /\bbliss\b/i.test((c.summaryOverride || c.summary || '')));
    return match?.id || null;
  } catch (err: any) {
    // calendar.readonly scope 없으면 403/insufficient_scope. 재인증 필요.
    if (/insufficient|scope|403|unauthorized/i.test(err.message || '')) {
      console.warn('[vacation-calendar] calendarList scope 없음 — Gmail 재연동 필요 (calendar.readonly 추가됨)');
    } else {
      console.warn(`[vacation-calendar] calendarList 조회 실패: ${err.message?.slice(0, 80)}`);
    }
    return null;
  }
}

/** 캘린더 ID 결정: env > 자동 매칭 (24h cache) > 'primary' fallback */
async function resolveCalendarId(calendar: any): Promise<{ id: string; source: 'env' | 'auto' | 'primary' }> {
  if (env.BLISS_LAB_CALENDAR_ID) return { id: env.BLISS_LAB_CALENDAR_ID, source: 'env' };
  if (cachedBlissCalendarId && Date.now() - cachedAt < CACHE_TTL_MS) {
    return { id: cachedBlissCalendarId, source: 'auto' };
  }
  const matched = await findBlissLabCalendar(calendar);
  if (matched) {
    cachedBlissCalendarId = matched;
    cachedAt = Date.now();
    console.log(`[vacation-calendar] BLISS Lab 캘린더 자동 매칭: ${matched}`);
    return { id: matched, source: 'auto' };
  }
  return { id: 'primary', source: 'primary' };
}

/** labflow-member에서 휴가 목록 fetch */
async function fetchVacationsFromMember(limit = 100): Promise<VacationItem[]> {
  const base = env.LABFLOW_MEMBER_URL.replace(/\/$/, '');
  if (!env.LABFLOW_SYNC_TOKEN) {
    console.warn('[vacation-calendar] LABFLOW_SYNC_TOKEN 미설정');
    return [];
  }
  const url = `${base}/api/lab-data/vacations/recent?limit=${limit}`;
  const r = await fetch(url, {
    headers: { 'X-Sync-Token': env.LABFLOW_SYNC_TOKEN },
  });
  if (!r.ok) {
    throw new Error(`labflow-member /vacations/recent: ${r.status}`);
  }
  const data = (await r.json()) as { items: VacationItem[] };
  return data.items || [];
}

interface SyncRecord {
  vacation_id: string;
  calendar_event_id: string;
  calendar_id: string;
  status: string;
}

async function getSyncedRecords(vacationIds: string[]): Promise<Map<string, SyncRecord>> {
  if (vacationIds.length === 0) return new Map();
  const rows = await prisma.$queryRawUnsafe<SyncRecord[]>(
    `SELECT vacation_id, calendar_event_id, calendar_id, status
     FROM vacation_calendar_sync WHERE vacation_id = ANY($1::text[])`,
    vacationIds,
  );
  return new Map(rows.map(r => [r.vacation_id, r]));
}

function toIsoDate(s: string): string {
  // 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:mm:ssZ' → 'YYYY-MM-DD'
  return s.slice(0, 10);
}

function addOneDay(isoDate: string): string {
  // Google Calendar all-day event의 end는 exclusive — 마지막 날 + 1
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** 휴가 한 건을 캘린더에 등록 */
async function createCalendarEvent(
  calendar: any,
  calendarId: string,
  v: VacationItem,
): Promise<string | null> {
  const typeLabel = TYPE_LABEL[v.type] || '휴가';
  const summary = v.type === 'ANNUAL'
    ? `${v.memberName} 휴가`
    : `${v.memberName} ${typeLabel}`;
  const start = toIsoDate(v.startDate);
  const endExclusive = addOneDay(toIsoDate(v.endDate));
  const description = [
    `BLISS Lab 휴가 자동 등록 (ResearchFlow)`,
    `학생: ${v.memberName}`,
    `유형: ${typeLabel}`,
    `기간: ${start} ~ ${toIsoDate(v.endDate)} (${v.days}일)`,
    v.reason ? `사유: ${v.reason}` : null,
  ].filter(Boolean).join('\n');

  try {
    const res = await calendar.events.insert({
      calendarId,
      requestBody: {
        summary,
        description,
        start: { date: start },
        end: { date: endExclusive },
        // 종일 이벤트 (date만)
        transparency: 'transparent',  // free/busy: free (학생 휴가는 PI 일정 충돌 X)
        extendedProperties: { private: { vacationId: v.id, source: 'labflow-vacation-sync' } },
      },
    });
    return res.data.id || null;
  } catch (err: any) {
    console.error(`[vacation-calendar] insert FAILED ${v.id}: ${err.message?.slice(0, 100)}`);
    return null;
  }
}

/** 캘린더에서 이벤트 삭제 (취소된 휴가) */
async function deleteCalendarEvent(
  calendar: any,
  calendarId: string,
  eventId: string,
): Promise<boolean> {
  try {
    await calendar.events.delete({ calendarId, eventId });
    return true;
  } catch (err: any) {
    // 404 (이미 삭제됨)는 OK
    if (err?.response?.status === 404 || err?.code === 404) return true;
    console.warn(`[vacation-calendar] delete failed ${eventId}: ${err.message?.slice(0, 80)}`);
    return false;
  }
}

/**
 * 메인 sync — 매시간 호출.
 * userId는 PI(서정목)의 user id. 없으면 자동 lookup.
 */
export async function syncVacationsToCalendar(opts: { userId?: string } = {}): Promise<{
  total: number;
  created: number;
  cancelled: number;
  errors: number;
  calendarId: string;
  calendarSource: 'env' | 'auto' | 'primary';
  calendarName?: string;
}> {
  const t0 = Date.now();
  console.log('[vacation-calendar] 시작');

  await ensureVacationCalendarTable();

  // 1. PI 사용자 ID
  const userId = opts.userId
    || (await prisma.user.findFirst({ where: { email: 'jungmok.seo@gmail.com' } }))?.id;
  if (!userId) {
    console.warn('[vacation-calendar] PI userId 없음');
    return { total: 0, created: 0, cancelled: 0, errors: 1, calendarId: 'primary', calendarSource: 'primary' };
  }

  // 2. Google Calendar client
  const calendar = await getCalendarClient(userId);
  if (!calendar) {
    console.warn('[vacation-calendar] Calendar client 없음 (Gmail 토큰 미연동)');
    return { total: 0, created: 0, cancelled: 0, errors: 1, calendarId: 'primary', calendarSource: 'primary' };
  }

  const { id: calendarId, source: calSource } = await resolveCalendarId(calendar);
  let calendarName: string | undefined;
  if (calSource === 'auto' || (calSource === 'env' && env.BLISS_LAB_CALENDAR_ID)) {
    try {
      const meta = await calendar.calendarList.get({ calendarId });
      calendarName = meta.data.summaryOverride || meta.data.summary || undefined;
    } catch { /* scope 없으면 silent */ }
  }
  if (calSource === 'primary' && !env.BLISS_LAB_CALENDAR_ID) {
    console.warn('[vacation-calendar] ⚠️ BLISS Lab 캘린더 매칭 실패 → primary 사용. ' +
      'Gmail 재연동(calendar.readonly scope) 또는 BLISS_LAB_CALENDAR_ID 설정 권장.');
  }

  // 3. labflow-member에서 휴가 목록
  let vacations: VacationItem[];
  try {
    vacations = await fetchVacationsFromMember(100);
  } catch (e: any) {
    console.error(`[vacation-calendar] fetch 실패: ${e.message?.slice(0, 100)}`);
    return { total: 0, created: 0, cancelled: 0, errors: 1, calendarId, calendarSource: calSource, calendarName };
  }
  console.log(`[vacation-calendar] 휴가 ${vacations.length}건 검토`);

  // 4. 이미 sync된 항목 조회
  const synced = await getSyncedRecords(vacations.map(v => v.id));

  let created = 0, cancelled = 0, errors = 0;

  // 5. 신규 + 취소 처리
  for (const v of vacations) {
    const record = synced.get(v.id);

    if (!record) {
      // 신규 — CANCELLED는 등록 안 함
      if (v.status === 'CANCELLED') continue;
      const eventId = await createCalendarEvent(calendar, calendarId, v);
      if (!eventId) { errors++; continue; }
      try {
        await prisma.$executeRawUnsafe(
          `INSERT INTO vacation_calendar_sync (vacation_id, calendar_event_id, calendar_id, member_name, start_date, end_date, status)
           VALUES ($1, $2, $3, $4, $5::date, $6::date, $7)
           ON CONFLICT (vacation_id) DO NOTHING`,
          v.id, eventId, calendarId, v.memberName, toIsoDate(v.startDate), toIsoDate(v.endDate), v.status,
        );
        created++;
      } catch (e: any) {
        console.error(`[vacation-calendar] insert sync row 실패 ${v.id}: ${e.message?.slice(0, 80)}`);
        errors++;
      }
    } else if (v.status === 'CANCELLED' && record.status !== 'CANCELLED') {
      // 기존에 등록되어 있었지만 지금 취소됨 → 캘린더에서 이벤트 삭제 + 마킹
      const ok = await deleteCalendarEvent(calendar, record.calendar_id, record.calendar_event_id);
      if (ok) {
        try {
          await prisma.$executeRawUnsafe(
            `UPDATE vacation_calendar_sync SET status = 'CANCELLED', cancelled_at = NOW() WHERE vacation_id = $1`,
            v.id,
          );
          cancelled++;
        } catch { errors++; }
      } else {
        errors++;
      }
    }
    // else: 이미 등록되어 있고 상태 변경 없음 — skip
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`[vacation-calendar] 완료: 캘린더 '${calendarName || calendarId}' (${calSource}) · 신규 ${created} / 취소 ${cancelled} / errors ${errors} / ${elapsed}s`);
  return { total: vacations.length, created, cancelled, errors, calendarId, calendarSource: calSource, calendarName };
}
