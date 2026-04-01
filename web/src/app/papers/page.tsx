'use client';

import { useState, useEffect, useRef } from 'react';
import {
  getPaperAlerts, savePaperAlert, runPaperCrawl, getPaperAlertResults, markPaperRead,
  getJournalFields, searchJournals, addCustomJournal, uploadPaperPdf,
  type PaperAlertResult,
} from '@/lib/api';

const MAX_JOURNALS = 15;

const STAR_INFO: Record<number, { label: string; color: string }> = {
  3: { label: '★★★ 직접 관련', color: 'text-yellow-400' },
  2: { label: '★★ 높은 관련', color: 'text-orange-400' },
  1: { label: '★ 참고', color: 'text-gray-400' },
};

// 주차 계산 (ISO week)
function getWeekLabel(dateStr: string): string {
  const d = new Date(dateStr);
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();
  // 해당 달의 주차
  const firstDay = new Date(year, d.getMonth(), 1);
  const weekNum = Math.ceil((day + firstDay.getDay()) / 7);
  // 주 시작/끝 계산
  const dayOfWeek = d.getDay() || 7; // 일=7
  const monday = new Date(d);
  monday.setDate(day - dayOfWeek + 1);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = (dt: Date) => `${dt.getMonth() + 1}.${String(dt.getDate()).padStart(2, '0')}`;
  return `${year}년 ${month}월 ${weekNum}주차 (${fmt(monday)} ~ ${fmt(sunday)})`;
}

// 테마 이모지 매핑
const THEME_EMOJI: Record<string, string> = {
  '하이드로겔': '🧪', 'Hydrogel': '🧪',
  '이종소재 접착제': '🔗', 'Adhesive': '🔗',
  'Antifouling Coating': '🛡️', 'Antifouling': '🛡️',
  'Liquid Metal': '🔬', '액체금속': '🔬',
  'Neuromorphic Device': '🧠', 'Neuromorphic': '🧠',
};

function getThemeEmoji(theme: string): string {
  for (const [key, emoji] of Object.entries(THEME_EMOJI)) {
    if (theme.toLowerCase().includes(key.toLowerCase())) return emoji;
  }
  return '📄';
}

interface WeekGroup {
  label: string;
  papers: PaperAlertResult[];
  themes: Map<string, PaperAlertResult[]>;
  totalFetched?: number;
}

export default function PapersPage() {
  const [results, setResults] = useState<PaperAlertResult[]>([]);
  const [keywords, setKeywords] = useState('');
  const [selectedJournals, setSelectedJournals] = useState<string[]>([]);
  const [customFeeds, setCustomFeeds] = useState<Array<{ name: string; rssUrl: string }>>([]);
  const [crawling, setCrawling] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState('');
  const [expandedPapers, setExpandedPapers] = useState<Set<string>>(new Set());

  // Settings sub-state
  const [fieldData, setFieldData] = useState<Record<string, Array<{ name: string; publisher: string; hasRss: boolean }>>>({});
  const [allFields, setAllFields] = useState<string[]>([]);
  const [expandedField, setExpandedField] = useState<string | null>(null);
  const [addInput, setAddInput] = useState('');
  const [addLoading, setAddLoading] = useState(false);
  const [searchResultsJ, setSearchResultsJ] = useState<any[]>([]);

  // PDF upload
  const [pdfUploading, setPdfUploading] = useState(false);
  const pdfInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { loadAlerts(); loadResults(); }, []);

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
    } catch {}
  }

  async function loadResults() {
    try {
      const data = await getPaperAlertResults();
      setResults(data.results || data.data || []);
    } catch {}
  }

  async function loadFields() {
    try {
      const data = await getJournalFields();
      setFieldData(data.journalsByField);
      setAllFields(data.fields);
    } catch {}
  }

  async function handleCrawl() {
    if (selectedJournals.length === 0 && customFeeds.length === 0) {
      setError('⚙️ 설정에서 저널을 먼저 추가해주세요');
      return;
    }
    setCrawling(true);
    try {
      const kws = keywords.split(',').map(k => k.trim()).filter(Boolean);
      // 키워드 없어도 저널만으로 저장 (Lab 테마 키워드가 서버에서 자동 적용됨)
      await savePaperAlert({ keywords: kws, journals: selectedJournals });
      await runPaperCrawl();
      await loadResults();
    } catch (err: any) { setError(err.message); }
    finally { setCrawling(false); }
  }

  function togglePaper(id: string) {
    setExpandedPapers(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // 주차별 그룹핑
  const weekGroups: WeekGroup[] = (() => {
    const grouped = new Map<string, PaperAlertResult[]>();
    for (const paper of results) {
      const dateStr = (paper as any).pubDate || paper.createdAt;
      const label = getWeekLabel(dateStr);
      if (!grouped.has(label)) grouped.set(label, []);
      grouped.get(label)!.push(paper);
    }

    return Array.from(grouped.entries())
      .sort((a, b) => {
        const dateA = new Date((a[1][0] as any).pubDate || a[1][0].createdAt);
        const dateB = new Date((b[1][0] as any).pubDate || b[1][0].createdAt);
        return dateB.getTime() - dateA.getTime();
      })
      .map(([label, papers]) => {
        // 테마별 분류
        const themes = new Map<string, PaperAlertResult[]>();
        for (const p of papers) {
          const pThemes = ((p as any).themes as string[]) || ['기타'];
          for (const t of pThemes) {
            if (!themes.has(t)) themes.set(t, []);
            themes.get(t)!.push(p);
          }
        }
        return { label, papers, themes };
      });
  })();

  // Settings panel functions
  function toggleJournal(name: string) {
    if (selectedJournals.includes(name)) {
      setSelectedJournals(prev => prev.filter(j => j !== name));
    } else if (totalJournals < MAX_JOURNALS) {
      setSelectedJournals(prev => [...prev, name]);
    }
  }

  async function handleAddJournal() {
    if (!addInput.trim()) return;
    if (addInput.startsWith('http')) {
      setAddLoading(true);
      try {
        const name = prompt('저널 이름을 입력해주세요:') || addInput;
        await addCustomJournal({ name, rssUrl: addInput });
        setCustomFeeds(prev => [...prev, { name, rssUrl: addInput }]);
        setAddInput('');
      } catch (err: any) { setError(err.message); }
      finally { setAddLoading(false); }
      return;
    }
    setAddLoading(true);
    try {
      const data = await searchJournals(addInput);
      setSearchResultsJ(data.results || []);
    } catch (err: any) { setError(err.message); }
    finally { setAddLoading(false); }
  }

  async function handlePdfUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPdfUploading(true);
    try {
      await uploadPaperPdf(file);
      await loadResults();
    } catch (err: any) { setError(err.message); }
    finally { setPdfUploading(false); if (pdfInputRef.current) pdfInputRef.current.value = ''; }
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">📚 연구동향</h1>
          <p className="text-text-muted text-sm mt-1">
            {totalJournals}개 저널 모니터링 · 주간 자동 업데이트
          </p>
        </div>
        <div className="flex gap-2">
          <input type="file" ref={pdfInputRef} onChange={handlePdfUpload} className="hidden" accept=".pdf" />
          <button onClick={() => pdfInputRef.current?.click()} disabled={pdfUploading}
            className="px-4 py-2 bg-bg-card text-text-muted border border-bg-input/50 rounded-lg text-sm hover:text-white">
            {pdfUploading ? '⏳' : '📄'} PDF 업로드
          </button>
          <button onClick={handleCrawl} disabled={crawling}
            className="px-4 py-2 bg-bg-card text-text-muted border border-bg-input/50 rounded-lg text-sm hover:text-white disabled:opacity-50">
            {crawling ? '수집 중...' : '🔄 수집'}
          </button>
          <button onClick={() => { setShowSettings(!showSettings); if (!showSettings) loadFields(); }}
            className={`px-4 py-2 rounded-lg text-sm ${showSettings ? 'bg-primary text-white' : 'bg-bg-card text-text-muted border border-bg-input/50 hover:text-white'}`}>
            ⚙️ 설정
          </button>
        </div>
      </div>

      {error && <div className="bg-red-500/10 text-red-400 px-4 py-3 rounded-lg text-sm flex items-center justify-between">{error}<button onClick={() => setError('')}>✕</button></div>}

      {/* Settings Panel */}
      {showSettings && (
        <div className="bg-bg-card rounded-xl border border-bg-input/50 p-5 space-y-5">
          <div className="flex items-center justify-between">
            <h3 className="text-white font-semibold">저널 & 키워드 설정</h3>
            <span className="text-xs text-text-muted">{totalJournals}/{MAX_JOURNALS}</span>
          </div>

          {/* Current journals */}
          <div className="flex flex-wrap gap-2">
            {selectedJournals.map(j => (
              <span key={j} className="flex items-center gap-1 px-3 py-1.5 bg-primary/10 text-primary rounded-full text-xs">
                {j} <button onClick={() => toggleJournal(j)} className="text-primary/50 hover:text-primary ml-1">✕</button>
              </span>
            ))}
            {customFeeds.map(f => (
              <span key={f.rssUrl} className="px-3 py-1.5 bg-blue-500/10 text-blue-400 rounded-full text-xs">{f.name}</span>
            ))}
          </div>

          {/* Add journal */}
          <div className="flex gap-2">
            <input value={addInput} onChange={e => setAddInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAddJournal()}
              placeholder="저널명 또는 RSS URL..."
              className="flex-1 bg-bg-input text-white px-4 py-2.5 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary" />
            <button onClick={handleAddJournal} disabled={addLoading}
              className="px-5 py-2.5 bg-primary text-white rounded-lg text-sm disabled:opacity-50">
              {addLoading ? '...' : '추가'}
            </button>
          </div>
          {searchResultsJ.length > 0 && (
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {searchResultsJ.map((j, i) => (
                <button key={i} onClick={async () => {
                  if (j.source === 'built-in') { toggleJournal(j.name); }
                  else if (j.rssUrl) { await addCustomJournal({ name: j.name, rssUrl: j.rssUrl, publisher: j.publisher }); setCustomFeeds(prev => [...prev, { name: j.name, rssUrl: j.rssUrl }]); }
                  setSearchResultsJ([]); setAddInput('');
                }} className="w-full flex items-center justify-between bg-bg/50 hover:bg-bg-input/50 rounded-lg p-3 text-left">
                  <div><p className="text-sm text-white">{j.name}</p><p className="text-xs text-text-muted">{j.publisher || ''}</p></div>
                  <span className="text-xs text-primary">+ 추가</span>
                </button>
              ))}
            </div>
          )}

          {/* Field picker */}
          <div className="flex flex-wrap gap-2">
            {allFields.map(field => (
              <button key={field} onClick={() => setExpandedField(expandedField === field ? null : field)}
                className={`px-3 py-1.5 rounded-lg text-xs border ${expandedField === field ? 'bg-primary text-white border-primary' : 'bg-bg-input text-text-muted border-bg-input/50 hover:text-white'}`}>
                {field}
              </button>
            ))}
          </div>
          {expandedField && fieldData[expandedField] && (
            <div className="bg-bg/50 rounded-lg p-4 grid grid-cols-2 gap-1.5">
              {fieldData[expandedField].map(j => (
                <label key={j.name} className={`flex items-center gap-2 text-xs cursor-pointer px-2 py-1.5 rounded hover:bg-bg-input/30 ${!j.hasRss ? 'opacity-50' : ''}`}>
                  <input type="checkbox" checked={selectedJournals.includes(j.name)} onChange={() => toggleJournal(j.name)} disabled={!j.hasRss} className="accent-primary rounded" />
                  <span className="text-white">{j.name}</span>
                </label>
              ))}
            </div>
          )}

          {/* Keywords */}
          <div>
            <p className="text-xs text-text-muted mb-2">연구 키워드 (쉼표 구분)</p>
            <textarea value={keywords} onChange={e => setKeywords(e.target.value)} rows={2}
              placeholder="biosensor, flexible electronics, hydrogel..."
              className="w-full bg-bg-input text-white px-4 py-3 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary resize-none" />
          </div>

          <button onClick={async () => {
            const kws = keywords.split(',').map(k => k.trim()).filter(Boolean);
            if (kws.length > 0) await savePaperAlert({ keywords: kws, journals: selectedJournals });
            setShowSettings(false);
          }} className="w-full py-2.5 bg-primary text-white rounded-lg text-sm font-medium">설정 저장</button>
        </div>
      )}

      {/* ── 주차별 논문 대시보드 ── */}
      {results.length === 0 ? (
        <div className="bg-bg-card rounded-xl border border-bg-input/50 p-12 text-center">
          <p className="text-4xl mb-4">📚</p>
          <p className="text-white font-medium">수집된 논문이 없습니다</p>
          <p className="text-text-muted text-sm mt-2">⚙️ 설정에서 저널과 키워드를 설정한 후 🔄 수집을 실행하세요</p>
        </div>
      ) : weekGroups.map(week => (
        <div key={week.label} className="space-y-4">
          {/* 주차 헤더 */}
          <div className="border-t border-bg-input/30 pt-6">
            <h2 className="text-lg font-bold text-white">📅 {week.label}</h2>
            <p className="text-text-muted text-sm mt-1">
              총 {week.papers.length}편 선별
              {' · '}
              {Array.from(week.themes.entries()).map(([t, papers]) => `${t}(${papers.length})`).join(', ')}
            </p>
          </div>

          {/* 테마별 섹션 */}
          {Array.from(week.themes.entries()).map(([theme, papers]) => (
            <div key={theme} className="bg-bg-card rounded-xl border border-bg-input/50 p-5">
              <h3 className="text-primary font-semibold text-sm mb-2">
                {getThemeEmoji(theme)} {theme} ({papers.length}편)
              </h3>

              {/* 논문 토글 리스트 */}
              <div className="space-y-1">
                {papers.map(paper => {
                  const stars = (paper as any).stars || 1;
                  const si = STAR_INFO[stars] || STAR_INFO[1];
                  const isOpen = expandedPapers.has(paper.id);

                  return (
                    <div key={paper.id}>
                      {/* 닫힘 상태: 한 줄 */}
                      <button
                        onClick={() => togglePaper(paper.id)}
                        className="w-full flex items-center gap-2 text-left py-2 px-3 rounded-lg hover:bg-bg-input/30 transition-colors"
                      >
                        <span className="text-xs text-text-muted">{isOpen ? '▼' : '▶'}</span>
                        <span className="flex-1 text-sm text-white truncate">{paper.title}</span>
                        <span className="text-xs text-text-muted flex-shrink-0">({paper.journal})</span>
                        <span className={`text-xs flex-shrink-0 ${si.color}`}>{si.label}</span>
                      </button>

                      {/* 열림 상태: 상세 */}
                      {isOpen && (
                        <div className="ml-7 mb-3 pl-4 border-l-2 border-bg-input/50 space-y-2">
                          <p className="text-xs text-text-muted">
                            <span className="font-medium">저널</span>: {paper.journal}
                            {(paper as any).pubDate && <> | <span className="font-medium">발행일</span>: {new Date((paper as any).pubDate).toLocaleDateString('ko-KR')}</>}
                          </p>
                          {((paper as any).doi || paper.url) && (
                            <p className="text-xs">
                              🔗{' '}
                              {(paper as any).doi ? (
                                <a href={`https://doi.org/${(paper as any).doi}`} target="_blank" rel="noopener" className="text-primary hover:underline">논문 링크</a>
                              ) : paper.url ? (
                                <a href={paper.url} target="_blank" rel="noopener" className="text-primary hover:underline">논문 링크</a>
                              ) : null}
                            </p>
                          )}
                          {paper.aiSummary && (
                            <p className="text-xs text-text-main leading-relaxed">{paper.aiSummary}</p>
                          )}
                          {((paper as any).matchedKeywords || (paper as any).themes) && (
                            <p className="text-xs text-text-muted">
                              <span className="font-medium">키워드 매칭</span>: {((paper as any).matchedKeywords || (paper as any).themes || []).join(', ')}
                            </p>
                          )}
                          {!paper.read && (
                            <button onClick={() => { markPaperRead(paper.id); setResults(p => p.map(r => r.id === paper.id ? {...r, read: true} : r)); }}
                              className="text-xs text-primary hover:underline">확인 완료</button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
