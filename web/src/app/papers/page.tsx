'use client';

import { useState, useEffect } from 'react';
import { getPaperAlerts, savePaperAlert, runPaperCrawl, getPaperAlertResults, markPaperRead, type PaperAlertSetting, type PaperAlertResult } from '@/lib/api';

const STAR_LABELS: Record<number, { label: string; color: string; bg: string }> = {
  3: { label: '★★★ 직접 관련', color: 'text-yellow-400', bg: 'bg-yellow-500/10' },
  2: { label: '★★ 높은 관련', color: 'text-orange-400', bg: 'bg-orange-500/10' },
  1: { label: '★ 참고', color: 'text-gray-400', bg: 'bg-gray-500/10' },
};

export default function PapersPage() {
  const [alerts, setAlerts] = useState<PaperAlertSetting[]>([]);
  const [availableJournals, setAvailableJournals] = useState<string[]>([]);
  const [journalCategories, setJournalCategories] = useState<Record<string, string[]>>({});
  const [results, setResults] = useState<PaperAlertResult[]>([]);
  const [grouped, setGrouped] = useState<Record<string, PaperAlertResult[]>>({});
  const [unreadCount, setUnreadCount] = useState(0);
  const [keywords, setKeywords] = useState('');
  const [selectedJournals, setSelectedJournals] = useState<string[]>([]);
  const [crawling, setCrawling] = useState(false);
  const [crawlResult, setCrawlResult] = useState<any>(null);
  const [tab, setTab] = useState<'results' | 'settings'>('results');
  const [filterStars, setFilterStars] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    loadAlerts();
    loadResults();
  }, []);

  async function loadAlerts() {
    try {
      const data = await getPaperAlerts();
      const alertList = data.alerts || data.data || [];
      setAlerts(alertList);
      setAvailableJournals(data.availableJournals || []);
      setJournalCategories((data as any).journalCategories || {});
      if (alertList.length > 0) {
        setKeywords(alertList[0].keywords.join(', '));
        setSelectedJournals(alertList[0].journals);
      }
    } catch (err: any) {
      if (!err.message?.includes('404')) setError(err.message);
    }
  }

  async function loadResults() {
    try {
      const data = await getPaperAlertResults();
      setResults(data.results || data.data || []);
      setUnreadCount(data.unreadCount || 0);
      setGrouped((data as any).grouped || {});
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
    setUnreadCount(prev => Math.max(0, prev - 1));
  }

  const filteredResults = filterStars > 0
    ? results.filter(r => (r as any).stars >= filterStars)
    : results;

  const themeNames = Object.keys(grouped).filter(k => k !== '기타');

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">📚 연구동향 모니터링</h1>
          <p className="text-text-muted text-sm mt-1">선택한 저널에서 연구 테마 관련 논문을 자동 수집·평가·요약합니다</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setTab(tab === 'results' ? 'settings' : 'results')} className="px-4 py-2 bg-bg-card text-text-muted rounded-lg text-sm hover:text-white border border-bg-input/50">
            {tab === 'results' ? '⚙️ 설정' : '📋 결과'}
          </button>
          <button onClick={handleCrawl} disabled={crawling} className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium disabled:opacity-50">
            {crawling ? '수집 중...' : '🔄 지금 수집'}
          </button>
        </div>
      </div>

      {error && <div className="bg-red-500/10 text-red-400 px-4 py-3 rounded-lg text-sm">{error}</div>}
      {crawlResult && (
        <div className="bg-green-500/10 text-green-400 px-4 py-3 rounded-lg text-sm">
          수집 완료! {crawlResult.totalFetched}편 중 {crawlResult.matched}편 관련
          {crawlResult.breakdown && (
            <span className="ml-2">
              (★★★ {crawlResult.breakdown.threeStars} / ★★ {crawlResult.breakdown.twoStars} / ★ {crawlResult.breakdown.oneStar})
            </span>
          )}
          → {crawlResult.newSaved}편 신규
        </div>
      )}

      {tab === 'settings' ? (
        <div className="space-y-6">
          <div className="bg-bg-card rounded-xl border border-bg-input/50 p-6 space-y-4">
            <h3 className="text-white font-semibold">연구 키워드</h3>
            <p className="text-xs text-text-muted">연구실 프로필의 테마 키워드가 자동으로 적용됩니다. 추가 키워드를 입력할 수 있습니다.</p>
            <input
              value={keywords}
              onChange={e => setKeywords(e.target.value)}
              placeholder="예: biosensor, flexible electronics, hydrogel, liquid metal"
              className="w-full bg-bg-input text-white px-4 py-3 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>

          <div className="bg-bg-card rounded-xl border border-bg-input/50 p-6 space-y-4">
            <h3 className="text-white font-semibold">모니터링 저널 선택</h3>
            <p className="text-xs text-text-muted">관심 있는 저널만 선택하세요. 미선택시 전체 저널을 모니터링합니다.</p>

            <div className="flex gap-2 mb-3">
              <button onClick={() => setSelectedJournals(availableJournals)} className="text-xs text-primary hover:underline">전체 선택</button>
              <button onClick={() => setSelectedJournals([])} className="text-xs text-text-muted hover:text-white">전체 해제</button>
            </div>

            {Object.keys(journalCategories).length > 0 ? (
              Object.entries(journalCategories).map(([category, journals]) => (
                <div key={category} className="mb-4">
                  <p className="text-xs font-medium text-primary mb-2">{category}</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {journals.map(j => (
                      <label key={j} className="flex items-center gap-2 text-sm text-text-muted cursor-pointer hover:text-white">
                        <input
                          type="checkbox"
                          checked={selectedJournals.includes(j)}
                          onChange={e => {
                            if (e.target.checked) setSelectedJournals(prev => [...prev, j]);
                            else setSelectedJournals(prev => prev.filter(x => x !== j));
                          }}
                          className="rounded accent-primary"
                        />
                        {j}
                      </label>
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <div className="grid grid-cols-2 gap-1.5">
                {availableJournals.map(j => (
                  <label key={j} className="flex items-center gap-2 text-sm text-text-muted cursor-pointer hover:text-white">
                    <input
                      type="checkbox"
                      checked={selectedJournals.includes(j)}
                      onChange={e => {
                        if (e.target.checked) setSelectedJournals(prev => [...prev, j]);
                        else setSelectedJournals(prev => prev.filter(x => x !== j));
                      }}
                      className="rounded accent-primary"
                    />
                    {j}
                  </label>
                ))}
              </div>
            )}
          </div>

          <button onClick={handleSaveAlert} className="w-full py-3 bg-primary text-white rounded-lg text-sm font-medium">
            설정 저장
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Filter bar */}
          <div className="flex items-center gap-3">
            {unreadCount > 0 && (
              <span className="text-primary text-sm font-medium">📬 미확인 {unreadCount}편</span>
            )}
            <div className="flex-1" />
            <div className="flex gap-1">
              {[0, 1, 2, 3].map(s => (
                <button
                  key={s}
                  onClick={() => setFilterStars(s)}
                  className={`px-3 py-1 rounded-full text-xs ${filterStars === s ? 'bg-primary text-white' : 'bg-bg-card text-text-muted border border-bg-input/50 hover:text-white'}`}
                >
                  {s === 0 ? '전체' : '★'.repeat(s) + ' 이상'}
                </button>
              ))}
            </div>
          </div>

          {/* Theme tabs */}
          {themeNames.length > 0 && (
            <div className="flex gap-2 overflow-x-auto pb-2">
              {themeNames.map(theme => (
                <span key={theme} className="px-3 py-1 bg-bg-card border border-bg-input/50 rounded-full text-xs text-text-muted whitespace-nowrap">
                  {theme} ({grouped[theme]?.length || 0})
                </span>
              ))}
            </div>
          )}

          {/* Results */}
          {filteredResults.length === 0 ? (
            <div className="bg-bg-card rounded-xl border border-bg-input/50 p-12 text-center">
              <p className="text-4xl mb-4">📚</p>
              <p className="text-white font-medium">수집된 논문이 없습니다</p>
              <p className="text-text-muted text-sm mt-2">설정에서 저널과 키워드를 등록하고 수집을 실행해보세요</p>
            </div>
          ) : (
            filteredResults.map(paper => {
              const starInfo = STAR_LABELS[(paper as any).stars] || STAR_LABELS[1];
              const paperThemes = ((paper as any).themes as string[]) || [];
              return (
                <div key={paper.id} className={`bg-bg-card rounded-xl border border-bg-input/50 p-5 ${!paper.read ? 'border-l-4 border-l-primary' : ''}`}>
                  <div className="flex justify-between items-start gap-3">
                    <div className="flex-1 min-w-0">
                      {/* Star rating + themes */}
                      <div className="flex items-center gap-2 mb-2">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${starInfo.bg} ${starInfo.color}`}>
                          {starInfo.label}
                        </span>
                        {paperThemes.map(t => (
                          <span key={t} className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                            {t}
                          </span>
                        ))}
                      </div>

                      {/* Title */}
                      <h3 className="text-white font-medium text-sm leading-snug">{paper.title}</h3>

                      {/* Meta */}
                      <p className="text-text-muted text-xs mt-1">
                        {paper.journal}
                        {paper.authors && <span> · {paper.authors.slice(0, 80)}</span>}
                        {paper.publishedAt && <span> · {new Date(paper.publishedAt).toLocaleDateString('ko-KR')}</span>}
                      </p>

                      {/* AI Summary */}
                      {paper.aiSummary && (
                        <div className="mt-2 bg-bg/50 rounded-lg p-3 text-xs text-text-muted leading-relaxed">
                          {paper.aiSummary}
                        </div>
                      )}
                    </div>

                    <div className="flex flex-col gap-2 flex-shrink-0">
                      {paper.url && (
                        <a href={paper.url} target="_blank" rel="noopener" className="px-3 py-1.5 bg-bg-input text-text-muted rounded-lg text-xs hover:text-white text-center">
                          🔗 원문
                        </a>
                      )}
                      {(paper as any).doi && (
                        <a href={`https://doi.org/${(paper as any).doi}`} target="_blank" rel="noopener" className="px-3 py-1.5 bg-bg-input text-text-muted rounded-lg text-xs hover:text-white text-center">
                          DOI
                        </a>
                      )}
                      {!paper.read && (
                        <button onClick={() => handleMarkRead(paper.id)} className="px-3 py-1.5 bg-primary/20 text-primary rounded-lg text-xs">
                          확인
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
