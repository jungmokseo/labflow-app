'use client';

/**
 * 휴가 신청 페이지 — labflow-member 데이터 read-only.
 *
 * 학생이 BLISS Slack에서 /휴가 명령으로 등록한 휴가를 PI가 한 곳에서 확인.
 * 잔여 휴가 + 최근 신청 내역.
 */

import { useMemo, useState } from 'react';
import { getRecentVacations, getVacationBalances, type VacationRecentItem, type VacationBalanceItem } from '@/lib/api';
import { useApiData } from '@/lib/use-api';
import { Calendar, Clock, Loader2, User, AlertCircle } from 'lucide-react';

const TYPE_LABEL: Record<string, string> = {
  ANNUAL: '연차',
  SICK: '병가',
  SPECIAL: '특별',
  OFFICIAL: '공무',
};

const TYPE_COLOR: Record<string, string> = {
  ANNUAL: 'bg-blue-100 text-blue-700',
  SICK: 'bg-orange-100 text-orange-700',
  SPECIAL: 'bg-purple-100 text-purple-700',
  OFFICIAL: 'bg-gray-100 text-gray-700',
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
  const [tab, setTab] = useState<'recent' | 'balance'>('recent');

  const recent = useApiData<{ items: VacationRecentItem[] }>(
    'vacations:recent',
    () => getRecentVacations(100),
  );
  const balance = useApiData<{ year: number; items: VacationBalanceItem[] }>(
    'vacations:balance',
    () => getVacationBalances(),
  );

  const recentItems = recent.data?.items ?? [];
  const balanceItems = balance.data?.items ?? [];

  const sortedBalances = useMemo(
    () => [...balanceItems].sort((a, b) => b.usedDays - a.usedDays),
    [balanceItems],
  );

  return (
    <div className="min-h-full pb-20 md:pb-12">
      <div className="px-4 md:px-8 pt-4 md:pt-8 pb-4">
        <div className="flex items-center gap-2 md:gap-3 mb-1">
          <Calendar className="w-5 h-5 md:w-6 md:h-6 text-primary" />
          <h1 className="text-lg md:text-2xl font-bold text-text-heading">휴가 관리</h1>
        </div>
        <p className="text-xs md:text-sm text-text-muted">
          학생이 BLISS Slack /휴가로 등록한 신청 내역과 잔여 휴가 현황.
        </p>
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
              <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
                <AlertCircle className="w-4 h-4 inline mr-1" />
                불러오지 못했습니다
              </div>
            )}
            {!recent.isLoading && recentItems.length === 0 && (
              <div className="text-center py-12 text-text-muted text-sm">최근 휴가 신청이 없습니다.</div>
            )}
            {recentItems.map(v => (
              <article key={v.id} className="bg-bg-card border border-border rounded-lg p-3 md:p-4">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${TYPE_COLOR[v.type] || 'bg-gray-100 text-gray-700'}`}>
                    {TYPE_LABEL[v.type] || v.type}
                  </span>
                  <span className="text-sm font-semibold text-text-heading">{v.memberName}</span>
                  <span className="text-xs text-text-muted">· {fmtRange(v.startDate, v.endDate)}</span>
                  <span className="text-xs text-text-muted">· {v.days}일</span>
                  {v.status === 'CANCELLED' && (
                    <span className="px-1.5 py-0.5 rounded bg-red-50 text-red-600 text-[10px]">취소</span>
                  )}
                  <span className="ml-auto text-[10px] text-text-muted/70">{timeAgo(v.createdAt)}</span>
                </div>
                {v.reason && (
                  <p className="mt-1.5 text-xs text-text-muted bg-bg-input rounded px-2 py-1.5 border border-border break-words">
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
              <div className="text-center py-12 text-text-muted text-sm">잔여 휴가 정보가 없습니다.</div>
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
                      <span className={`ml-2 font-medium ${tight ? 'text-red-600' : 'text-text-heading'}`}>
                        잔여 {m.remainingDays}일
                      </span>
                    </span>
                  </div>
                  <div className="h-2 bg-bg-input rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${tight ? 'bg-red-500' : 'bg-primary'}`}
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
