'use client';

import { useState, useEffect } from 'react';
import {
  getPaperAlerts, savePaperAlert, runPaperCrawl, getPaperAlertResults, markPaperRead,
  getJournalFields, searchJournals, addCustomJournal,
  type PaperAlertSetting, type PaperAlertResult,
} from '@/lib/api';

const MAX_JOURNALS = 15;

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
  const [fieldData, setFieldData] = useState<Record<string, Array<{ name: string; publisher: string; hasRss: boolean }>>>({});
  const [allFields, setAllFields] = useState<string[]>([]);
  const [expandedField, setExpandedField] = useState<string | null>(null);

  // Add journal
  const [addInput, setAddInput] = useState('');
  const [addLoading, setAddLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<any[]>([]);

  useEffect(() => { loadAlerts(); loadResults(); loadFields(); }, []);

  const totalJournals = selectedJournals.length + customFeeds.length;

  async function loadAlerts() {
    try {
      const data = await getPaperAlerts();
      const alertList = data.alerts || data.data || [];
      if (alertList.length > 0) {
        setKeywords(alertList[0].keywords.join(', '));
        setSelectedJournals(alertList[0].journals);
        setCustomFeeds((alertList[0] as any).customFeeds || []);
      }
    } catch (err: any) { if (!err.message?.includes('404')) setError(err.message); }
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

  async function handleSave() {
    const kws = keywords.split(',').map(k => k.trim()).filter(Boolean);
    if (kws.length === 0) { setError('키워드를 입력해주세요'); return; }
    try {
      await savePaperAlert({ keywords: kws, journals: selectedJournals });
    } catch (err: any) { setError(err.message); }
  }

  async function handleCrawl() {
    setCrawling(true); setCrawlResult(null);
    try {
      await handleSave();
      const result = await runPaperCrawl();
      setCrawlResult(result);
      await loadResults();
    } catch (err: any) { setError(err.message); }
    finally { setCrawling(false); }
  }

  // Add journal by name or RSS URL
  async function handleAddJournal() {
    if (!addInput.trim()) return;
    const input = addInput.trim();

    // RSS URL인지 판단
    if (input.startsWith('http')) {
      setAddLoading(true);
      try {
        const name = prompt('저널 이름을 입력해주세요:') || input;
        await addCustomJournal({ name, rssUrl: input });
        setCustomFeeds(prev => [...prev, { name, rssUrl: input }]);
        setAddInput('');
        setError('');
      } catch (err: any) { setError(err.message); }
      finally { setAddLoading(false); }
      return;
    }

    // 저널명 검색
    setAddLoading(true);
    try {
      const data = await searchJournals(input);
      setSearchResults(data.results || []);
    } catch (err: any) { setError(err.message); }
    finally { setAddLoading(false); }
  }

  function toggleJournal(name: string) {
    if (selectedJournals.includes(name)) {
      setSelectedJournals(prev => prev.filter(j => j !== name));
    } else if (totalJournals < MAX_JOURNALS) {
      setSelectedJournals(prev => [...prev, name]);
    } else {
      setError(`최대 ${MAX_JOURNALS}개까지 추가할 수 있습니다`);
    }
  }

  function selectFieldJournals(field: string) {
    const fieldJournals = (fieldData[field] || []).filter(j => j.hasRss).map(j => j.name);
    const remaining = MAX_JOURNALS - totalJournals;
    const toAdd = fieldJournals.filter(j => !selectedJournals.includes(j)).slice(0, remaining);
    if (toAdd.length === 0) { setError('이미 모두 추가되었거나 최대 개수에 도달했습니다'); return; }
    setSelectedJournals(prev => [...prev, ...toAdd]);
  }

  async function handleAddSearchResult(j: any) {
    if (totalJournals >= MAX_JOURNALS) { setError(`최대 ${MAX_JOURNALS}개까지 추가할 수 있습니다`); return; }

    if (j.source === 'built-in') {
      toggleJournal(j.name);
      setSearchResults([]);
      setAddInput('');
      return;
    }

    if (!j.rssUrl) {
      setError(`"${j.name}"의 RSS URL을 자동으로 찾지 못했습니다. RSS URL을 직접 입력해주세요.`);
      setAddInput('');
      return;
    }

    setAddLoading(true);
    try {
      await addCustomJournal({ name: j.name, rssUrl: j.rssUrl, publisher: j.publisher });
      setCustomFeeds(prev => [...prev, { name: j.name, rssUrl: j.rssUrl }]);
      setSearchResults([]);
      setAddInput('');
    } catch (err: any) { setError(err.message); }
    finally { setAddLoading(false); }
  }

  const filteredResults = filterStars > 0 ? results.filter(r => (r as any).stars >= filterStars) : results;

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">📚 연구동향 모니터링</h1>
          <p className="text-text-muted text-sm mt-1">{totalJournals}/{MAX_JOURNALS}개 저널 모니터링</p>
        </div>
        <div className="flex gap-2">
          {(['results', 'journals', 'keywords'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2 rounded-lg text-sm ${tab === t ? 'bg-primary text-white' : 'bg-bg-card text-text-muted border border-bg-input/50 hover:text-white'}`}>
              {t === 'results' ? '📋 결과' : t === 'journals' ? `📰 저널 (${totalJournals})` : '🔑 키워드'}
            </button>
          ))}
          <button onClick={handleCrawl} disabled={crawling}
            className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium disabled:opacity-50">
            {crawling ? '수집 중...' : '🔄 수집'}
          </button>
        </div>
      </div>

      {error && <div className="bg-red-500/10 text-red-400 px-4 py-3 rounded-lg text-sm flex items-center justify-between">{error}<button onClick={() => setError('')} className="ml-2">✕</button></div>}
      {crawlResult && (
        <div className="bg-green-500/10 text-green-400 px-4 py-3 rounded-lg text-sm">
          {crawlResult.totalFetched}편 수집 → ★★★{crawlResult.breakdown?.threeStars} / ★★{crawlResult.breakdown?.twoStars} / ★{crawlResult.breakdown?.oneStar} → {crawlResult.newSaved}편 신규
        </div>
      )}

      {/* ── Results ── */}
      {tab === 'results' && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            {unreadCount > 0 && <span className="text-primary text-sm font-medium">📬 미확인 {unreadCount}편</span>}
            <div className="flex-1" />
            {[0, 1, 2, 3].map(s => (
              <button key={s} onClick={() => setFilterStars(s)}
                className={`px-3 py-1 rounded-full text-xs ${filterStars === s ? 'bg-primary text-white' : 'bg-bg-card text-text-muted border border-bg-input/50'}`}>
                {s === 0 ? '전체' : '★'.repeat(s) + '+'}
              </button>
            ))}
          </div>
          {filteredResults.length === 0 ? (
            <div className="bg-bg-card rounded-xl border border-bg-input/50 p-12 text-center">
              <p className="text-4xl mb-4">📚</p>
              <p className="text-white font-medium">수집된 논문이 없습니다</p>
              <p className="text-text-muted text-sm mt-2">저널과 키워드를 설정한 후 수집을 실행하세요</p>
            </div>
          ) : filteredResults.map(paper => {
            const si = STAR_LABELS[(paper as any).stars] || STAR_LABELS[1];
            const themes = ((paper as any).themes as string[]) || [];
            return (
              <div key={paper.id} className={`bg-bg-card rounded-xl border border-bg-input/50 p-5 ${!paper.read ? 'border-l-4 border-l-primary' : ''}`}>
                <div className="flex justify-between items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-2 flex-wrap">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${si.bg} ${si.color}`}>{si.label}</span>
                      {themes.map(t => <span key={t} className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary">{t}</span>)}
                    </div>
                    <h3 className="text-white font-medium text-sm leading-snug">{paper.title}</h3>
                    <p className="text-text-muted text-xs mt-1">{paper.journal}{paper.authors && ` · ${paper.authors.slice(0, 80)}`}</p>
                    {paper.aiSummary && <div className="mt-2 bg-bg/50 rounded-lg p-3 text-xs text-text-muted leading-relaxed">{paper.aiSummary}</div>}
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

      {/* ── Journals ── */}
      {tab === 'journals' && (
        <div className="space-y-6">
          {/* Current journals */}
          <div className="bg-bg-card rounded-xl border border-bg-input/50 p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-white font-semibold">모니터링 중인 저널 ({totalJournals}/{MAX_JOURNALS})</h3>
              <button onClick={handleSave} className="px-3 py-1.5 bg-primary text-white rounded-lg text-xs">저장</button>
            </div>
            <div className="flex flex-wrap gap-2">
              {selectedJournals.map(j => (
                <span key={j} className="flex items-center gap-1 px-3 py-1.5 bg-primary/10 text-primary rounded-full text-xs">
                  {j} <button onClick={() => toggleJournal(j)} className="text-primary/50 hover:text-primary ml-1">✕</button>
                </span>
              ))}
              {customFeeds.map(f => (
                <span key={f.rssUrl} className="flex items-center gap-1 px-3 py-1.5 bg-blue-500/10 text-blue-400 rounded-full text-xs">
                  {f.name} <span className="text-blue-400/50">(커스텀)</span>
                </span>
              ))}
            </div>
            {totalJournals === 0 && <p className="text-text-muted text-xs mt-2">아래에서 분야를 선택하거나 저널명을 입력하세요</p>}
            {/* Progress bar */}
            <div className="mt-3 h-1.5 bg-bg-input rounded-full overflow-hidden">
              <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${(totalJournals / MAX_JOURNALS) * 100}%` }} />
            </div>
          </div>

          {/* Add by name or RSS */}
          <div className="bg-bg-card rounded-xl border border-bg-input/50 p-5">
            <h3 className="text-white font-semibold mb-1">저널 추가</h3>
            <p className="text-xs text-text-muted mb-3">저널명을 입력하면 자동으로 검색합니다. RSS URL을 직접 붙여넣기해도 됩니다.</p>
            <div className="flex gap-2">
              <input value={addInput} onChange={e => setAddInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAddJournal()}
                placeholder="저널명 또는 RSS URL 입력..."
                className="flex-1 bg-bg-input text-white px-4 py-2.5 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary" />
              <button onClick={handleAddJournal} disabled={addLoading || totalJournals >= MAX_JOURNALS}
                className="px-5 py-2.5 bg-primary text-white rounded-lg text-sm font-medium disabled:opacity-50">
                {addLoading ? '검색 중...' : '추가'}
              </button>
            </div>
            {searchResults.length > 0 && (
              <div className="mt-3 space-y-1 max-h-48 overflow-y-auto">
                {searchResults.map((j, i) => (
                  <button key={i} onClick={() => handleAddSearchResult(j)}
                    className="w-full flex items-center justify-between bg-bg/50 hover:bg-bg-input/50 rounded-lg p-3 text-left transition-colors">
                    <div>
                      <p className="text-sm text-white">{j.name}</p>
                      <p className="text-xs text-text-muted">{j.publisher || ''}{j.citedByCount ? ` · 인용 ${j.citedByCount.toLocaleString()}` : ''}</p>
                    </div>
                    <span className="text-xs text-primary">{j.rssUrl ? '+ 추가' : '수동'}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Field picker */}
          <div className="bg-bg-card rounded-xl border border-bg-input/50 p-5">
            <h3 className="text-white font-semibold mb-1">분야별 추천 (탑 저널 7개씩)</h3>
            <p className="text-xs text-text-muted mb-4">연구 분야를 선택하면 해당 분야의 대표 저널을 한번에 추가합니다</p>
            <div className="flex flex-wrap gap-2 mb-4">
              {allFields.map(field => (
                <button key={field} onClick={() => setExpandedField(expandedField === field ? null : field)}
                  className={`px-3 py-1.5 rounded-lg text-xs border transition-colors ${expandedField === field ? 'bg-primary text-white border-primary' : 'bg-bg-input text-text-muted border-bg-input/50 hover:text-white'}`}>
                  {field} ({fieldData[field]?.length || 0})
                </button>
              ))}
            </div>
            {expandedField && fieldData[expandedField] && (
              <div className="bg-bg/50 rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-medium text-primary">{expandedField}</span>
                  <button onClick={() => selectFieldJournals(expandedField)} disabled={totalJournals >= MAX_JOURNALS}
                    className="text-xs text-primary hover:underline disabled:opacity-50">전체 추가</button>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {fieldData[expandedField].map(j => (
                    <label key={j.name} className={`flex items-center gap-2 text-sm cursor-pointer px-2 py-1.5 rounded hover:bg-bg-input/30 ${!j.hasRss ? 'opacity-50' : ''}`}>
                      <input type="checkbox" checked={selectedJournals.includes(j.name)}
                        onChange={() => toggleJournal(j.name)} disabled={!j.hasRss || (!selectedJournals.includes(j.name) && totalJournals >= MAX_JOURNALS)}
                        className="accent-primary rounded" />
                      <span className="text-white text-xs">{j.name}</span>
                      <span className="text-text-muted text-[10px]">({j.publisher})</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Keywords ── */}
      {tab === 'keywords' && (
        <div className="bg-bg-card rounded-xl border border-bg-input/50 p-6 space-y-4">
          <h3 className="text-white font-semibold">연구 키워드</h3>
          <p className="text-xs text-text-muted">Lab 프로필의 연구 테마 키워드가 자동 적용됩니다. 추가 키워드를 입력할 수 있습니다.</p>
          <textarea value={keywords} onChange={e => setKeywords(e.target.value)} rows={4}
            placeholder="예: biosensor, flexible electronics, hydrogel, liquid metal"
            className="w-full bg-bg-input text-white px-4 py-3 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary resize-none" />
          <div className="bg-bg/50 rounded-lg p-3 text-xs text-text-muted space-y-1">
            <p className="font-medium text-white">관련도 평가 기준</p>
            <p>★★★ 직접 관련: 2개 이상 연구 테마 매칭 → AI 요약 + CrossRef 보강</p>
            <p>★★ 높은 관련: 1개 테마 매칭 → AI 요약 + CrossRef 보강</p>
            <p>★ 참고: 테마 외 키워드 매칭</p>
          </div>
          <button onClick={handleSave} className="w-full py-3 bg-primary text-white rounded-lg text-sm font-medium">저장</button>
        </div>
      )}
    </div>
  );
}
