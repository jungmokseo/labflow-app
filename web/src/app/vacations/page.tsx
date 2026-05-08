'use client';

/**
 * 휴가 신청 페이지 — labflow-member 데이터 read-only.
 *
 * 학생이 BLISS Slack에서 /휴가 명령으로 등록한 휴가를 PI가 한 곳에서 확인.
 * 잔여 휴가 + 최근 신청 내역.
 */

import { useMemo, useState } from 'react';
import { getRecentVacations, getVacationBalances, syncVacationsToCalendar, type VacationRecentItem, type VacationBalanceItem } from '@/lib/api';
import { useApiData } from '@/lib/use-api';
import { useToast } from '@/components/Toast';
import { Calendar, Clock, Loader2, User, AlertCircle, RefreshCw, Check } from 'lucide-react';

const TYPE_LABEL: Record<string, string> = {
  ANNUAL: '연차',
  SICK: '병가',
  SPECIAL: '특별',
  OFFICIAL: '공무',
};

const TYPE_COLOR: Record<string, string> = {
  ANNUAL: 'bg-blue-500/10 text-blue-500',
  SICK: 'bg-orange-500/10 text-orange-500',
  SPECIAL: 'bg-purple-500/10 text-purple-500',
  OFFICIAL: 'bg-bg-input text-text-muted',
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

function fmtRange(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  if (s.toDateString() === e.toDateString()) return fmtDate(start);
  return `${fmtDate(start)} ~ ${fmtDate(end)}`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const day = Math.floor(diff / 86400000);
  if (day === 0) return '오늘';
  if (day === 1) return '어제';
  if (day < 7) return `${day}일 전`;
  return new Date(iso).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

export default function VacationsPage() {
  const { toast } = useToast();
  const [tab, setTab] = useState<'recent' | 'balance'>('recent');
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<{
    calendarName?: string;
    calendarSource: string;
    created: number;
    cancelled: number;
  } | null>(null);

  const handleCalendarSync = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const r = await syncVacationsToCalendar();
      const calLabel = r.calendarName || r.calendarId || 'primary';
      setLastSync({ calendarName: r.calendarName, calendarSource: r.calendarSource, created: r.created, cancelled: r.cancelled });
      if (r.calendarSource === 'primary' && !r.calendarName) {
        toast(
          `⚠️ 'BLISS LAB' 캘린더 매칭 실패 → primary에 등록. Gmail 재연동 필요 (calendar.readonly scope)`,
          'error',
        );
      } else {
        toast(
          `'${calLabel}'에 등록: 신규 ${r.created}건${r.cancelled > 0 ? ` · 취소 ${r.cancelled}건` : ''}`,
          'success',
        );
      }
    } catch (e: any) {
      toast(`동기화 실패: ${e.message?.slice(0, 100)}`, 'error');
    } finally {
      setSyncing(false);
    }
  };

  // 자동 새로고침 — 학생이 BLISS Slack /휴가 명령으로 등록한 새 휴가를 PI가 즉시 볼 수 있도록.
  // 5분 폴링 (vacations는 자주 바뀌지 않음).
  const recent = useApiData<{ items: VacationRecentItem[] }>(
    'vacations:recent',
    () => getRecentVacations(100),
    { refreshInterval: 5 * 60_000 },
  );
  const balance = useApiData<{ year: number; items: VacationBalanceItem[] }>(
    'vacations:balance',
    () => getVacationBalances(),
    { refreshInterval: 5 * 60_000 },
  );

  const recentItems = recent.data?.items ?? [];

  const sortedBalances = useMemo(
    () => [...(balance.data?.items ?? [])].sort((a, b) => b.usedDays - a.usedDays),
    [balance.data?.items],
  );

  return (
    <div className="min-h-full pb-20 md:pb-12">
      <div className="px-4 md:px-8 pt-4 md:pt-8 pb-4">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <span className="w-1 h-9 md:h-11 bg-primary rounded-full flex-shrink-0" />
            <div className="min-w-0">
              <h1 className="text-2xl md:text-3xl font-bold text-text-heading tracking-tight flex items-center gap-2 leading-tight">
                <Calendar className="w-6 h-6 text-primary flex-shrink-0" /> 휴가 관리
              </h1>
              <p className="text-sm md:text-base text-text-muted mt-1">
                학생이 BLISS Slack /휴가로 등록한 신청 내역과 잔여 휴가 현황.
              </p>
            </div>
          </div>
          <button
            onClick={handleCalendarSync}
            disabled={syncing}
            className="inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-bg-card border border-border rounded-lg text-sm hover:text-text-heading disabled:opacity-50 self-start sm:self-auto whitespace-nowrap"
            title="휴가 → BLISS Lab Google Calendar 즉시 등록"
          >
            <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? '동기화 중…' : '캘린더 동기화'}
          </button>
        </div>
        {lastSync && (
          <div className="mt-3 px-3 py-2 bg-emerald-500/10 dark:bg-emerald-500/15 border border-emerald-500/30 rounded-lg text-xs text-emerald-900 dark:text-emerald-200 flex items-center gap-2">
            <Check className="w-3.5 h-3.5" />
            <span>
              <strong>{lastSync.calendarName || '(이름 미상)'}</strong>에 매칭됨
              ({lastSync.calendarSource === 'auto' ? '자동' : lastSync.calendarSource === 'env' ? 'env' : 'primary'})
              {' · '}이번 동기화: 신규 {lastSync.created}건{lastSync.cancelled > 0 ? ` / 취소 ${lastSync.cancelled}건` : ''}
            </span>
          </div>
        )}
      </div>

      <div className="px-4 md:px-8 pt-1 pb-2 flex gap-2 overflow-x-auto">
        <button
          onClick={() => setTab('recent')}
          className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5 whitespace-nowrap ${
            tab === 'recent' ? 'bg-primary text-white' : 'bg-bg-card text-text-muted hover:text-text-heading hover:bg-bg-hover border border-border'
          }`}
        >
          <Clock className="w-4 h-4" />
          최근 신청
          <span className={`ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
            tab === 'recent' ? 'bg-white/20 text-white' : 'bg-primary-light text-primary'
          }`}>
            {recentItems.length}
          </span>
        </button>
        <button
          onClick={() => setTab('balance')}
          className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5 whitespace-nowrap ${
            tab === 'balance' ? 'bg-primary text-white' : 'bg-bg-card text-text-muted hover:text-text-heading hover:bg-bg-hover border border-border'
          }`}
        >
          <User className="w-4 h-4" />
          잔여 현황
          {balance.data && (
            <span className={`ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
              tab === 'balance' ? 'bg-white/20 text-white' : 'bg-bg-input text-text-muted'
            }`}>
              {balance.data.year}
            </span>
          )}
        </button>
      </div>

      <div className="px-4 md:px-8 pt-2">
        {tab === 'recent' && (
          <div className="space-y-2">
            {recent.isLoading && (
              <div className="flex items-center justify-center py-12 text-text-muted">
                <Loader2 className="w-5 h-5 animate-spin mr-2" />
                불러오는 중...
              </div>
            )}
            {recent.error && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 text-sm text-red-500 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                불러오지 못했습니다
              </div>
            )}
            {!recent.isLoading && !recent.error && recentItems.length === 0 && (
              <div className="bg-bg-card border border-border rounded-lg p-8 md:p-10 text-center">
                <Clock className="w-10 h-10 text-primary/30 mx-auto mb-3" />
                <p className="text-sm text-text-muted">최근 휴가 신청이 없습니다.</p>
              </div>
            )}
            {recentItems.map(v => (
              <article key={v.id} className="bg-bg-card border border-border rounded-lg p-3 md:p-4">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${TYPE_COLOR[v.type] || 'bg-bg-input text-text-muted'}`}>
                    {TYPE_LABEL[v.type] || v.type}
                  </span>
                  <span className="text-sm font-semibold text-text-heading">{v.memberName}</span>
                  <span className="text-xs text-text-muted">· {fmtRange(v.startDate, v.endDate)}</span>
                  <span className="text-xs text-text-muted">· {v.days}일</span>
                  {v.status === 'CANCELLED' && (
                    <span className="px-1.5 py-0.5 rounded bg-red-500/10 text-red-500 text-[10px] font-medium">취소</span>
                  )}
                  <span className="ml-auto text-[10px] text-text-muted/70">{timeAgo(v.createdAt)}</span>
                </div>
                {v.reason && (
                  <p className="mt-2 text-xs text-text-muted bg-bg-input rounded px-2.5 py-1.5 border border-border break-words leading-relaxed">
                    {v.reason}
                  </p>
                )}
              </article>
            ))}
          </div>
        )}

        {tab === 'balance' && (
          <div className="space-y-2">
            {balance.isLoading && (
              <div className="flex items-center justify-center py-12 text-text-muted">
                <Loader2 className="w-5 h-5 animate-spin mr-2" />
                불러오는 중...
              </div>
            )}
            {!balance.isLoading && sortedBalances.length === 0 && (
              <div className="bg-bg-card border border-border rounded-lg p-8 md:p-10 text-center">
                <User className="w-10 h-10 text-primary/30 mx-auto mb-3" />
                <p className="text-sm text-text-muted">잔여 휴가 정보가 없습니다.</p>
              </div>
            )}
            {sortedBalances.map(m => {
              const pct = m.totalDays > 0 ? Math.min(100, (m.usedDays / m.totalDays) * 100) : 0;
              const tight = m.remainingDays <= 2;
              return (
                <article key={m.memberId} className="bg-bg-card border border-border rounded-lg p-3 md:p-4">
                  <div className="flex items-center gap-2 flex-wrap mb-2">
                    <span className="text-sm font-semibold text-text-heading">{m.name}</span>
                    {m.role === 'PI' && (
                      <span className="px-1.5 py-0.5 rounded bg-primary-light text-primary text-[10px] font-medium">PI</span>
                    )}
                    <span className="ml-auto text-xs text-text-muted">
                      {m.usedDays}/{m.totalDays}일
                      <span className={`ml-2 font-medium ${tight ? 'text-red-500' : 'text-text-heading'}`}>
                        잔여 {m.remainingDays}일
                      </span>
                    </span>
                  </div>
                  <div className="h-2 bg-bg-input rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${tight ? 'bg-red-500' : 'bg-primary'}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
