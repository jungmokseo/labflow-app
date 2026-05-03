'use client';

import { useEffect } from 'react';
import { mutate } from 'swr';
import { getCaptures, getBrainChannels, getMeetings, getPaperAlertResults } from '@/lib/api';

/**
 * Prefetch all critical page data on app init.
 * Uses requestIdleCallback (or 50ms timeout fallback) to start prefetching
 * as soon as the browser is idle — much faster than 500ms hard delay.
 */
export function DataPrefetch() {
  useEffect(() => {
    const runPrefetch = () => {
      Promise.allSettled([
        mutate('captures-all-active', () => getCaptures({ completed: 'false', sort: 'newest', limit: 100 })),
        mutate('captures-all-completed', () => getCaptures({ completed: 'true', sort: 'newest', limit: 20 })),
        mutate('brain-channels', () => getBrainChannels().then(r => Array.isArray(r.data) ? r.data : [])),
        mutate('meetings', () => getMeetings()),
        mutate('paper-results', () => getPaperAlertResults().then(r => r.results || r.data || []).catch(() => null)),
      ]);
    };

    // requestIdleCallback이 있으면 사용 (브라우저 idle 시 실행), 없으면 짧은 setTimeout
    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      const handle = (window as any).requestIdleCallback(runPrefetch, { timeout: 1000 });
      return () => (window as any).cancelIdleCallback?.(handle);
    }
    const timer = setTimeout(runPrefetch, 50);
    return () => clearTimeout(timer);
  }, []);

  return null;
}
