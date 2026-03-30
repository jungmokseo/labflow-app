'use client';

import { useState, useEffect } from 'react';
import {
  getPaperAlerts, savePaperAlert, runPaperCrawl, getPaperAlertResults, markPaperRead,
  getJournalFields, searchJournals, addCustomJournal,
  type PaperAlertSetting, type PaperAlertResult,
} from '@/lib/api';

const STAR_LABELS: Record<number, { label: string; color: string; bg: string }> = {
  3: { label: '★★★ 직접 관련', color: 'text-yellow-400', bg: 'bg-yellow-500/10' },
  2: { label: '★★ 높은 관련', color: 'text-orange-400', bg: 'bg-orange-500/10' },
  1: { label: '★ 참고', color: 'text-gray-400', bg: 'bg-gray-500/10' },
};

export default function PapersPage() {
  const [results, setResults] = useState<PaperAlertResult[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [keywords, setKeywords] = useState('');
  const [selectedJournals, setSelectedJournals] = useState<string[]>([]);
  const [customFeeds, setCustomFeeds] = useState<Array<{ name: string; rssUrl: string }>>([]);
  const [crawling, setCrawling] = useState(false);
  const [crawlResult, setCrawlResult] = useState<any>(null);
  const [tab, setTab] = useState<'results' | 'journals' | 'keywords'>('results');
  const [filterStars, setFilterStars] = useState(0);
  const [error, setError] = useState('');

  // Journal discovery
  const [fieldData, setFieldData] = useState<Record<string, Array<{ name: string; publisher: string }>>>({});
  const [allFields, setAllFields] = useState<string[]>([]);
  const [expandedField, setExpandedField] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [addingCustom, setAddingCustom] = useState(false);

  useEffect(() => {
    loadAlerts();
    loadResults();
    loadFields();
  }, []);

  async function loadAlerts() {
    try {
      const data = await getPaperAlerts();
      const alertList = data.alerts || data.data || [];
      if (alertList.length > 0) {
        setKeywords(alertList[0].keywords.join(', '));
        setSelectedJournals(alertList[0].journals);
        setCustomFeeds((alertList[0] as any).customFeeds || []);
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
    } catch {}
  }

  async function loadFields() {
    try {
      const data = await getJournalFields();
      setFieldData(data.journalsByField);
      setAllFields(data.fields);
    } catch {}
  }

  async function handleSaveAlert() {
    try {
      const kws = keywords.split(',').map(k => k.trim()).filter(Boolean);
      if (kws.length === 0) { setError('키워드를 입력해주세요'); return; }
      await savePaperAlert({ keywords: kws, journals: selectedJournals });
      setTab('results');
    } catch (err: any) { setError(err.message); }
  }

  async function handleCrawl() {
    setCrawling(true); setCrawlResult(null);
    try {
      const result = await runPaperCrawl();
      setCrawlResult(result);
      await loadResults();
    } catch (err: any) { setError(err.message); }
    finally { setCrawling(false); }
  }

  async function handleSearch() {
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const data = await searchJournals(searchQuery);
      setSearchResults(data.results || []);
    } catch (err: any) { setError(err.message); }
    finally { setSearching(false); }
  }

  async function handleAddCustom() {
    if (!customName.trim() || !customUrl.trim()) return;
    setAddingCustom(true);
    try {
      await addCustomJournal({ name: customName, rssUrl: customUrl });
      setCustomFeeds(prev => [...prev, { name: customName, rssUrl: customUrl }]);
      setCustomName(''); setCustomUrl('');
    } catch (err: any) { setError(err.message); }
    finally { setAddingCustom(false); }
  }

  async function handleAddFromSearch(journal: any) {
    if (!journal.rssUrl) {
      setCustomName(journal.name);
      setCustomUrl('');
      setError(`"${journal.name}"의 RSS URL을 자동으로 찾지 못했습니다. 직접 입력해주세요.`);
      return;
    }
    try {
      await addCustomJournal({ name: journal.name, rssUrl: journal.rssUrl, publisher: journal.publisher });
      setCustomFeeds(prev => [...prev, { name: journal.name, rssUrl: journal.rssUrl }]);
    } catch (err: any) { setError(err.message); }
  }

  function toggleJournal(name: string) {
    setSelectedJournals(prev =>
      prev.includes(name) ? prev.filter(j => j !== name) : [...prev, name]
    );
  }

  function selectFieldJournals(field: string) {
    const fieldJournals = (fieldData[field] || []).map(j => j.name);
    const newSelected = Array.from(new Set([...selectedJournals, ...fieldJournals]));
    setSelectedJournals(newSelected);
  }

  const filteredResults = filterStars > 0
    ? results.filter(r => (r as any).stars >= filterStars)
    : results;

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">📚 연구동향 모니터링</h1>
          <p className="text-text-muted text-sm mt-1">
            {selectedJournals.length + customFeeds.length}개 저널 모니터링 중
          </p>
        </div>
        <div className="flex gap-2">
          {['results', 'journals', 'keywords'].map(t => (
            <button key={t} onClick={() => setTab(t as any)}
              className={`px-4 py-2 rounded-lg text-sm ${tab === t ? 'bg-primary text-white' : 'bg-bg-card text-text-muted border border-bg-input/50 hover:text-white'}`}>
              {t === 'results' ? '📋 결과' : t === 'journals' ? '📰 저널 설정' : '🔑 키워드'}
            </button>
          ))}
          <button onClick={handleCrawl} disabled={crawling}
            className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium disabled:opacity-50">
            {crawling ? '수집 중...' : '🔄 수집'}
          </button>
        </div>
      </div>

      {error && <div className="bg-red-500/10 text-red-400 px-4 py-3 rounded-lg text-sm">{error}
        <button onClick={() => setError('')} className="ml-2 text-red-300">✕</button>
      </div>}
      {crawlResult && (
        <div className="bg-green-500/10 text-green-400 px-4 py-3 rounded-lg text-sm">
          {crawlResult.totalFetched}편 수집 → {crawlResult.matched}편 관련
          (★★★{crawlResult.breakdown?.threeStars} / ★★{crawlResult.breakdown?.twoStars} / ★{crawlResult.breakdown?.oneStar})
          → {crawlResult.newSaved}편 신규
        </div>
      )}

      {/* ── Results Tab ── */}
      {tab === 'results' && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            {unreadCount > 0 && <span className="text-primary text-sm font-medium">📬 미확인 {unreadCount}편</span>}
            <div className="flex-1" />
            <div className="flex gap-1">
              {[0, 1, 2, 3].map(s => (
                <button key={s} onClick={() => setFilterStars(s)}
                  className={`px-3 py-1 rounded-full text-xs ${filterStars === s ? 'bg-primary text-white' : 'bg-bg-card text-text-muted border border-bg-input/50'}`}>
                  {s === 0 ? '전체' : '★'.repeat(s) + ' 이상'}
                </button>
              ))}
            </div>
          </div>

          {filteredResults.length === 0 ? (
            <div className="bg-bg-card rounded-xl border border-bg-input/50 p-12 text-center">
              <p className="text-4xl mb-4">📚</p>
              <p className="text-white font-medium">수집된 논문이 없습니다</p>
              <p className="text-text-muted text-sm mt-2">저널과 키워드를 설정하고 수집을 실행해보세요</p>
            </div>
          ) : filteredResults.map(paper => {
            const starInfo = STAR_LABELS[(paper as any).stars] || STAR_LABELS[1];
            const themes = ((paper as any).themes as string[]) || [];
            return (
              <div key={paper.id} className={`bg-bg-card rounded-xl border border-bg-input/50 p-5 ${!paper.read ? 'border-l-4 border-l-primary' : ''}`}>
                <div className="flex justify-between items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-2 flex-wrap">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${starInfo.bg} ${starInfo.color}`}>{starInfo.label}</span>
                      {themes.map(t => <span key={t} className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary">{t}</span>)}
                    </div>
                    <h3 className="text-white font-medium text-sm leading-snug">{paper.title}</h3>
                    <p className="text-text-muted text-xs mt-1">
                      {paper.journal}{paper.authors && ` · ${paper.authors.slice(0, 80)}`}
                    </p>
                    {paper.aiSummary && (
                      <div className="mt-2 bg-bg/50 rounded-lg p-3 text-xs text-text-muted leading-relaxed">{paper.aiSummary}</div>
                    )}
                  </div>
                  <div className="flex flex-col gap-2 flex-shrink-0">
                    {paper.url && <a href={paper.url} target="_blank" rel="noopener" className="px-3 py-1.5 bg-bg-input text-text-muted rounded-lg text-xs hover:text-white text-center">🔗 원문</a>}
                    {(paper as any).doi && <a href={`https://doi.org/${(paper as any).doi}`} target="_blank" rel="noopener" className="px-3 py-1.5 bg-bg-input text-text-muted rounded-lg text-xs hover:text-white text-center">DOI</a>}
                    {!paper.read && <button onClick={() => { markPaperRead(paper.id); setResults(p => p.map(r => r.id === paper.id ? {...r, read: true} : r)); setUnreadCount(c => c-1); }} className="px-3 py-1.5 bg-primary/20 text-primary rounded-lg text-xs">확인</button>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Journals Tab ── */}
      {tab === 'journals' && (
        <div className="space-y-6">
          {/* Selected journals summary */}
          <div className="bg-bg-card rounded-xl border border-bg-input/50 p-5">
            <h3 className="text-white font-semibold mb-3">현재 모니터링 저널 ({selectedJournals.length + customFeeds.length}개)</h3>
            <div className="flex flex-wrap gap-2">
              {selectedJournals.map(j => (
                <span key={j} className="flex items-center gap-1 px-3 py-1 bg-primary/10 text-primary rounded-full text-xs">
                  {j} <button onClick={() => toggleJournal(j)} className="text-primary/60 hover:text-primary">✕</button>
                </span>
              ))}
              {customFeeds.map(f => (
                <span key={f.rssUrl} className="flex items-center gap-1 px-3 py-1 bg-blue-500/10 text-blue-400 rounded-full text-xs">
                  {f.name} (커스텀)
                </span>
              ))}
              {selectedJournals.length + customFeeds.length === 0 && (
                <span className="text-text-muted text-xs">아래에서 분야를 선택하거나 저널을 검색하세요</span>
              )}
            </div>
            <button onClick={handleSaveAlert} className="mt-3 px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium">저장</button>
          </div>

          {/* Field-based picker */}
          <div className="bg-bg-card rounded-xl border border-bg-input/50 p-5">
            <h3 className="text-white font-semibold mb-1">분야별 추천 저널</h3>
            <p className="text-xs text-text-muted mb-4">연구 분야를 선택하면 해당 분야의 주요 저널을 추천합니다</p>
            <div className="flex flex-wrap gap-2 mb-4">
              {allFields.map(field => (
                <button key={field} onClick={() => setExpandedField(expandedField === field ? null : field)}
                  className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${expandedField === field ? 'bg-primary text-white border-primary' : 'bg-bg-input text-text-muted border-bg-input/50 hover:text-white'}`}>
                  {field} ({fieldData[field]?.length || 0})
                </button>
              ))}
            </div>
            {expandedField && fieldData[expandedField] && (
              <div className="bg-bg/50 rounded-lg p-4 space-y-2">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-primary">{expandedField}</span>
                  <button onClick={() => selectFieldJournals(expandedField)} className="text-xs text-primary hover:underline">전체 추가</button>
                </div>
                {fieldData[expandedField].map(j => (
                  <label key={j.name} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-bg-input/30 px-2 py-1 rounded">
                    <input type="checkbox" checked={selectedJournals.includes(j.name)} onChange={() => toggleJournal(j.name)} className="accent-primary rounded" />
                    <span className="text-white">{j.name}</span>
                    <span className="text-text-muted text-xs">({j.publisher})</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Journal search */}
          <div className="bg-bg-card rounded-xl border border-bg-input/50 p-5">
            <h3 className="text-white font-semibold mb-1">저널 검색</h3>
            <p className="text-xs text-text-muted mb-3">목록에 없는 저널을 키워드로 검색하세요 (OpenAlex 기반)</p>
            <div className="flex gap-2 mb-3">
              <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSearch()}
                placeholder="예: urban planning, wireless communication, polymer..."
                className="flex-1 bg-bg-input text-white px-4 py-2.5 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary" />
              <button onClick={handleSearch} disabled={searching}
                className="px-4 py-2.5 bg-primary text-white rounded-lg text-sm font-medium disabled:opacity-50">
                {searching ? '...' : '검색'}
              </button>
            </div>
            {searchResults.length > 0 && (
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {searchResults.map((j, i) => (
                  <div key={i} className="flex items-center justify-between bg-bg/50 rounded-lg p-3">
                    <div>
                      <p className="text-sm text-white">{j.name}</p>
                      <p className="text-xs text-text-muted">{j.publisher || 'Unknown'} · 인용 {j.citedByCount?.toLocaleString()}</p>
                    </div>
                    <button onClick={() => handleAddFromSearch(j)}
                      className="px-3 py-1 bg-primary/20 text-primary rounded text-xs hover:bg-primary/30">
                      {j.rssUrl ? '+ 추가' : '수동 추가'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Custom RSS */}
          <div className="bg-bg-card rounded-xl border border-bg-input/50 p-5">
            <h3 className="text-white font-semibold mb-1">커스텀 RSS 피드</h3>
            <p className="text-xs text-text-muted mb-3">아무 저널이나 RSS URL을 직접 입력할 수 있습니다</p>
            <div className="flex gap-2">
              <input value={customName} onChange={e => setCustomName(e.target.value)} placeholder="저널명"
                className="w-48 bg-bg-input text-white px-3 py-2 rounded-lg text-sm focus:outline-none border border-bg-input/50" />
              <input value={customUrl} onChange={e => setCustomUrl(e.target.value)} placeholder="RSS URL"
                className="flex-1 bg-bg-input text-white px-3 py-2 rounded-lg text-sm focus:outline-none border border-bg-input/50" />
              <button onClick={handleAddCustom} disabled={addingCustom}
                className="px-4 py-2 bg-primary text-white rounded-lg text-sm disabled:opacity-50">
                {addingCustom ? '...' : '추가'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Keywords Tab ── */}
      {tab === 'keywords' && (
        <div className="space-y-6">
          <div className="bg-bg-card rounded-xl border border-bg-input/50 p-6 space-y-4">
            <h3 className="text-white font-semibold">연구 키워드</h3>
            <p className="text-xs text-text-muted">연구실 프로필의 테마 키워드가 자동 적용됩니다. 추가 키워드를 입력할 수 있습니다.</p>
            <textarea
              value={keywords}
              onChange={e => setKeywords(e.target.value)}
              placeholder="예: biosensor, flexible electronics, hydrogel, liquid metal, wearable, self-healing"
              rows={4}
              className="w-full bg-bg-input text-white px-4 py-3 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary resize-none"
            />
            <div className="bg-bg/50 rounded-lg p-3 text-xs text-text-muted">
              <p className="font-medium text-white mb-1">관련도 평가 기준</p>
              <p>★★★ 직접 관련: 2개 이상 연구 테마 매칭</p>
              <p>★★ 높은 관련: 1개 테마 매칭 → AI 요약 + CrossRef 보강</p>
              <p>★ 참고: 테마 외 키워드 매칭 (요약 없음)</p>
            </div>
            <button onClick={handleSaveAlert} className="w-full py-3 bg-primary text-white rounded-lg text-sm font-medium">저장</button>
          </div>
        </div>
      )}
    </div>
  );
}
