'use client';

import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  getEmailStatus,
  getNarrativeBriefing,
  getEmailBriefingHistory,
  getEmailAuthUrl,
  initEmailProfile,
  EmailBriefingHistoryEntry,
} from '@/lib/api';

export default function EmailPage() {
  const [connected, setConnected] = useState(false);
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [emailCount, setEmailCount] = useState(0);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
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
          try { await initEmailProfile(); } catch {}
          await loadBriefing();
        }
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  async function loadBriefing() {
    setBriefingLoading(true);
    setError(null);
    try {
      const [briefingRes, historyRes] = await Promise.all([
        getNarrativeBriefing(30),
        getEmailBriefingHistory(30, 20),
      ]);
      setMarkdown(briefingRes.markdown);
      setEmailCount(briefingRes.emailCount);
      setGeneratedAt(briefingRes.generatedAt);
      setHistory(historyRes.data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBriefingLoading(false);
    }
  }

  const handleConnect = async () => {
    try {
      const res = await getEmailAuthUrl();
      window.location.href = res.url;
    } catch (err: any) {
      setError(err.message);
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
        <p className="text-text-muted mt-1 mb-8">AI가 이메일을 분석하여 서사형 브리핑 문서를 작성합니다</p>
        <div className="bg-bg-card rounded-xl border border-bg-input/50 p-12 text-center">
          <span className="text-6xl block mb-4">✉️</span>
          <h3 className="text-xl font-semibold text-white mb-2">Gmail 연동이 필요합니다</h3>
          <p className="text-text-muted mb-6 max-w-md mx-auto">
            Gmail을 연동하면 AI가 매일 받은 이메일을 기관별로 분석하고,
            맥락을 파악하여 서사형 브리핑 문서를 작성합니다.
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
            {emailCount > 0
              ? `${emailCount}개 이메일 · AI 서사형 분석`
              : '새 이메일을 확인하세요'}
            {generatedAt && (
              <span className="ml-2 text-xs">
                · {new Date(generatedAt).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 생성
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs bg-green-500/10 text-green-400">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            Gmail 연동됨
          </span>
          <button
            onClick={loadBriefing}
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

      {/* Narrative Briefing */}
      {briefingLoading ? (
        <div className="text-center py-16">
          <div className="animate-spin w-10 h-10 border-2 border-primary border-t-transparent rounded-full mx-auto mb-4" />
          <p className="text-white font-medium">AI가 이메일을 분석하고 있습니다...</p>
          <p className="text-xs text-text-muted mt-2">Claude Sonnet이 전체 이메일을 읽고 서사형 브리핑 문서를 작성 중 (30초~1분)</p>
        </div>
      ) : markdown ? (
        <div className="bg-bg-card rounded-xl border border-bg-input/50 p-6 md:p-8">
          <article className="prose prose-invert prose-sm max-w-none
            prose-headings:text-white prose-headings:font-bold
            prose-h1:text-xl prose-h1:border-b prose-h1:border-bg-input/50 prose-h1:pb-3 prose-h1:mb-4
            prose-h2:text-lg prose-h2:mt-6 prose-h2:mb-3
            prose-h3:text-base prose-h3:mt-4 prose-h3:mb-2
            prose-p:text-text-main prose-p:leading-relaxed
            prose-strong:text-white
            prose-a:text-primary prose-a:no-underline hover:prose-a:underline
            prose-blockquote:border-primary/50 prose-blockquote:bg-bg-input/20 prose-blockquote:rounded-r-lg prose-blockquote:py-1 prose-blockquote:text-text-muted
            prose-ul:text-text-main prose-ol:text-text-main
            prose-li:marker:text-primary
            prose-code:text-primary prose-code:bg-bg-input/50 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded
            prose-hr:border-bg-input/50
            prose-table:text-sm
            prose-th:text-white prose-th:bg-bg-input/30 prose-th:px-3 prose-th:py-2
            prose-td:text-text-main prose-td:px-3 prose-td:py-2 prose-td:border-bg-input/30
          ">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {markdown}
            </ReactMarkdown>
          </article>
        </div>
      ) : (
        <div className="text-center py-12 text-text-muted">새 이메일이 없습니다.</div>
      )}

      {/* Briefing History */}
      {history.length > 0 && (
        <div className="space-y-3 pt-4 border-t border-bg-input/30">
          <h3 className="text-lg font-semibold text-white">이전 브리핑</h3>
          {history.map((entry) => {
            const isNarrative = entry.meta?.total === undefined;
            return (
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
                  <div className="px-4 pb-4 border-t border-bg-input/30 pt-3">
                    {entry.briefings.map((item, i) => (
                      <div key={i} className="bg-bg-input/30 rounded-lg p-3 mb-2">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs text-text-muted">{item.senderName || item.sender}</span>
                        </div>
                        <p className="text-sm font-medium text-white">{item.subject}</p>
                        <p className="text-xs text-text-muted mt-1">{item.summary}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
