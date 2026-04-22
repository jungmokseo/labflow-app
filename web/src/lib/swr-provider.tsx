'use client';
/**
 * SWR cache persister — localStorage 기반.
 *
 * 목적: 오프라인/새로고침 복귀 시 이전 캐시된 GET 응답을 즉시 표시.
 * - Map을 localStorage에 직렬화. visibilitychange/beforeunload에서 저장.
 * - 2MB cap. 초과 시 전체 초기화 (용량 관리).
 */
import { SWRConfig, type Cache } from 'swr';
import type { ReactNode } from 'react';

const STORAGE_KEY = 'rf-swr-cache-v1';
const MAX_BYTES = 2 * 1024 * 1024;

function createProvider(): Cache<unknown> {
  if (typeof window === 'undefined') return new Map() as unknown as Cache<unknown>;

  let map: Map<string, unknown>;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const entries: [string, unknown][] = stored ? JSON.parse(stored) : [];
    map = new Map(entries);
  } catch {
    map = new Map();
  }

  const save = () => {
    try {
      const serialized = JSON.stringify(Array.from(map.entries()));
      if (serialized.length > MAX_BYTES) {
        localStorage.removeItem(STORAGE_KEY);
        return;
      }
      localStorage.setItem(STORAGE_KEY, serialized);
    } catch {
      // QuotaExceeded 등 — 조용히 무시
    }
  };

  window.addEventListener('beforeunload', save);
  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') save();
  });

  return map as unknown as Cache<unknown>;
}

export function SWRProvider({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{
        provider: createProvider,
        revalidateOnFocus: false,
        revalidateOnReconnect: true,
        keepPreviousData: true,
      }}
    >
      {children}
    </SWRConfig>
  );
}
