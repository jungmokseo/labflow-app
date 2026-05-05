'use client';

/**
 * ThemeSync — 페이지 navigation 시 다크모드 attribute가 풀리는 케이스 안전망.
 *
 * 사용자 보고: "다크모드 사용 중 FAQ 탭 클릭하니 갑자기 라이트모드로 바뀜"
 * 원인: 알 수 없는 외부 요인 (browser quirk, third-party script, hydration race 등)
 *
 * 안전망 3개:
 *  1. pathname 변경 시마다 attribute 검증 + 복구
 *  2. storage event 리스너 (다른 탭에서 toggle하면 동기화)
 *  3. system color-scheme media query 변경 감지 (localStorage 미설정 시)
 *
 * 로컬에 명시적으로 'theme'='light' 저장된 경우는 light 유지 (사용자 의도 존중).
 * 그 외에는 dark 우선 복구.
 */
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

function applyTheme() {
  if (typeof window === 'undefined') return;
  let stored: string | null = null;
  try { stored = localStorage.getItem('theme'); } catch {}
  const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const wantDark = stored === 'dark' || (!stored && sysDark);
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  if (wantDark && !isDark) {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else if (!wantDark && isDark) {
    document.documentElement.removeAttribute('data-theme');
  }
}

export function ThemeSync() {
  const pathname = usePathname();

  // pathname 변경 시 즉시 + raf 후 한 번 더 (hydration 끝난 후 보장)
  useEffect(() => {
    applyTheme();
    const id = requestAnimationFrame(applyTheme);
    return () => cancelAnimationFrame(id);
  }, [pathname]);

  // 다른 탭에서 theme 변경 동기화
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'theme') applyTheme();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // 시스템 color-scheme 변경 (localStorage 미설정 시)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      let stored: string | null = null;
      try { stored = localStorage.getItem('theme'); } catch {}
      if (!stored) applyTheme();
    };
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  return null;
}
