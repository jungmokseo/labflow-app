/**
 * Pending Brain Job — sessionStorage 기반 진행중 작업 추적
 *
 * brain 채팅에서 메시지를 보낼 때 sessionStorage에 기록.
 * 모바일에서 화면이 꺼져 fetch가 끊기거나, 새로고침/재방문이 있어도
 * 이 정보를 통해 polling으로 결과를 복구할 수 있다.
 *
 * 작업이 정상 완료되면 clear, 아니면 다음 페이지 진입 시 자동 복구 시도.
 */

const STORAGE_KEY = 'labflow.pending-brain-job';

export interface PendingBrainJob {
  channelId: string | null;        // null이면 새 세션 (서버가 채널 생성)
  userMessage: string;             // 사용자 메시지 (UI 복원용)
  sentAt: string;                  // ISO 시각 — polling 기준점
  fileIds?: string[];
}

export function savePendingBrainJob(job: PendingBrainJob): void {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(job));
  } catch {
    /* ignore */
  }
}

export function getPendingBrainJob(): PendingBrainJob | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PendingBrainJob;
  } catch {
    return null;
  }
}

export function clearPendingBrainJob(): void {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Pending job이 너무 오래된 경우 (10분 이상) 자동 만료.
 * 서버 작업도 그쯤이면 끝났을 가능성 + 만료 처리되었을 가능성.
 */
export function isPendingJobStale(job: PendingBrainJob, maxAgeMs = 10 * 60 * 1000): boolean {
  const age = Date.now() - new Date(job.sentAt).getTime();
  return age > maxAgeMs;
}
