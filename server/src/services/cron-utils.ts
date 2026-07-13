/**
 * KST 기준 cron 실행 헬퍼.
 *
 * Railway 컨테이너는 UTC. setTimeout으로 다음 매칭 시간까지 wait → 이후 setInterval 24h 또는 7d.
 *
 * 핵심 정책 (2026-05-17 강화):
 *   1) **영구 기록**: 매 실행을 prisma.cronRun에 저장 → server restart 후에도 history 유지.
 *   2) **Startup backfill**: server 시작 시 마지막 성공이 24h+ 경과면 즉시 실행. 매일 deploy해도 cron missed 안 됨.
 *   3) **In-memory mirror (CRON_STATUS)**: 빠른 dashboard fetch용.
 *   4) **KST 시간 계산 fix**: setUTCHours 음수 wrap 버그 해결 — KST를 가상 UTC로 다룸.
 *
 * 정확도 한계: setInterval은 누적 drift 가능 (수십 ms). KST 09:00 ±초 단위 차이는 무시 가능.
 * drift 보정 필요 시 node-cron 도입 검토.
 */

import { basePrismaClient as prisma } from '../config/prisma.js';

interface CronStatus {
  label: string;
  schedule: string;
  scheduledAt: string;        // ISO — schedule 시점
  nextRunAt: string | null;   // ISO — 다음 실행 예정
  lastStartedAt?: string;     // ISO
  lastCompletedAt?: string;   // ISO
  lastSuccess?: boolean;
  lastError?: string;
  runCount: number;
  errorCount: number;
}

export const CRON_STATUS = new Map<string, CronStatus>();

/**
 * 매일 KST hourKst:minuteKst 실행하는 cron 등록.
 * options.backfill: 마지막 성공이 24h+ 경과면 startup 후 즉시 한 번 실행 (기본 true).
 */
export function scheduleDailyKst(
  hourKst: number,
  minuteKst: number,
  fn: () => Promise<void>,
  label: string,
  options: { backfill?: boolean } = {},
): void {
  const period = 24 * 60 * 60 * 1000;
  const initialMs = msUntilNextKstTime(hourKst, minuteKst);
  const scheduledAt = new Date().toISOString();
  const nextRunAt = new Date(Date.now() + initialMs).toISOString();

  CRON_STATUS.set(label, {
    label,
    schedule: `매일 KST ${pad(hourKst)}:${pad(minuteKst)}`,
    scheduledAt,
    nextRunAt,
    runCount: 0,
    errorCount: 0,
  });

  // 마지막 성공을 hydrate (in-memory status에 DB 값 반영)
  hydrateLastRun(label).catch(() => {});

  setTimeout(() => {
    runOnce(fn, label, period);
    setInterval(() => runOnce(fn, label, period), period);
  }, initialMs);
  console.log(
    `[${label}] 예약됨 — 매일 KST ${pad(hourKst)}:${pad(minuteKst)} ` +
    `(다음: ${minutesFromNow(initialMs)})`,
  );

  // Startup backfill — 마지막 성공이 25h+ 경과면 즉시 실행
  if (options.backfill !== false) {
    setTimeout(() => backfillIfMissed(fn, label, period), 5000); // server start 5초 후 (다른 init 완료 대기)
  }
}

/**
 * 매주 KST weekday(0=일~6=토) hourKst:minuteKst 실행.
 */
export function scheduleWeeklyKst(
  weekday: number,
  hourKst: number,
  minuteKst: number,
  fn: () => Promise<void>,
  label: string,
  options: { backfill?: boolean } = {},
): void {
  const period = 7 * 24 * 60 * 60 * 1000;
  const initialMs = msUntilNextKstWeekday(weekday, hourKst, minuteKst);
  const scheduledAt = new Date().toISOString();
  const nextRunAt = new Date(Date.now() + initialMs).toISOString();
  const dayLabels = ['일', '월', '화', '수', '목', '금', '토'];

  CRON_STATUS.set(label, {
    label,
    schedule: `매주 ${dayLabels[weekday]} KST ${pad(hourKst)}:${pad(minuteKst)}`,
    scheduledAt,
    nextRunAt,
    runCount: 0,
    errorCount: 0,
  });

  hydrateLastRun(label).catch(() => {});

  setTimeout(() => {
    runOnce(fn, label, period);
    setInterval(() => runOnce(fn, label, period), period);
  }, initialMs);
  console.log(
    `[${label}] 예약됨 — 매주 ${dayLabels[weekday]} KST ${pad(hourKst)}:${pad(minuteKst)} ` +
    `(다음: ${minutesFromNow(initialMs)})`,
  );

  if (options.backfill !== false) {
    setTimeout(() => backfillIfMissed(fn, label, period), 5000);
  }
}

/**
 * In-memory status에 DB의 마지막 실행 정보 반영.
 * Server restart 후 대시보드가 "실행 0회"로 표시되는 문제 해결.
 */
async function hydrateLastRun(label: string): Promise<void> {
  const status = CRON_STATUS.get(label);
  if (!status) return;
  try {
    const last = await prisma.cronRun.findFirst({
      where: { label, NOT: { success: null } },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true, completedAt: true, success: true, errorMessage: true },
    });
    if (last) {
      status.lastStartedAt = last.startedAt.toISOString();
      if (last.completedAt) status.lastCompletedAt = last.completedAt.toISOString();
      if (last.success !== null) status.lastSuccess = last.success;
      if (last.errorMessage) status.lastError = last.errorMessage;
    }
    // runCount + errorCount 집계
    const [runCount, errorCount] = await Promise.all([
      prisma.cronRun.count({ where: { label } }),
      prisma.cronRun.count({ where: { label, success: false } }),
    ]);
    status.runCount = runCount;
    status.errorCount = errorCount;
  } catch (e: any) {
    // hydrate 실패해도 cron은 정상 동작 (in-memory만 0으로)
    console.warn(`[${label}] hydrateLastRun 실패:`, e?.message);
  }
}

/**
 * Server startup backfill — 마지막 성공이 period의 1.05배(여유) 이상 경과했으면 즉시 실행.
 * 이를 통해 매일 deploy로 인한 cron miss 방지.
 */
async function backfillIfMissed(fn: () => Promise<void>, label: string, periodMs: number): Promise<void> {
  try {
    const lastSuccess = await prisma.cronRun.findFirst({
      where: { label, success: true },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    });
    const now = Date.now();
    const threshold = periodMs * 1.05; // 5% 여유 (drift 흡수)
    const elapsed = lastSuccess ? now - lastSuccess.startedAt.getTime() : Infinity;
    if (elapsed > threshold) {
      const elapsedHours = lastSuccess ? Math.round(elapsed / 3600_000) : null;
      console.log(`[${label}] 🔄 backfill 실행 — 마지막 성공 ${elapsedHours ?? '없음'}h 전 (threshold ${Math.round(threshold/3600_000)}h)`);
      runOnce(fn, label, periodMs);
    }
  } catch (e: any) {
    console.warn(`[${label}] backfill 체크 실패:`, e?.message);
  }
}

// label별 실행 중 플래그 — backfill(startup 5s)과 정시 setTimeout이 거의 동시에 같은 cron을
// 중복 실행하거나, manual trigger가 정시 실행과 겹치는 것을 방지.
const inFlightCrons = new Set<string>();

async function runOnce(fn: () => Promise<void>, label: string, periodMs?: number): Promise<void> {
  if (inFlightCrons.has(label)) {
    console.log(`[${label}] 이미 실행 중 — 중복 실행 skip`);
    return;
  }
  inFlightCrons.add(label);
  const status = CRON_STATUS.get(label);
  const startedAt = new Date();
  const startedAtIso = startedAt.toISOString();

  // 1) DB record 생성 (success=null = 진행 중)
  let cronRunId: string | null = null;
  try {
    const row = await prisma.cronRun.create({
      data: { label, startedAt, success: null },
      select: { id: true },
    });
    cronRunId = row.id;
  } catch (e: any) {
    console.warn(`[${label}] cronRun.create 실패 (DB 미사용 모드로 계속):`, e?.message);
  }

  if (status) {
    status.lastStartedAt = startedAtIso;
    status.runCount += 1;
  }

  const t0 = Date.now();
  try {
    await fn();
    const durationMs = Date.now() - t0;
    const completedAt = new Date();
    if (status) {
      status.lastCompletedAt = completedAt.toISOString();
      status.lastSuccess = true;
      status.lastError = undefined;
      if (periodMs) status.nextRunAt = new Date(Date.now() + periodMs).toISOString();
    }
    if (cronRunId) {
      await prisma.cronRun.update({
        where: { id: cronRunId },
        data: { completedAt, success: true, durationMs },
      }).catch(() => {});
    }
  } catch (e: any) {
    const msg = e?.message || String(e);
    const durationMs = Date.now() - t0;
    const completedAt = new Date();
    console.error(`[${label}] 실패:`, msg);
    // 상태 전이 판정용 — status 갱신 전의 직전 성공 여부
    const prevSuccess = status?.lastSuccess;
    if (status) {
      status.lastCompletedAt = completedAt.toISOString();
      status.lastSuccess = false;
      status.lastError = msg.slice(0, 500);
      status.errorCount += 1;
      if (periodMs) status.nextRunAt = new Date(Date.now() + periodMs).toISOString();
    }
    if (cronRunId) {
      await prisma.cronRun.update({
        where: { id: cronRunId },
        data: { completedAt, success: false, durationMs, errorMessage: msg.slice(0, 2000) },
      }).catch(() => {});
    }
    // PI Slack 알림 — 성공→실패 전이 시 1회 (스팸 방지) + 이후 7회 연속 실패마다 리마인드.
    // (deadline-reminder가 23일 연속 죽어 있어도 아무도 몰랐던 무알림 문제의 해결책 — 2026-07-13)
    const shouldAlert = prevSuccess !== false || (status ? status.errorCount % 7 === 0 : false);
    if (shouldAlert) {
      notifyCronFailure(label, msg).catch(() => {});
    }
  } finally {
    inFlightCrons.delete(label);
  }
}

/** cron 실패를 PI Slack DM으로 알림 — slack-api 동적 import (순환 import 방지) */
async function notifyCronFailure(label: string, errorMsg: string): Promise<void> {
  try {
    const { postSlackAdminDm } = await import('./cron-shared/slack-api.js');
    await postSlackAdminDm(
      [
        `⚠️ *자동화 실패 알림* — \`${label}\``,
        '',
        `에러: ${errorMsg.slice(0, 300)}`,
        '',
        '_Settings → 시스템 상태 → 🕒 Cron 진단 대시보드에서 상세 확인. 같은 cron이 다시 성공하면 알림은 중단됩니다._',
      ].join('\n'),
    );
  } catch (e: any) {
    console.warn(`[${label}] 실패 알림 발송 불가:`, e?.message);
  }
}

/**
 * 외부에서 cron을 즉시 실행 (manual trigger). status + DB 기록 포함.
 */
export async function manualRunCron(label: string, fn: () => Promise<void>): Promise<void> {
  await runOnce(fn, label);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function minutesFromNow(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}분 후`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}시간 후`;
  return `${Math.round(hr / 24)}일 후`;
}

/**
 * 다음 KST hourKst:minuteKst 까지 남은 ms.
 *
 * 구현: KST를 가상 UTC로 다루기 (epoch + 9h 변환) → 계산 → 마지막에 -9h로 실제 UTC 환원.
 * 이전 버그: setUTCHours(hourKst - 9)가 UTC 자정 기준이라 KST date가 다음날로 넘어간 경우 잘못 계산.
 */
function msUntilNextKstTime(hourKst: number, minuteKst: number): number {
  const now = Date.now();
  const KST_OFFSET = 9 * 60 * 60 * 1000;
  const nowKst = new Date(now + KST_OFFSET);
  const target = new Date(nowKst);
  target.setUTCHours(hourKst, minuteKst, 0, 0);
  if (target.getTime() <= nowKst.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return (target.getTime() - KST_OFFSET) - now;
}

/**
 * 다음 KST weekday(0=일~6=토) hourKst:minuteKst 까지 남은 ms.
 */
function msUntilNextKstWeekday(weekdayKst: number, hourKst: number, minuteKst: number): number {
  const now = Date.now();
  const KST_OFFSET = 9 * 60 * 60 * 1000;
  const nowKst = new Date(now + KST_OFFSET);
  const target = new Date(nowKst);
  target.setUTCHours(hourKst, minuteKst, 0, 0);

  let daysUntil = (weekdayKst - target.getUTCDay() + 7) % 7;
  if (daysUntil === 0 && target.getTime() <= nowKst.getTime()) daysUntil = 7;
  target.setUTCDate(target.getUTCDate() + daysUntil);
  return (target.getTime() - KST_OFFSET) - now;
}
