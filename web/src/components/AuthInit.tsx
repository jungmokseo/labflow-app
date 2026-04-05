'use client';

import { useEffect, useRef } from 'react';
import { setAuthTokenGetter, clearTokenCache } from '@/lib/api';
import { createClient } from '@/lib/supabase';

/**
 * Supabase 인증 토큰을 API 클라이언트에 연결하는 컴포넌트.
 * 최상위 레이아웃에 배치하면 모든 API 호출에 자동으로 Bearer 토큰이 첨부됩니다.
 */
export function AuthInit() {
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    const supabase = createClient();

    // 세션 변경 시 토큰을 캐시
    let cachedToken: string | null = null;

    supabase.auth.getSession().then(({ data: { session } }) => {
      cachedToken = session?.access_token ?? null;
    });

    supabase.auth.onAuthStateChange((_event, session) => {
      cachedToken = session?.access_token ?? null;
      if (!session) {
        clearTokenCache();
      }
    });

    setAuthTokenGetter(async () => {
      // 캐시된 토큰이 있으면 바로 반환 (대부분의 경우)
      if (cachedToken) return cachedToken;
      // fallback: 직접 세션 조회
      const { data: { session } } = await supabase.auth.getSession();
      cachedToken = session?.access_token ?? null;
      return cachedToken;
    });
  }, []);

  return null;
}
