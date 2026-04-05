'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { usePathname } from 'next/navigation';

/**
 * GitHub/YouTube 스타일 상단 프로그레스 바
 * - 페이지 전환 시 자동 표시
 * - API 호출 중 표시 (fetch intercept)
 * - 수동 트리거 가능 (startProgress / stopProgress)
 */

let activeRequests = 0;
let progressStart: (() => void) | null = null;
let progressDone: (() => void) | null = null;

// Global API for manual control
export function startProgress() { progressStart?.(); }
export function stopProgress() { progressDone?.(); }

export function GlobalProgress() {
  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);
  const pathname = usePathname();
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const start = useCallback(() => {
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
    setVisible(true);
    setProgress(15);
    // Simulate progress — fast at start, slows down approaching 90%
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setProgress(p => {
        if (p >= 90) return p;
        const increment = p < 30 ? 8 : p < 50 ? 4 : p < 70 ? 2 : 0.5;
        return Math.min(p + increment, 90);
      });
    }, 200);
  }, []);

  const done = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    setProgress(100);
    hideTimerRef.current = setTimeout(() => {
      setVisible(false);
      setProgress(0);
    }, 300);
  }, []);

  // Register global handlers
  useEffect(() => {
    progressStart = start;
    progressDone = done;
    return () => { progressStart = null; progressDone = null; };
  }, [start, done]);

  // Route change detection
  useEffect(() => {
    done();
  }, [pathname, done]);

  // Intercept fetch to show progress during API calls
  useEffect(() => {
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] as Request).url;
      // Only track API calls (not static assets)
      const isApi = url.includes('/api/') || url.includes('railway.app') || url.includes('supabase');

      if (isApi) {
        activeRequests++;
        if (activeRequests === 1) start();
      }

      try {
        const response = await originalFetch(...args);
        return response;
      } finally {
        if (isApi) {
          activeRequests--;
          if (activeRequests <= 0) {
            activeRequests = 0;
            done();
          }
        }
      }
    };

    return () => { window.fetch = originalFetch; };
  }, [start, done]);

  if (!visible) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-[9999] h-0.5 bg-transparent pointer-events-none">
      <div
        className="h-full bg-primary shadow-[0_0_8px_rgba(99,102,241,0.6)] transition-all duration-200 ease-out"
        style={{ width: `${progress}%` }}
      />
    </div>
  );
}
