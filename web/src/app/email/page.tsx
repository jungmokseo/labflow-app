'use client';

import { useEffect, useState } from 'react';
import { getEmailStatus, getEmailBriefing, getEmailAuthUrl, EmailBriefingItem } from '@/lib/api';

const CATEGORY_STYLES: Record<string, string> = {
  '긴급': 'bg-red-500/20 text-red-400 border-red-500/30',
  '대응필요': 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  '일정': 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  '정보성': 'bg-green-500/20 text-green-400 border-green-500/30',
  '광고/뉴스레터': 'bg-gray-500/20 text-gray-400 border-gray-500/30',
};

export default function EmailPage() {
  const [connected, setConnected] = useState(false);
  const [briefing, setBriefing] = useState<EmailBriefingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [briefingLoading, setBriefingLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const status = await getEmailStatus();
        setConnected(status.connected);
        if (status.connected) {
          setBriefingLoading(true);
          try {
            const res = await getEmailBriefing(15);
            setBriefing(res.data);
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
      window.open(res.url, '_blank');
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleRefresh = async () => {
    setBriefingLoading(true);
    setError(null);
    try {
      const res = await getEmailBriefing(15);
      setBriefing(res.data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBriefingLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  // 미연동 상태
  if (!connected) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <h2 className="text-2xl font-bold text-white">✉️ 이메일 브리핑</h2>
        <p className="text-text-muted mt-1 mb-8">AI가 이메일을 분류하고 요약합니다</p>

        <div className="bg-bg-card rounded-xl border border-bg-input/50 p-12 text-center">
          <span className="text-6xl block mb-4">✉️</span>
          <h3 className="text-xl font-semibold text-white mb-2">Gmail 연동이 필요합니다</h3>
          <p className="text-text-muted mb-6 max-w-md mx-auto">
            Gmail을 연동하면 AI가 매일 받은 이메일을 기관별·성격별로 분류하고,
            핵심 내용을 요약해 브리핑해 드립니다.
          </p>
          <button
            onClick={handleConnect}
            className="px-6 py-3 bg-primary hover:bg-primary-hover text-white rounded-lg font-medium transition-colors"
          >
            Gmail 연동하기
          </button>
          <p className="text-xs text-text-muted mt-4">
            OAuth 2.0을 통해 안전하게 연결됩니다. 비밀번호는 저장되지 않습니다.
          </p>
        </div>
      </div>
    );
  }

  // 그룹별 정리
  const grouped = briefing.reduce<Record<string, EmailBriefingItem[]>>((acc, item) => {
    const group = item.group || '기타';
    if (!acc[group]) acc[group] = [];
    acc[group].push(item);
    return acc;
  }, {});

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white">✉️ 이메일 브리핑</h2>
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
            {briefingLoading ? '로딩 중...' : '새로고침'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-red-400 text-sm">
          {error}
        </div>
      )}

      {briefingLoading ? (
        <div className="text-center py-12">
          <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full mx-auto mb-4" />
          <p className="text-text-muted">AI가 이메일을 분석하고 있습니다...</p>
          <p className="text-xs text-text-muted mt-1">Claude Sonnet이 분류 및 요약 중 (30초~1분 소요)</p>
        </div>
      ) : briefing.length === 0 ? (
        <div className="text-center py-12 text-text-muted">
          새 이메일이 없습니다.
        </div>
      ) : (
        Object.entries(grouped).map(([group, items]) => (
          <div key={group} className="space-y-3">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              {items[0]?.groupEmoji} {group}
              <span className="text-text-muted font-normal">({items.length})</span>
            </h3>
            {items.map((item, i) => (
              <div key={i} className="bg-bg-card rounded-xl border border-bg-input/50 p-4 hover:border-primary/30 transition-colors">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full border ${CATEGORY_STYLES[item.category] || 'bg-gray-500/20 text-gray-400'}`}>
                        {item.categoryEmoji} {item.category}
                      </span>
                      <span className="text-xs text-text-muted">{item.senderName || item.sender}</span>
                    </div>
                    <p className="text-sm font-medium text-white">{item.subject}</p>
                    <p className="text-xs text-text-muted mt-1">{item.summary}</p>
                  </div>
                  <span className="text-[10px] text-text-muted whitespace-nowrap">
                    {new Date(item.date).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}
