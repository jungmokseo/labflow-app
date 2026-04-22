/**
 * Offline Queue — POST/PUT/PATCH/DELETE 요청을 오프라인 중 IndexedDB에 저장하고
 * 온라인 복귀 시 순차 재전송한다.
 *
 * - GET은 SW의 stale-while-revalidate가 처리하므로 여기선 다루지 않음.
 * - SSE 스트리밍(/api/brain/chat), FormData 업로드는 큐잉 대상 외 (api.ts에서 필터).
 * - replay 시 Authorization 헤더는 현재 세션에서 새로 생성 (토큰 만료 회피).
 */
import { get, set, del, keys, createStore, type UseStore } from 'idb-keyval';

const QUEUE_KEY_PREFIX = 'q:';
const MAX_ATTEMPTS = 5;

let store: UseStore | null = null;
function getStore(): UseStore {
  if (!store) store = createStore('researchflow-offline', 'queue');
  return store;
}

export interface QueuedRequest {
  id: string;
  method: string;
  url: string;           // API_BASE-relative path (e.g. "/api/captures")
  body?: string;         // JSON string
  contentType?: string;  // defaults to 'application/json'
  createdAt: number;
  attempts: number;
  lastError?: string;
  label?: string;        // UI 표시용 (예: "메모 저장")
}

type Listener = (queue: QueuedRequest[]) => void;
const listeners = new Set<Listener>();
let cachedQueue: QueuedRequest[] = [];
let flushing = false;
let flushPromise: Promise<void> | null = null;

function notify() {
  listeners.forEach((fn) => {
    try { fn(cachedQueue); } catch { /* ignore */ }
  });
}

async function refreshQueue(): Promise<void> {
  try {
    const allKeys = await keys(getStore());
    const queueKeys = allKeys.filter((k): k is string =>
      typeof k === 'string' && k.startsWith(QUEUE_KEY_PREFIX)
    );
    const entries = await Promise.all(
      queueKeys.map((k) => get<QueuedRequest>(k, getStore()))
    );
    cachedQueue = entries
      .filter((e): e is QueuedRequest => !!e)
      .sort((a, b) => a.createdAt - b.createdAt);
    notify();
  } catch (err) {
    console.warn('[offline-queue] refresh failed:', err);
  }
}

export async function enqueueOfflineRequest(
  req: Omit<QueuedRequest, 'id' | 'createdAt' | 'attempts'>
): Promise<QueuedRequest> {
  const entry: QueuedRequest = {
    ...req,
    id: (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`),
    createdAt: Date.now(),
    attempts: 0,
  };
  await set(`${QUEUE_KEY_PREFIX}${entry.id}`, entry, getStore());
  await refreshQueue();
  return entry;
}

export async function removeFromQueue(id: string): Promise<void> {
  await del(`${QUEUE_KEY_PREFIX}${id}`, getStore());
  await refreshQueue();
}

export function getCachedQueue(): QueuedRequest[] {
  return cachedQueue;
}

export function subscribeOfflineQueue(fn: Listener): () => void {
  listeners.add(fn);
  fn(cachedQueue);
  return () => { listeners.delete(fn); };
}

/**
 * Replay queue 순차 처리. 온라인 상태에서만 동작.
 * 중복 실행 방지를 위해 in-flight promise를 재사용.
 */
export function flushOfflineQueue(
  buildHeaders: () => Promise<Record<string, string>>
): Promise<void> {
  if (typeof window === 'undefined' || !navigator.onLine) return Promise.resolve();
  if (flushPromise) return flushPromise;

  flushPromise = (async () => {
    flushing = true;
    try {
      await refreshQueue();
      const snapshot = [...cachedQueue];
      for (const entry of snapshot) {
        if (!navigator.onLine) break;
        try {
          const authHeaders = await buildHeaders();
          const headers: Record<string, string> = {
            'Content-Type': entry.contentType || 'application/json',
            ...authHeaders,
          };
          const res = await fetch(entry.url, {
            method: entry.method,
            headers,
            body: entry.body,
          });

          if (res.ok) {
            await removeFromQueue(entry.id);
            continue;
          }
          if (res.status >= 400 && res.status < 500) {
            // 클라이언트 오류(인증 제외) — 재시도 무의미, 드롭
            if (res.status === 401 || res.status === 403) {
              // 인증 오류 — 토큰 갱신 후 다음 flush에서 재시도
              entry.attempts++;
              entry.lastError = `HTTP ${res.status}`;
              await set(`${QUEUE_KEY_PREFIX}${entry.id}`, entry, getStore());
              break;
            }
            console.warn('[offline-queue] dropping (4xx):', entry.url, res.status);
            await removeFromQueue(entry.id);
            continue;
          }
          // 5xx — 재시도
          entry.attempts++;
          entry.lastError = `HTTP ${res.status}`;
          if (entry.attempts >= MAX_ATTEMPTS) {
            console.warn('[offline-queue] dropping after max attempts:', entry.url);
            await removeFromQueue(entry.id);
          } else {
            await set(`${QUEUE_KEY_PREFIX}${entry.id}`, entry, getStore());
          }
        } catch (err) {
          // 네트워크 오류 — 남겨두고 중단 (다음 online 이벤트에서 재시도)
          entry.attempts++;
          entry.lastError = err instanceof Error ? err.message : String(err);
          await set(`${QUEUE_KEY_PREFIX}${entry.id}`, entry, getStore());
          break;
        }
      }
      await refreshQueue();
    } finally {
      flushing = false;
      flushPromise = null;
    }
  })();

  return flushPromise;
}

export function isFlushing(): boolean {
  return flushing;
}

// 초기 1회 캐시 로드 (브라우저 전용)
if (typeof window !== 'undefined') {
  refreshQueue();
}
