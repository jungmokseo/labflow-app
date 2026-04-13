'use client';

import { useEffect } from 'react';
import { mutate } from 'swr';
import { getCaptures, getBrainChannels, getMeetings, getPaperAlertResults } from '@/lib/api';

/**
 * Prefetch all critical page data on app init.
 * This runs once on mount and warms the SWR cache
 * so tab switches are instant.
 */
export function DataPrefetch() {
  useEffect(() => {
    // Delay prefetch to not block initial page render
    const timer = setTimeout(() => {
      // Prefetch in parallel — errors are silent
      Promise.allSettled([
        // Keys must match tasks/page.tsx SWR keys: captures-${tab}-active / captures-${tab}-completed
        mutate('captures-all-active', () => getCaptures({ completed: 'false', sort: 'newest', limit: 100 })),
        mutate('captures-all-completed', () => getCaptures({ completed: 'true', sort: 'newest', limit: 20 })),
        mutate('brain-channels', () => getBrainChannels().then(r => Array.isArray(r.data) ? r.data : [])),
        mutate('meetings', () => getMeetings()),
        mutate('paper-results', () => getPaperAlertResults().then(r => r.results || r.data || []).catch(() => null)),
      ]);
    }, 500); // 500ms delay — let current page render first

    return () => clearTimeout(timer);
  }, []);

  return null;
}
