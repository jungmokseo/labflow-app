/**
 * useWakeLock — Screen Wake Lock API hook
 *
 * 모바일 브라우저에서 화면이 꺼지는 것을 방지.
 * 긴 작업(brain 채팅 응답 대기 등) 동안 활성화하면
 * 화면 sleep으로 인한 fetch streaming 끊김을 막을 수 있다.
 *
 * 주의: Wake Lock은 페이지가 visible 상태일 때만 활성화됨.
 * 사용자가 직접 잠금 버튼을 누르면 효과 없음 (이건 visibility hook으로 보완).
 */

import { useEffect, useRef, useCallback } from 'react';

type WakeLockSentinel = {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (event: 'release', cb: () => void) => void;
};

interface NavigatorWakeLock {
  wakeLock?: {
    request: (type: 'screen') => Promise<WakeLockSentinel>;
  };
}

export function useWakeLock() {
  const sentinelRef = useRef<WakeLockSentinel | null>(null);
  const activeRef = useRef(false);

  const release = useCallback(async () => {
    activeRef.current = false;
    const sentinel = sentinelRef.current;
    sentinelRef.current = null;
    if (sentinel && !sentinel.released) {
      try {
        await sentinel.release();
      } catch {
        /* ignore */
      }
    }
  }, []);

  const acquire = useCallback(async () => {
    if (typeof navigator === 'undefined') return false;
    const nav = navigator as unknown as NavigatorWakeLock;
    if (!nav.wakeLock) return false;

    activeRef.current = true;
    try {
      const sentinel = await nav.wakeLock.request('screen');
      sentinelRef.current = sentinel;
      sentinel.addEventListener('release', () => {
        // Auto-released (page hidden, etc.). If still active, try to re-acquire on visibility return.
        sentinelRef.current = null;
      });
      return true;
    } catch {
      activeRef.current = false;
      return false;
    }
  }, []);

  // 페이지가 다시 보이게 됐을 때, 활성 상태이면 재획득
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && activeRef.current && !sentinelRef.current) {
        acquire().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [acquire]);

  // 컴포넌트 언마운트 시 자동 해제
  useEffect(() => {
    return () => {
      release();
    };
  }, [release]);

  return { acquire, release };
}
