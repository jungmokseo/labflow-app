'use client';

import { useEffect, useState } from 'react';
import {
  getEmailStatus,
  getEmailBriefing,
  getEmailBriefingHistory,
  getEmailAuthUrl,
  initEmailProfile,
  EmailBriefingItem,
  EmailBriefingHistoryEntry,
} from '@/lib/api';

const CATEGORY_STYLES: Record<string, string> = {
  urgent: 'bg-red-500/20 text-red-400 border-red-500/30',
  'action-needed': 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  schedule: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  info: 'bg-green-500/20 text-green-400 border-green-500/30',
  ads: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
};

const CATEGORY_LABELS: Record<string, string> = {
  urgent: '⚠️ 긴급',
  'action-needed': '📝 대응필요',
  schedule: '📅 일정',
  info: '📰 정보성',
  ads: '🛒 광고',
};

const CATEGORY_ORDER = ['urgent', 'action-needed', 'schedule', 'info', 'ads'];

function BriefingItems({ items }: { items: EmailBriefingItem[] }) {
  // Group by institution
  const grouped = items.reduce<Record<string, EmailBriefingItem[]>>((acc, item) => {
    const group = item.group || '개인';
    if (!acc[group]) acc[group] = [];
    acc[group].push(item);
    return acc;
  }, {});

  // Sort items within each group by category order
  Object.values(grouped).forEach(groupItems => {
    groupItems.sort((a, b) => {
      const aIdx = CATEGORY_ORDER.indexOf(a.category);
      const bIdx = CATEGORY_ORDER.indexOf(b.category);
      return aIdx - bIdx;
    });
  });

  return (
    <>
      {Object.entries(grouped).map(([group, groupItems]) => (
        <div key={group} className="space-y-2">
          <h4 className="text-sm font-semibold text-white flex items-center gap-2">
            {groupItems[0]?.groupEmoji} {group}
            <span className="text-text-muted font-normal">({groupItems.length}건)</span>
          </h4>
          {groupItems.map((item, i) => (
            <div key={i} className="bg-bg-card rounded-lg border border-bg-input/50 p-3 hover:border-primary/30 transition-colors">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-[10px] px-2 py-0.5 rounded-full border ${CATEGORY_STYLES[item.category] || 'bg-gray-500/20 text-gray-400'}`}>
                      {CATEGORY_LABELS[item.category] || item.category}
                    </span>
                    <span className="text-xs text-text-muted">{item.senderName || item.sender}</span>
                  </div>
                  <p className="text-sm font-medium text-white">{item.subject}</p>
                  <p className="text-xs text-text-muted mt-1">{item.summary}</p>
                </div>
                <div className="text-right flex-shrink-0">
                  <span className="text-[10px] text-text-muted whitespace-nowrap block">
                    {item.dateLocal || new Date(item.date).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })}
                  </span>
                  {item.dateSender && (
                    <span className="text-[10px] text-blue-400 whitespace-nowrap block">
                      {item.dateSenderLabel} {item.dateSender}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

function BriefingSummaryBar({ items }: { items: EmailBriefingItem[] }) {
  const counts: Record<string, number> = {};
  items.forEach(item => {
    counts[item.category] = (counts[item.category] || 0) + 1;
  });
  return (
    <div className="flex items-center gap-3 text-xs text-text-muted">
      <span className="text-white font-medium">총 {items.length}건</span>
      {counts.urgent ? <span className="text-red-400">⚠️ {counts.urgent}</span> : null}
      {counts['action-needed'] ? <span className="text-orange-400">📝 {counts['action-needed']}</span> : null}
      {counts.schedule ? <span className="text-blue-400">📅 {counts.schedule}</span> : null}
      {counts.info ? <span className="text-green-400">📰 {counts.info}</span> : null}
      {counts.ads ? <span className="text-gray-400">🛒 {counts.ads}</span> : null}
    </div>
  );
}

export default function EmailPage() {
  const [connected, setConnected] = useState(false);
  const [briefing, setBriefing] = useState<EmailBriefingItem[]>([]);
  const [history, setHistory] = useState<EmailBriefingHistoryEntry[]>([]);
  const [expandedHistory, setExpandedHistory] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [briefingLoading, setBriefingLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const status = await getEmailStatus();
        setConnected(status.connected);
        if (status.connected) {
          // Initialize profile with default rules if not set
          try { await initEmailProfile(); } catch { /* ignore */ }

          setBriefingLoading(true);
          try {
            const [briefingRes, historyRes] = await Promise.all([
              getEmailBriefing(30),
              getEmailBriefingHistory(30, 20),
            ]);
            setBriefing(briefingRes.data);
            setHistory(historyRes.data);
          } catch (err: any) {
            setError(err.message);
          } finally {
            setBriefingLoading(false);
          }
        }
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const handleConnect = async () => {
    try {
      const res = await getEmailAuthUrl();
      window.location.href = res.url;
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleRefresh = async () => {
    setBriefingLoading(true);
    setError(null);
    try {
      const [briefingRes, historyRes] = await Promise.all([
        getEmailBriefing(30),
        getEmailBriefingHistory(30, 20),
      ]);
      setBriefing(briefingRes.data);
      setHistory(historyRes.data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBriefingLoading(false);
    }
  };

  const toggleHistory = (id: string) => {
    setExpandedHistory(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!connected) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <h2 className="text-2xl font-bold text-white">📧 이메일 브리핑</h2>
        <p className="text-text-muted mt-1 mb-8">AI가 이메일을 기관별·성격별로 분류하고 요약합니다</p>
        <div className="bg-bg-card rounded-xl border border-bg-input/50 p-12 text-center">
          <span className="text-6xl block mb-4">✉️</span>
          <h3 className="text-xl font-semibold text-white mb-2">Gmail 연동이 필요합니다</h3>
          <p className="text-text-muted mb-6 max-w-md mx-auto">
            Gmail을 연동하면 AI가 매일 받은 이메일을 기관별(🏫연세대/🏢링크솔루텍/👤개인)·
            성격별(⚠️긴급/📝대응필요/📅일정/📰정보성/🛒광고)로 분류하고 핵심 내용을 요약해 브리핑합니다.
          </p>
          <button onClick={handleConnect} className="px-6 py-3 bg-primary hover:bg-primary-hover text-white rounded-lg font-medium transition-colors">
            Gmail 연동하기
          </button>
          <p className="text-xs text-text-muted mt-4">OAuth 2.0을 통해 안전하게 연결됩니다.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white">📧 이메일 브리핑</h2>
          <p className="text-text-muted mt-1">
            {briefing.length > 0
              ? `${briefing.length}개의 이메일을 AI가 분석했습니다`
              : '새 이메일을 확인하세요'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs bg-green-500/10 text-green-400">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            Gmail 연동됨
          </span>
          <button
            onClick={handleRefresh}
            disabled={briefingLoading}
            className="px-4 py-2 bg-bg-input/50 hover:bg-bg-input text-white rounded-lg text-sm transition-colors disabled:opacity-50"
          >
            {briefingLoading ? '분석 중...' : '새로고침'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-red-400 text-sm">{error}</div>
      )}

      {/* Current Briefing */}
      {briefingLoading ? (
        <div className="text-center py-12">
          <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full mx-auto mb-4" />
          <p className="text-text-muted">AI가 이메일을 분석하고 있습니다...</p>
          <p className="text-xs text-text-muted mt-1">Claude Sonnet이 기관별·성격별 분류 중 (30초~1분)</p>
        </div>
      ) : briefing.length === 0 ? (
        <div className="text-center py-12 text-text-muted">새 이메일이 없습니다.</div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-white">최신 브리핑</h3>
            <BriefingSummaryBar items={briefing} />
          </div>
          <BriefingItems items={briefing} />
        </div>
      )}

      {/* Briefing History (collapsible toggles) */}
      {history.length > 0 && (
        <div className="space-y-3 pt-4 border-t border-bg-input/30">
          <h3 className="text-lg font-semibold text-white">이전 브리핑</h3>
          {history.map((entry) => (
            <div key={entry.id} className="bg-bg-card rounded-xl border border-bg-input/50 overflow-hidden">
              <button
                onClick={() => toggleHistory(entry.id)}
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-bg-input/20 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <span className="text-lg">{expandedHistory.has(entry.id) ? '▼' : '▶'}</span>
                  <div className="text-left">
                    <span className="text-sm font-medium text-white">{entry.title}</span>
                    <span className="text-xs text-text-muted ml-2">
                      {new Date(entry.time).toLocaleString('ko-KR', {
                        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                      })}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs text-text-muted">
                  {entry.meta?.categories?.urgent ? <span className="text-red-400">⚠️{entry.meta.categories.urgent}</span> : null}
                  {entry.meta?.categories?.['action-needed'] ? <span className="text-orange-400">📝{entry.meta.categories['action-needed']}</span> : null}
                  <span>{entry.meta?.total || entry.briefings?.length || 0}건</span>
                </div>
              </button>
              {expandedHistory.has(entry.id) && entry.briefings?.length > 0 && (
                <div className="px-4 pb-4 space-y-3 border-t border-bg-input/30">
                  <div className="pt-3">
                    <BriefingItems items={entry.briefings} />
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
