/**
 * KST 기준 cron 실행 헬퍼.
 *
 * Railway 컨테이너는 UTC. setTimeout으로 다음 매칭 시간까지 wait → 이후 setInterval 24h 또는 7d.
 *
 * 정확도 한계: setInterval은 누적 drift 가능. 24h drift는 수십 ms 수준이므로 KST 09:00 ±초 단위
 * 차이는 무시 가능. drift 보정 필요 시 cron 라이브러리(node-cron) 도입 검토.
 */

export function scheduleDailyKst(
  hourKst: number,
  minuteKst: number,
  fn: () => Promise<void>,
  label: string,
): void {
  const period = 24 * 60 * 60 * 1000;
  const initialMs = msUntilNextKstTime(hourKst, minuteKst);
  setTimeout(() => {
    runOnce(fn, label);
    setInterval(() => runOnce(fn, label), period);
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
  setTimeout(() => {
    runOnce(fn, label);
    setInterval(() => runOnce(fn, label), period);
  }, initialMs);
  const dayLabels = ['일', '월', '화', '수', '목', '금', '토'];
  console.log(
    `[${label}] 예약됨 — 매주 ${dayLabels[weekday]} KST ${pad(hourKst)}:${pad(minuteKst)} ` +
    `(다음: ${minutesFromNow(initialMs)})`,
  );
}

async function runOnce(fn: () => Promise<void>, label: string): Promise<void> {
  try {
    await fn();
  } catch (e: any) {
    console.error(`[${label}] 실패:`, e?.message || e);
  }
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
