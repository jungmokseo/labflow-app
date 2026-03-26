'use client';

import { useEffect, useState } from 'react';
import { getCaptures, getEmailStatus, getMeetings, checkHealth, Capture, Meeting } from '@/lib/api';

// ── 카테고리 배지 색상 ──────────────────────────────
const CATEGORY_COLORS: Record<string, string> = {
  IDEA: 'bg-yellow-500/20 text-yellow-400',
  TASK: 'bg-blue-500/20 text-blue-400',
  MEMO: 'bg-green-500/20 text-green-400',
  QUESTION: 'bg-purple-500/20 text-purple-400',
  REFERENCE: 'bg-cyan-500/20 text-cyan-400',
};

const PRIORITY_ICON: Record<string, string> = {
  HIGH: '🔴',
  MEDIUM: '🟡',
  LOW: '🟢',
};

export default function DashboardPage() {
  const [isHealthy, setIsHealthy] = useState<boolean | null>(null);
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [emailConnected, setEmailConnected] = useState(false);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [health, captureRes, emailRes, meetingRes] = await Promise.allSettled([
          checkHealth(),
          getCaptures(5),
          getEmailStatus(),
          getMeetings(3),
        ]);

        if (health.status === 'fulfilled') setIsHealthy(health.value);
        if (captureRes.status === 'fulfilled') setCaptures(captureRes.value.data);
        if (emailRes.status === 'fulfilled') setEmailConnected(emailRes.value.connected);
        if (meetingRes.status === 'fulfilled') setMeetings(meetingRes.value.data);
      } catch (err) {
        console.error('Dashboard load error:', err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full mx-auto mb-4" />
          <p className="text-text-muted">대시보드 로딩 중...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white">오늘의 대시보드</h2>
          <p className="text-text-muted mt-1">
            {new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}
          </p>
        </div>
        <StatusBadge healthy={isHealthy} />
      </div>

      {/* 요약 카드들 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <SummaryCard
          icon="⚡"
          title="캡처"
          value={captures.length}
          subtitle={`${captures.filter(c => !c.completed).length}개 진행 중`}
          color="text-yellow-400"
        />
        <SummaryCard
          icon="✉️"
          title="이메일"
          value={emailConnected ? '연동됨' : '미연동'}
          subtitle={emailConnected ? 'Gmail 브리핑 활성' : 'Gmail 연동 필요'}
          color={emailConnected ? 'text-green-400' : 'text-red-400'}
        />
        <SummaryCard
          icon="🎙️"
          title="회의"
          value={meetings.length}
          subtitle="최근 회의 기록"
          color="text-blue-400"
        />
      </div>

      {/* 메인 그리드 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 최근 캡처 */}
        <div className="bg-bg-card rounded-xl border border-bg-input/50 p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-white">📝 최근 캡처</h3>
            <a href="/captures" className="text-xs text-primary hover:underline">모두 보기 →</a>
          </div>
          {captures.length === 0 ? (
            <p className="text-text-muted text-sm py-8 text-center">아직 캡처가 없습니다</p>
          ) : (
            <div className="space-y-3">
              {captures.map((c) => (
                <div key={c.id} className="flex items-start gap-3 p-3 rounded-lg bg-bg/50 hover:bg-bg-input/30 transition-colors">
                  <span className="text-sm mt-0.5">{PRIORITY_ICON[c.priority] || '⚪'}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white truncate">{c.content}</p>
                    <p className="text-xs text-text-muted mt-1">{c.summary}</p>
                    <div className="flex items-center gap-2 mt-2">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full ${CATEGORY_COLORS[c.category] || 'bg-gray-500/20 text-gray-400'}`}>
                        {c.category}
                      </span>
                      <span className="text-[10px] text-text-muted">
                        {new Date(c.createdAt).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  </div>
                  {c.completed && <span className="text-green-400 text-xs">✓</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 최근 회의 */}
        <div className="bg-bg-card rounded-xl border border-bg-input/50 p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-white">🎙️ 최근 회의</h3>
            <a href="/meetings" className="text-xs text-primary hover:underline">모두 보기 →</a>
          </div>
          {meetings.length === 0 ? (
            <p className="text-text-muted text-sm py-8 text-center">아직 회의 기록이 없습니다</p>
          ) : (
            <div className="space-y-3">
              {meetings.map((m) => (
                <div key={m.id} className="p-3 rounded-lg bg-bg/50 hover:bg-bg-input/30 transition-colors">
                  <p className="text-sm font-medium text-white">{m.title}</p>
                  {m.summary && (
                    <p className="text-xs text-text-muted mt-1 line-clamp-2">{m.summary}</p>
                  )}
                  <div className="flex items-center gap-3 mt-2">
                    {m.actionItems.length > 0 && (
                      <span className="text-[10px] text-yellow-400">📋 {m.actionItems.length} 액션아이템</span>
                    )}
                    <span className="text-[10px] text-text-muted">
                      {new Date(m.createdAt).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 이메일 브리핑 섹션 */}
      {!emailConnected && (
        <div className="bg-bg-card rounded-xl border border-bg-input/50 p-6 text-center">
          <span className="text-4xl mb-3 block">✉️</span>
          <h3 className="font-semibold text-white mb-2">이메일 브리핑</h3>
          <p className="text-text-muted text-sm mb-4">
            Gmail을 연동하면 AI가 매일 이메일을 분류하고 요약합니다
          </p>
          <button className="px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg text-sm transition-colors">
            Gmail 연동하기
          </button>
        </div>
      )}
    </div>
  );
}

// ── 컴포넌트 ──────────────────────────────────────
function StatusBadge({ healthy }: { healthy: boolean | null }) {
  if (healthy === null) return null;
  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs ${
      healthy ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'
    }`}>
      <span className={`w-2 h-2 rounded-full ${healthy ? 'bg-green-400' : 'bg-red-400'} animate-pulse`} />
      {healthy ? 'API 정상' : 'API 오류'}
    </div>
  );
}

function SummaryCard({ icon, title, value, subtitle, color }: {
  icon: string;
  title: string;
  value: string | number;
  subtitle: string;
  color: string;
}) {
  return (
    <div className="bg-bg-card rounded-xl border border-bg-input/50 p-5">
      <div className="flex items-center justify-between">
        <span className="text-2xl">{icon}</span>
        <span className={`text-2xl font-bold ${color}`}>{value}</span>
      </div>
      <h3 className="text-sm font-medium text-white mt-3">{title}</h3>
      <p className="text-xs text-text-muted mt-1">{subtitle}</p>
    </div>
  );
}
