'use client';

import { useEffect, useState } from 'react';
import { getEmailStatus, getEmailAuthUrl, getEmailProfile, checkHealth, EmailProfile } from '@/lib/api';

export default function SettingsPage() {
  const [health, setHealth] = useState<boolean | null>(null);
  const [emailConnected, setEmailConnected] = useState(false);
  const [profile, setProfile] = useState<EmailProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [h, emailRes] = await Promise.allSettled([
          checkHealth(),
          getEmailStatus(),
        ]);

        if (h.status === 'fulfilled') setHealth(h.value);
        if (emailRes.status === 'fulfilled') {
          setEmailConnected(emailRes.value.connected);
          if (emailRes.value.connected) {
            try {
              const p = await getEmailProfile();
              setProfile(p.data);
            } catch { /* profile might not exist */ }
          }
        }
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const handleConnectGmail = async () => {
    try {
      const res = await getEmailAuthUrl();
      window.open(res.url, '_blank');
    } catch (err) {
      console.error('Failed to get auth URL:', err);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-white">⚙️ 설정</h2>
        <p className="text-text-muted mt-1">LabFlow 시스템 설정을 관리합니다</p>
      </div>

      {/* 시스템 상태 */}
      <section className="bg-bg-card rounded-xl border border-bg-input/50 p-5 space-y-4">
        <h3 className="font-semibold text-white text-sm">시스템 상태</h3>
        <div className="grid grid-cols-2 gap-4">
          <StatusItem
            label="API 서버"
            status={health === true ? 'healthy' : health === false ? 'error' : 'checking'}
            detail="labflow-app-production.up.railway.app"
          />
          <StatusItem
            label="Gmail 연동"
            status={emailConnected ? 'healthy' : 'disconnected'}
            detail={emailConnected ? '연동됨' : '미연동'}
          />
          <StatusItem
            label="인증 모드"
            status="info"
            detail="Dev Mode (X-Dev-User-Id)"
          />
          <StatusItem
            label="AI 모델"
            status="info"
            detail="Gemini Flash + Claude Sonnet"
          />
        </div>
      </section>

      {/* Gmail 연동 */}
      <section className="bg-bg-card rounded-xl border border-bg-input/50 p-5 space-y-4">
        <h3 className="font-semibold text-white text-sm">Gmail 연동</h3>
        {emailConnected ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-green-400 text-sm">
              <span className="w-2.5 h-2.5 rounded-full bg-green-400" />
              Gmail이 연결되어 있습니다
            </div>
            {profile && (
              <div className="bg-bg/50 rounded-lg p-4 space-y-2">
                <div className="text-xs text-text-muted">표시 이름: <span className="text-white">{profile.displayName}</span></div>
                {profile.accounts?.map((acc, i) => (
                  <div key={i} className="text-xs text-text-muted">
                    계정: <span className="text-white">{acc.email}</span>
                    {acc.label && <span className="ml-2 text-primary">({acc.label})</span>}
                  </div>
                ))}
                <div className="text-xs text-text-muted">
                  브리핑 시간: <span className="text-white">{profile.briefingTime || '설정 안됨'}</span>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div>
            <p className="text-sm text-text-muted mb-3">
              Gmail을 연동하면 AI가 매일 이메일을 자동으로 분류하고 요약합니다.
            </p>
            <button
              onClick={handleConnectGmail}
              className="px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg text-sm font-medium transition-colors"
            >
              Gmail 연동하기
            </button>
          </div>
        )}
      </section>

      {/* API 정보 */}
      <section className="bg-bg-card rounded-xl border border-bg-input/50 p-5 space-y-4">
        <h3 className="font-semibold text-white text-sm">API 정보</h3>
        <div className="bg-bg/50 rounded-lg p-4 space-y-2 font-mono text-xs">
          <div className="text-text-muted">Base URL: <span className="text-primary">https://labflow-app-production.up.railway.app</span></div>
          <div className="text-text-muted">Auth Header: <span className="text-white">X-Dev-User-Id: dev-user-seo</span></div>
          <div className="text-text-muted">Database: <span className="text-white">Supabase PostgreSQL (Seoul)</span></div>
          <div className="text-text-muted">Hosting: <span className="text-white">Railway</span></div>
        </div>
      </section>

      {/* 앱 정보 */}
      <section className="bg-bg-card rounded-xl border border-bg-input/50 p-5">
        <h3 className="font-semibold text-white text-sm mb-3">앱 정보</h3>
        <div className="text-xs text-text-muted space-y-1">
          <p>LabFlow v0.1.0 — Phase 1 MVP</p>
          <p>© 2026 ResearchFlow. All rights reserved.</p>
          <p className="mt-2">Stack: Next.js 14 + Fastify 5 + Prisma + Supabase + Expo</p>
        </div>
      </section>
    </div>
  );
}

function StatusItem({ label, status, detail }: { label: string; status: string; detail: string }) {
  const colors: Record<string, string> = {
    healthy: 'bg-green-400',
    error: 'bg-red-400',
    checking: 'bg-yellow-400 animate-pulse',
    disconnected: 'bg-gray-500',
    info: 'bg-blue-400',
  };

  return (
    <div className="flex items-center gap-3 bg-bg/50 rounded-lg p-3">
      <span className={`w-2.5 h-2.5 rounded-full ${colors[status] || 'bg-gray-400'}`} />
      <div>
        <p className="text-xs font-medium text-white">{label}</p>
        <p className="text-[10px] text-text-muted">{detail}</p>
      </div>
    </div>
  );
}
