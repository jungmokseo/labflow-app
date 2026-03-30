'use client';

import { useState, useEffect } from 'react';
import { getPaperAlerts, savePaperAlert, runPaperCrawl, getPaperAlertResults, markPaperRead, type PaperAlertSetting, type PaperAlertResult } from '@/lib/api';

export default function PapersPage() {
  const [alerts, setAlerts] = useState<PaperAlertSetting[]>([]);
  const [availableJournals, setAvailableJournals] = useState<string[]>([]);
  const [results, setResults] = useState<PaperAlertResult[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [keywords, setKeywords] = useState('');
  const [selectedJournals, setSelectedJournals] = useState<string[]>([]);
  const [crawling, setCrawling] = useState(false);
  const [crawlResult, setCrawlResult] = useState<any>(null);
  const [tab, setTab] = useState<'results' | 'settings'>('results');
  const [error, setError] = useState('');

  useEffect(() => {
    loadAlerts();
    loadResults();
  }, []);

  async function loadAlerts() {
    try {
      const data = await getPaperAlerts();
      setAlerts(data.alerts || data.data || []);
      setAvailableJournals(data.availableJournals || []);
      const alerts = data.alerts || data.data || [];
      if (alerts.length > 0) {
        setKeywords(alerts[0].keywords.join(', '));
        setSelectedJournals(alerts[0].journals);
      }
    } catch (err: any) {
      if (!err.message.includes('404')) setError(err.message);
    }
  }

  async function loadResults() {
    try {
      const data = await getPaperAlertResults();
      setResults(data.results || data.data || []);
      setUnreadCount(data.unreadCount || 0);
    } catch {}
  }

  async function handleSaveAlert() {
    try {
      const kws = keywords.split(',').map(k => k.trim()).filter(Boolean);
      if (kws.length === 0) return;
      await savePaperAlert({ keywords: kws, journals: selectedJournals });
      await loadAlerts();
      setTab('results');
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleCrawl() {
    setCrawling(true);
    setCrawlResult(null);
    try {
      const result = await runPaperCrawl();
      setCrawlResult(result);
      await loadResults();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCrawling(false);
    }
  }

  async function handleMarkRead(id: string) {
    await markPaperRead(id);
    setResults(prev => prev.map(r => r.id === id ? { ...r, read: true } : r));
    setUnreadCount(prev => prev - 1);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">📚 논문 알림</h1>
          <p className="text-text-muted text-sm mt-1">관심 분야 저널 RSS에서 키워드 매칭 논문을 자동으로 수집합니다</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setTab(tab === 'results' ? 'settings' : 'results')} className="px-4 py-2 bg-bg-card text-text-muted rounded-lg text-sm hover:text-white">
            {tab === 'results' ? '⚙️ 설정' : '📋 결과'}
          </button>
          <button onClick={handleCrawl} disabled={crawling} className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium disabled:opacity-50">
            {crawling ? '크롤링 중...' : '🔄 지금 크롤링'}
          </button>
        </div>
      </div>

      {error && <div className="bg-red-500/10 text-red-400 px-4 py-3 rounded-lg text-sm">{error}</div>}
      {crawlResult && (
        <div className="bg-green-500/10 text-green-400 px-4 py-3 rounded-lg text-sm">
          크롤링 완료! 총 {crawlResult.totalFetched}편 수집 → {crawlResult.matched}편 매칭 → {crawlResult.newSaved}편 신규 저장
        </div>
      )}

      {tab === 'settings' ? (
        <div className="bg-bg-card rounded-xl p-6 space-y-6">
          <div>
            <label className="text-white text-sm font-medium block mb-2">연구 키워드 (쉼표로 구분)</label>
            <input
              value={keywords}
              onChange={e => setKeywords(e.target.value)}
              placeholder="예: biosensor, flexible electronics, hydrogel, liquid metal"
              className="w-full bg-bg-input text-white px-4 py-3 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
          <div>
            <label className="text-white text-sm font-medium block mb-2">모니터링 저널 (미선택시 전체)</label>
            <div className="grid grid-cols-2 gap-2">
              {availableJournals.map(j => (
                <label key={j} className="flex items-center gap-2 text-sm text-text-muted cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedJournals.includes(j)}
                    onChange={e => {
                      if (e.target.checked) setSelectedJournals(prev => [...prev, j]);
                      else setSelectedJournals(prev => prev.filter(x => x !== j));
                    }}
                    className="rounded"
                  />
                  {j}
                </label>
              ))}
            </div>
          </div>
          <button onClick={handleSaveAlert} className="px-6 py-3 bg-primary text-white rounded-lg text-sm font-medium">
            저장
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {unreadCount > 0 && (
            <p className="text-primary text-sm font-medium">📬 읽지 않은 논문 {unreadCount}편</p>
          )}
          {results.length === 0 ? (
            <div className="bg-bg-card rounded-xl p-12 text-center">
              <p className="text-4xl mb-4">📚</p>
              <p className="text-white font-medium">논문 알림이 없습니다</p>
              <p className="text-text-muted text-sm mt-2">설정에서 키워드를 등록하고 크롤링을 실행해보세요</p>
            </div>
          ) : (
            results.map(paper => (
              <div key={paper.id} className={`bg-bg-card rounded-xl p-5 ${!paper.read ? 'border-l-4 border-primary' : ''}`}>
                <div className="flex justify-between items-start">
                  <div className="flex-1">
                    <h3 className="text-white font-medium text-sm leading-snug">{paper.title}</h3>
                    <p className="text-text-muted text-xs mt-1">
                      {paper.journal} · {paper.authors?.slice(0, 60)} · 관련도: {((paper.relevance || 0) * 100).toFixed(0)}%
                    </p>
                    {paper.aiSummary && (
                      <p className="text-text-muted text-xs mt-2 bg-bg-input p-2 rounded">{paper.aiSummary}</p>
                    )}
                  </div>
                  <div className="flex gap-2 ml-3">
                    {paper.url && (
                      <a href={paper.url} target="_blank" rel="noopener" className="px-3 py-1 bg-bg-input text-text-muted rounded text-xs hover:text-white">
                        원문
                      </a>
                    )}
                    {!paper.read && (
                      <button onClick={() => handleMarkRead(paper.id)} className="px-3 py-1 bg-primary/20 text-primary rounded text-xs">
                        읽음
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
