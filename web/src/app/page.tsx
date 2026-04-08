'use client';

import { useEffect, useState } from 'react';
import { getMeetings, checkHealth, getCostSummary, Meeting, CostSummary } from '@/lib/api';
import { DashboardSkeleton } from '@/components/Skeleton';
import { Brain, ClipboardList, BookOpen, Mic, DollarSign } from 'lucide-react';

export default function DashboardPage() {
  const [isHealthy, setIsHealthy] = useState<boolean | null>(null);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [costData, setCostData] = useState<CostSummary | null>(null);
  const [costError, setCostError] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [health, meetingRes, costRes] = await Promise.allSettled([
          checkHealth(),
          getMeetings(5),
          getCostSummary(30),
        ]);

        if (health.status === 'fulfilled') setIsHealthy(health.value);
        if (meetingRes.status === 'fulfilled') setMeetings(meetingRes.value.data);
        if (costRes.status === 'fulfilled') setCostData(costRes.value);
        else setCostError(true);
      } catch (err) {
        console.error('Dashboard load error:', err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) return <DashboardSkeleton />;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold text-text-heading">오늘의 대시보드</h2>
          <p className="text-base text-text-muted mt-1">
            {new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}
          </p>
        </div>
        <StatusBadge healthy={isHealthy} />
      </div>

      {/* 바로가기 카드 */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <a href="/brain" className="bg-bg-card rounded-xl border border-border p-5 card-hover hover:border-primary/30">
          <Brain className="w-7 h-7 text-primary" />
          <h3 className="text-base font-medium text-text-heading mt-3">Brain</h3>
          <p className="text-sm text-text-muted mt-1">이메일, 일정, 메모 -- 대화로 요청</p>
        </a>
        <a href="/tasks" className="bg-bg-card rounded-xl border border-border p-5 card-hover hover:border-primary/30">
          <ClipboardList className="w-7 h-7 text-blue-400" />
          <h3 className="text-base font-medium text-text-heading mt-3">Tasks & Ideas</h3>
          <p className="text-sm text-text-muted mt-1">할일, 아이디어, 메모 관리</p>
        </a>
        <a href="/papers" className="bg-bg-card rounded-xl border border-border p-5 card-hover hover:border-primary/30">
          <BookOpen className="w-7 h-7 text-green-400" />
          <h3 className="text-base font-medium text-text-heading mt-3">연구동향</h3>
          <p className="text-sm text-text-muted mt-1">주간 자동 논문 모니터링</p>
        </a>
        <a href="/meetings" className="bg-bg-card rounded-xl border border-border p-5 card-hover hover:border-primary/30">
          <Mic className="w-7 h-7 text-yellow-400" />
          <h3 className="text-base font-medium text-text-heading mt-3">회의 노트</h3>
          <p className="text-sm text-text-muted mt-1">{meetings.length}건의 회의 기록</p>
        </a>
      </div>

      {/* 최근 회의 + AI 비용 — 2열 그리드 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* 최근 회의 */}
        <div className="bg-bg-card rounded-xl border border-border p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-text-heading flex items-center gap-2"><Mic className="w-4 h-4 text-yellow-400" /> 최근 회의</h3>
            <a href="/meetings" className="text-sm text-primary hover:underline">모두 보기 →</a>
          </div>
          {meetings.length === 0 ? (
            <p className="text-text-muted text-base py-8 text-center">아직 회의 기록이 없습니다</p>
          ) : (
            <div className="space-y-3">
              {meetings.map((m) => (
                <div key={m.id} className="p-3 rounded-lg bg-bg-input hover:bg-bg-hover/30 transition-colors">
                  <p className="text-base font-medium text-text-heading">{m.title}</p>
                  {m.summary && (
                    <p className="text-sm text-text-muted mt-1 line-clamp-2">{m.summary}</p>
                  )}
                  <div className="flex items-center gap-3 mt-2">
                    {m.actionItems.length > 0 && (
                      <span className="text-xs text-yellow-400">{m.actionItems.length} 액션아이템</span>
                    )}
                    <span className="text-xs text-text-muted">
                      {new Date(m.createdAt).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* AI API 비용 */}
        <div className="bg-bg-card rounded-xl border border-border p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-text-heading flex items-center gap-2"><DollarSign className="w-4 h-4 text-green-400" /> AI API 비용</h3>
            <span className="text-xs text-text-muted">최근 30일</span>
          </div>
          {costError ? (
            <p className="text-text-muted text-base py-8 text-center">사용 후 비용 데이터가 표시됩니다</p>
          ) : !costData ? (
            <p className="text-text-muted text-base py-8 text-center">비용 데이터를 불러오는 중...</p>
          ) : (
            <div className="space-y-4">
              {/* 요약 카드 */}
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-bg-input rounded-lg p-3">
                  <p className="text-xs text-text-muted">오늘</p>
                  <p className="text-lg font-bold text-text-heading">${costData.todayCost.toFixed(4)}</p>
                  <p className="text-xs text-text-muted">{costData.todayCalls}회 호출</p>
                </div>
                <div className="bg-bg-input rounded-lg p-3">
                  <p className="text-xs text-text-muted">30일 합계</p>
                  <p className="text-lg font-bold text-text-heading">${costData.totalCost.toFixed(4)}</p>
                  <p className="text-xs text-text-muted">{costData.totalCalls}회 호출</p>
                </div>
              </div>

              {/* 서비스별 내역 */}
              <div>
                <p className="text-xs text-text-muted mb-2 font-medium">서비스별 내역</p>
                <div className="space-y-2">
                  {Object.entries(costData.byService)
                    .sort(([, a], [, b]) => b.cost - a.cost)
                    .map(([service, data]) => {
                      const pct = costData.totalCost > 0 ? (data.cost / costData.totalCost) * 100 : 0;
                      const label: Record<string, string> = {
                        'gemini-flash': 'Gemini Flash',
                        'claude-sonnet': 'Claude Sonnet',
                        'openai-embedding': 'OpenAI Embedding',
                        'openai-realtime': 'OpenAI Realtime',
                        'openai-whisper': 'Whisper STT',
                      };
                      const color: Record<string, string> = {
                        'gemini-flash': 'bg-blue-500',
                        'claude-sonnet': 'bg-orange-500',
                        'openai-embedding': 'bg-green-500',
                        'openai-realtime': 'bg-purple-500',
                        'openai-whisper': 'bg-yellow-500',
                      };
                      return (
                        <div key={service}>
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-text-body">{label[service] || service}</span>
                            <span className="text-text-muted">${data.cost.toFixed(4)} ({data.calls}회)</span>
                          </div>
                          <div className="w-full h-1.5 bg-bg-hover rounded-full mt-1">
                            <div
                              className={`h-full rounded-full ${color[service] || 'bg-gray-500'}`}
                              style={{ width: `${Math.max(pct, 1)}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                </div>
              </div>

              {/* 일별 추이 (최근 7일) */}
              <div>
                <p className="text-xs text-text-muted mb-2 font-medium">최근 7일 추이</p>
                <div className="flex items-end gap-1 h-16">
                  {(() => {
                    const days = [];
                    for (let i = 6; i >= 0; i--) {
                      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
                      const key = d.toISOString().split('T')[0];
                      days.push({ key, label: `${d.getMonth() + 1}/${d.getDate()}`, cost: costData.byDay[key]?.cost || 0 });
                    }
                    const maxCost = Math.max(...days.map(d => d.cost), 0.001);
                    return days.map(d => (
                      <div key={d.key} className="flex-1 flex flex-col items-center gap-1">
                        <div
                          className="w-full bg-primary/60 rounded-sm min-h-[2px]"
                          style={{ height: `${Math.max((d.cost / maxCost) * 48, 2)}px` }}
                          title={`${d.label}: $${d.cost.toFixed(4)}`}
                        />
                        <span className="text-[10px] text-text-muted">{d.label}</span>
                      </div>
                    ));
                  })()}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
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

