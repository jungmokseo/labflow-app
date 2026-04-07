'use client';

import { useState, useEffect } from 'react';
import { getEmailStatus, getEmailAuthUrl } from '@/lib/api';

/**
 * 앱 로드 시 Google OAuth 토큰 유효성을 검증하고,
 * 재인증이 필요하면 상단 배너를 표시합니다.
 */
export function TokenHealthCheck() {
  const [needsReauth, setNeedsReauth] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    checkTokenHealth();
  }, []);

  async function checkTokenHealth() {
    try {
      const status = await getEmailStatus();
      if (status.needsReauth) {
        setNeedsReauth(true);
      }
    } catch {
      // 인증 안 된 상태이거나 서버 오류 — 무시
    }
  }

  async function handleReauth() {
    setLoading(true);
    try {
      const data = await getEmailAuthUrl();
      if (data.authUrl) {
        window.location.href = data.authUrl;
      }
    } catch {
      setLoading(false);
    }
  }

  if (!needsReauth) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-50 bg-amber-600 text-white px-4 py-2.5 text-sm flex items-center justify-center gap-3">
      <span>Google 인증이 만료되었습니다. 이메일, 캘린더, Google Docs 기능을 사용하려면 재인증이 필요합니다.</span>
      <button
        onClick={handleReauth}
        disabled={loading}
        className="px-4 py-1 bg-white text-amber-700 rounded-md text-sm font-medium hover:bg-amber-50 disabled:opacity-50"
      >
        {loading ? '이동 중...' : '재인증'}
      </button>
      <button
        onClick={() => setNeedsReauth(false)}
        className="text-white/70 hover:text-white text-xs ml-2"
      >
        닫기
      </button>
    </div>
  );
}
