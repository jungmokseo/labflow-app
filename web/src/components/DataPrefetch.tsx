'use client';

import { useEffect } from 'react';
import { mutate } from 'swr';
import { getCaptures, getBrainChannels, getMeetings, getPaperAlertResults } from '@/lib/api';

/**
 * Warm a few high-traffic SWR keys after the first paint.
 * Keep this idle-only: app startup should render before background network work.
 */
export function DataPrefetch() {
  useEffect(() => {
    let cancelled = false;
    const runPrefetch = () => {
      if (cancelled) return;
      const connection = (navigator as any).connection;
      if (connection?.saveData || /2g/.test(connection?.effectiveType || '')) return;

      Promise.allSettled([
        mutate('captures-all-active', () => getCaptures({ completed: 'false', sort: 'newest', limit: 100 }), { revalidate: false }),
        mutate('captures-all-completed', () => getCaptures({ completed: 'true', sort: 'newest', limit: 20 }), { revalidate: false }),
        mutate('brain-channels', () => getBrainChannels().then(r => Array.isArray(r.data) ? r.data : []), { revalidate: false }),
        mutate('meetings', () => getMeetings(), { revalidate: false }),
        mutate('paper-results-v2', () => getPaperAlertResults().catch(() => null), { revalidate: false }),
      ]);
    };

    // requestIdleCallback이 있으면 사용, 없으면 첫 렌더 후 충분히 늦게 실행.
    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      const handle = (window as any).requestIdleCallback(runPrefetch, { timeout: 3000 });
      return () => {
        cancelled = true;
        (window as any).cancelIdleCallback?.(handle);
      };
    }
    const timer = setTimeout(runPrefetch, 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  return null;
}
