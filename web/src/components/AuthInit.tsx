'use client';

import { useEffect } from 'react';
import { useAuth } from '@clerk/nextjs';
import { setAuthTokenGetter } from '@/lib/api';

/**
 * Clerk 인증 토큰을 API 클라이언트에 연결하는 컴포넌트.
 * 최상위 레이아웃에 배치하면 모든 API 호출에 자동으로 Bearer 토큰이 첨부됩니다.
 */
export function AuthInit() {
  const { getToken } = useAuth();

  useEffect(() => {
    setAuthTokenGetter(getToken);
  }, [getToken]);

  return null;
}
