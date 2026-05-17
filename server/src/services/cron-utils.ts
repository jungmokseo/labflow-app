/**
 * KST 기준 cron 실행 헬퍼.
 *
 * Railway 컨테이너는 UTC. setTimeout으로 다음 매칭 시간까지 wait → 이후 setInterval 24h 또는 7d.
 *
 * 정확도 한계: setInterval은 누적 drift 가능. 24h drift는 수십 ms 수준이므로 KST 09:00 ±초 단위
 * 차이는 무시 가능. drift 보정 필요 시 cron 라이브러리(node-cron) 도입 검토.
 *
 * 진단용 in-memory status (CRON_STATUS) — 서버 restart 시 reset.
 * GET /api/internal/cron-status 로 조회. DB 영구 기록은 후속 작업.
 */

interface CronStatus {
  label: string;
  schedule: string;
  scheduledAt: string;        // ISO — schedule 시점
  nextRunAt: string | null;   // ISO — 다음 실행 예정 (서버 startup 시 setTimeout 등록 시점에서 계산)
  lastStartedAt?: string;     // ISO
  lastCompletedAt?: string;   // ISO
  lastSuccess?: boolean;
  lastError?: string;
  runCount: number;
  errorCount: number;
}

export const CRON_STATUS = new Map<string, CronStatus>();

export function scheduleDailyKst(
  hourKst: number,
  minuteKst: number,
  fn: () => Promise<void>,
  label: string,
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

  setTimeout(() => {
    runOnce(fn, label, period);
    setInterval(() => runOnce(fn, label, period), period);
  }, initialMs);
  console.log(
    `[${label}] 예약됨 — 매일 KST ${pad(hourKst)}:${pad(minuteKst)} ` +
    `(다음: ${minutesFromNow(initialMs)})`,
  );
}

export function scheduleWeeklyKst(
  weekday: number /* 0=일 ~ 6=토 (KST 기준) */,
  hourKst: number,
  minuteKst: number,
  fn: () => Promise<void>,
  label: string,
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

  setTimeout(() => {
    runOnce(fn, label, period);
    setInterval(() => runOnce(fn, label, period), period);
  }, initialMs);
  console.log(
    `[${label}] 예약됨 — 매주 ${dayLabels[weekday]} KST ${pad(hourKst)}:${pad(minuteKst)} ` +
    `(다음: ${minutesFromNow(initialMs)})`,
  );
}

async function runOnce(fn: () => Promise<void>, label: string, periodMs?: number): Promise<void> {
  const status = CRON_STATUS.get(label);
  const startedAt = new Date().toISOString();
  if (status) {
    status.lastStartedAt = startedAt;
    status.runCount += 1;
  }
  try {
    await fn();
    if (status) {
      status.lastCompletedAt = new Date().toISOString();
      status.lastSuccess = true;
      status.lastError = undefined;
      if (periodMs) status.nextRunAt = new Date(Date.now() + periodMs).toISOString();
    }
  } catch (e: any) {
    const msg = e?.message || String(e);
    console.error(`[${label}] 실패:`, msg);
    if (status) {
      status.lastCompletedAt = new Date().toISOString();
      status.lastSuccess = false;
      status.lastError = msg.slice(0, 500);
      status.errorCount += 1;
      if (periodMs) status.nextRunAt = new Date(Date.now() + periodMs).toISOString();
    }
  }
}

/**
 * 외부에서 cron을 즉시 실행 (manual trigger). status도 함께 update.
 * Internal-trigger endpoint에서 사용.
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
 * 현재 UTC 시각 기준 다음 KST hourKst:minuteKst 까지 남은 ms.
 * KST = UTC + 9. 예) KST 09:00 → UTC 00:00 (당일). KST 07:00 → UTC 22:00 (전날).
 * setUTCHours가 day overflow를 자동 처리하므로 단순 계산 가능.
 */
function msUntilNextKstTime(hourKst: number, minuteKst: number): number {
  const now = new Date();
  const target = new Date(now);
  // KST hour → UTC hour (음수 wrap은 setUTCHours가 알아서 전날로 처리)
  // 간단하게: setUTCHours(hourKst - 9) — 음수면 자동 전날
  target.setUTCHours(hourKst - 9, minuteKst, 0, 0);
  // setUTCHours로 음수 hour를 넣으면 자동으로 전날 normalize됨
  if (target.getTime() <= now.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target.getTime() - now.getTime();
}

/**
 * 현재 시각 기준 다음 KST 요일·시간까지 남은 ms.
 */
function msUntilNextKstWeekday(weekdayKst: number, hourKst: number, minuteKst: number): number {
  const now = new Date();
  // KST 현재 요일 계산: now + 9h → 그 시각의 UTC day가 KST day
  const nowKstMs = now.getTime() + 9 * 60 * 60 * 1000;
  const nowKst = new Date(nowKstMs);
  const nowKstDay = nowKst.getUTCDay();

  // 일단 오늘 KST의 hourKst:minuteKst 시각을 UTC로 표현
  const target = new Date(now);
  target.setUTCHours(hourKst - 9, minuteKst, 0, 0);

  // 며칠 후로 옮길지: weekdayKst - nowKstDay (mod 7)
  let daysUntil = (weekdayKst - nowKstDay + 7) % 7;
  if (daysUntil === 0 && target.getTime() <= now.getTime()) daysUntil = 7;
  target.setUTCDate(target.getUTCDate() + daysUntil);
  return target.getTime() - now.getTime();
}
