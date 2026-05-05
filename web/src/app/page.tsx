'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getMeetings, checkHealth, getCostSummary, getFollowUpList, Meeting, CostSummary, FollowUpItem } from '@/lib/api';
import { Brain, ClipboardList, BookOpen, Mic, DollarSign, HelpCircle, ArrowRight, User, Clock } from 'lucide-react';

export default function DashboardPage() {
  // 위젯별 독립 state — 각 fetch가 도착하는대로 즉시 표시 (Promise.allSettled로 묶지 않음)
  const [isHealthy, setIsHealthy] = useState<boolean | null>(null);
  const [meetings, setMeetings] = useState<Meeting[] | null>(null); // null = 로딩 중
  const [costData, setCostData] = useState<CostSummary | null>(null);
  const [costError, setCostError] = useState(false);
  const [pendingQs, setPendingQs] = useState<FollowUpItem[] | null>(null);
  const [pendingCount, setPendingCount] = useState<number>(0);

  // 첫 렌더는 즉시 (Skeleton wrapper 없음). 각 위젯이 자기 placeholder 보여줌.
  useEffect(() => {
    checkHealth().then(setIsHealthy).catch(() => setIsHealthy(false));
    getMeetings(5).then(res => setMeetings(res.data)).catch(() => setMeetings([]));
    getCostSummary(30).then(setCostData).catch(() => setCostError(true));
    getFollowUpList({ status: 'pending', limit: 5 })
      .then(res => { setPendingQs(res.items); setPendingCount(res.counts.pending); })
      .catch(() => { setPendingQs([]); setPendingCount(0); });
  }, []);

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto space-y-5 md:space-y-7 pb-20 md:pb-12">
      {/* 헤더 — 페이지 제목 좌측에 컬러 인디케이터 */}
      <div className="flex items-start md:items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <span className="w-1 h-9 md:h-11 bg-primary rounded-full flex-shrink-0" />
          <div className="min-w-0">
            <h1 className="text-2xl md:text-3xl font-bold text-text-heading tracking-tight leading-tight">오늘의 대시보드</h1>
            <p className="text-sm md:text-base text-text-muted mt-1">
              {new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {pendingCount > 0 && (
            <Link
              href="/follow-up"
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30 hover:bg-amber-500/25 transition-colors focus-ring"
              aria-label={`FAQ 답변 대기 ${pendingCount}건으로 이동`}
            >
              <span className="relative flex h-2 w-2" aria-hidden="true">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
              </span>
              FAQ 답변 대기 {pendingCount}건
            </Link>
          )}
          <StatusBadge healthy={isHealthy} />
        </div>
      </div>

      {/* 바로가기 카드 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
        <Link href="/brain" className="bg-bg-card rounded-xl border border-border p-4 md:p-5 card-hover hover:border-primary/30 focus-ring">
          <Brain className="w-6 h-6 md:w-7 md:h-7 text-primary" />
          <h3 className="text-sm md:text-base font-medium text-text-heading mt-3">Brain</h3>
          <p className="text-xs md:text-sm text-text-muted mt-1 line-clamp-2">이메일, 일정, 메모 -- 대화로 요청</p>
        </Link>
        <Link href="/tasks" className="bg-bg-card rounded-xl border border-border p-4 md:p-5 card-hover hover:border-primary/30 focus-ring">
          <ClipboardList className="w-6 h-6 md:w-7 md:h-7 text-blue-400" />
          <h3 className="text-sm md:text-base font-medium text-text-heading mt-3">Tasks & Ideas</h3>
          <p className="text-xs md:text-sm text-text-muted mt-1 line-clamp-2">할일, 아이디어, 메모 관리</p>
        </Link>
        <Link href="/papers" className="bg-bg-card rounded-xl border border-border p-4 md:p-5 card-hover hover:border-primary/30 focus-ring">
          <BookOpen className="w-6 h-6 md:w-7 md:h-7 text-green-400" />
          <h3 className="text-sm md:text-base font-medium text-text-heading mt-3">연구동향</h3>
          <p className="text-xs md:text-sm text-text-muted mt-1 line-clamp-2">주간 자동 논문 모니터링</p>
        </Link>
        <Link href="/meetings" className="bg-bg-card rounded-xl border border-border p-4 md:p-5 card-hover hover:border-primary/30 focus-ring">
          <Mic className="w-6 h-6 md:w-7 md:h-7 text-amber-600" />
          <h3 className="text-sm md:text-base font-medium text-text-heading mt-3">회의 노트</h3>
          <p className="text-xs md:text-sm text-text-muted mt-1 line-clamp-2">{meetings === null ? '...' : `${meetings.length}건의 회의 기록`}</p>
        </Link>
      </div>

      {/* 미답변 질문 미리보기 — 답변 대기 시 항상 표시 */}
      {pendingQs && pendingQs.length > 0 && (
        <section className="bg-amber-50/40 dark:bg-amber-500/5 border border-amber-500/30 rounded-xl p-4 md:p-5">
          <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
            <h2 className="text-base md:text-lg font-semibold text-text-heading flex items-center gap-2">
              <HelpCircle className="w-4 h-4 text-amber-600 flex-shrink-0" />
              <span className="truncate">BLISS-bot 미답변 질문</span>
              <span className="ml-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500 text-white flex-shrink-0">
                {pendingCount}건
              </span>
            </h2>
            <Link href="/follow-up" className="text-sm text-amber-700 dark:text-amber-300 hover:underline inline-flex items-center gap-1 focus-ring rounded">
              모두 답변하기 <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
          <p className="text-xs text-text-muted mb-3">
            학생이 BLISS-bot에 질문했지만 챗봇이 답하지 못했어요. 답변하면 자동으로 FAQ에 등록됩니다.
          </p>
          <div className="space-y-2">
            {pendingQs.slice(0, 3).map(q => (
              <Link
                key={q.id}
                href="/follow-up"
                className="block bg-bg-card rounded-lg border border-amber-500/20 hover:border-amber-500/40 transition-colors p-3 focus-ring"
              >
                <p className="text-sm font-medium text-text-heading break-words">{q.question}</p>
                <div className="mt-1.5 flex items-center gap-3 text-xs text-text-muted flex-wrap">
                  <span className="inline-flex items-center gap-1">
                    <User className="w-3 h-3" aria-hidden="true" />
                    {q.askedBy}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Clock className="w-3 h-3" aria-hidden="true" />
                    {timeAgoShort(q.createdAt)}
                  </span>
                  {q.reason && (
                    <span className="text-text-muted/80 truncate hidden md:inline">· {q.reason}</span>
                  )}
                </div>
              </Link>
            ))}
            {pendingQs.length > 3 && (
              <p className="text-xs text-text-muted text-center pt-1">
                외 {pendingQs.length - 3}건…
              </p>
            )}
          </div>
        </section>
      )}

      {/* 최근 회의 + AI 비용 — 2열 그리드 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* 최근 회의 */}
        <section className="bg-bg-card rounded-xl border border-border p-4 md:p-5">
          <div className="flex items-center justify-between mb-4 gap-2">
            <h2 className="text-base md:text-lg font-semibold text-text-heading flex items-center gap-2 min-w-0">
              <Mic className="w-4 h-4 text-amber-600 flex-shrink-0" aria-hidden="true" />
              <span className="truncate">최근 회의</span>
            </h2>
            <Link href="/meetings" className="text-sm text-primary hover:underline focus-ring rounded flex-shrink-0">모두 보기 →</Link>
          </div>
          {meetings === null ? (
            // 로딩 중 — shimmer placeholder (위젯 단위)
            <div className="space-y-3">
              {[0, 1, 2].map(i => (
                <div key={i} className="p-3 rounded-lg bg-bg-input/40 skeleton-shimmer h-16" />
              ))}
            </div>
          ) : meetings.length === 0 ? (
            <p className="text-text-muted text-base py-8 text-center">아직 회의 기록이 없습니다</p>
          ) : (
            <div className="space-y-3">
              {meetings.map((m) => (
                <div key={m.id} className="p-3 rounded-lg bg-bg-input hover:bg-bg-hover/30 transition-colors">
                  <p className="text-sm md:text-base font-medium text-text-heading">{m.title}</p>
                  {m.summary && (
                    <p className="text-sm text-text-muted mt-1 line-clamp-2">{m.summary}</p>
                  )}
                  <div className="flex items-center gap-3 mt-2 flex-wrap">
                    {m.actionItems.length > 0 && (
                      <span className="text-xs text-amber-600">{m.actionItems.length} 액션아이템</span>
                    )}
                    <span className="text-xs text-text-muted">
                      {new Date(m.createdAt).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* AI API 비용 */}
        <section className="bg-bg-card rounded-xl border border-border p-4 md:p-5">
          <div className="flex items-center justify-between mb-4 gap-2">
            <h2 className="text-base md:text-lg font-semibold text-text-heading flex items-center gap-2 min-w-0">
              <DollarSign className="w-4 h-4 text-green-400 flex-shrink-0" aria-hidden="true" />
              <span className="truncate">AI API 비용</span>
            </h2>
            <span className="text-xs text-text-muted flex-shrink-0">최근 30일</span>
          </div>
          {costError ? (
            <p className="text-text-muted text-base py-8 text-center">사용 후 비용 데이터가 표시됩니다</p>
          ) : !costData ? (
            // 로딩 중 — 위젯 단위 shimmer
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-bg-input/40 rounded-lg p-3 skeleton-shimmer h-16" />
                <div className="bg-bg-input/40 rounded-lg p-3 skeleton-shimmer h-16" />
              </div>
              <div className="bg-bg-input/40 rounded-lg skeleton-shimmer h-24" />
            </div>
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
                        'claude-opus': 'Claude Opus',
                        'openai-embedding': 'OpenAI Embedding',
                        'openai-realtime': 'OpenAI Realtime',
                        'openai-whisper': 'Whisper STT',
                      };
                      const color: Record<string, string> = {
                        'gemini-flash': 'bg-blue-500',
                        'claude-sonnet': 'bg-orange-500',
                        'claude-opus': 'bg-gray-600',
                        'openai-embedding': 'bg-green-500',
                        'openai-realtime': 'bg-purple-500',
                        'openai-whisper': 'bg-yellow-500',
                      };
                      return (
                        <div key={service}>
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-text-main">{label[service] || service}</span>
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
        </section>
      </div>
    </div>
  );
}

// ── 헬퍼 ──────────────────────────────────────────
function timeAgoShort(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.max(0, Math.floor(diff / 60000));
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}일 전`;
  return new Date(iso).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
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

