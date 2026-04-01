'use client';

import { useEffect } from 'react';
import { setAuthTokenGetter } from '@/lib/api';
import { createClient } from '@/lib/supabase';

/**
 * Supabase 인증 토큰을 API 클라이언트에 연결하는 컴포넌트.
 * 최상위 레이아웃에 배치하면 모든 API 호출에 자동으로 Bearer 토큰이 첨부됩니다.
 */
export function AuthInit() {
  useEffect(() => {
    const supabase = createClient();
    setAuthTokenGetter(async () => {
      const { data: { session } } = await supabase.auth.getSession();
      return session?.access_token ?? null;
    });
  }, []);

  return null;
}
