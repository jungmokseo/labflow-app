'use client';

import { useState, useEffect, useRef } from 'react';
import {
  getPaperAlerts, savePaperAlert, runPaperCrawl, getPaperAlertResults,
  getJournalFields, searchJournals, addCustomJournal, uploadPaperPdf,
  resetPaperAlertResults,
  type PaperAlertResult,
} from '@/lib/api';
import { useApiData } from '@/lib/use-api';
import { StepProgress } from '@/components/Skeleton';
import {
  BookOpen, Star, FlaskConical, TestTube2, Link2, Shield, Brain, FileText,
  Settings, Loader2, RefreshCw, X, Calendar, ChevronDown, ChevronRight, Upload,
} from 'lucide-react';

const MAX_JOURNALS = 15;

const STAR_INFO: Record<number, { stars: number; label: string; color: string }> = {
  3: { stars: 3, label: '직접 관련', color: 'text-yellow-400' },
  2: { stars: 2, label: '높은 관련', color: 'text-orange-400' },
  1: { stars: 1, label: '참고', color: 'text-gray-400' },
};

function StarRating({ count, className }: { count: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-0.5 ${className || ''}`}>
      {Array.from({ length: count }).map((_, i) => (
        <Star key={i} className="w-3 h-3 fill-current" />
      ))}
    </span>
  );
}

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

// Theme icon mapping
const THEME_ICON_MAP: Record<string, React.ReactNode> = {
  '하이드로겔': <TestTube2 className="w-4 h-4 inline" />,
  'Hydrogel': <TestTube2 className="w-4 h-4 inline" />,
  '이종소재 접착제': <Link2 className="w-4 h-4 inline" />,
  'Adhesive': <Link2 className="w-4 h-4 inline" />,
  'Antifouling Coating': <Shield className="w-4 h-4 inline" />,
  'Antifouling': <Shield className="w-4 h-4 inline" />,
  'Liquid Metal': <FlaskConical className="w-4 h-4 inline" />,
  '액체금속': <FlaskConical className="w-4 h-4 inline" />,
  'Neuromorphic Device': <Brain className="w-4 h-4 inline" />,
  'Neuromorphic': <Brain className="w-4 h-4 inline" />,
};

function getThemeIcon(theme: string): React.ReactNode {
  for (const [key, icon] of Object.entries(THEME_ICON_MAP)) {
    if (theme.toLowerCase().includes(key.toLowerCase())) return icon;
  }
  return <FileText className="w-4 h-4 inline" />;
}

interface WeekGroup {
  label: string;
  papers: PaperAlertResult[];
  themes: Map<string, PaperAlertResult[]>;       // ★2-3 논문만
  otherPapers: PaperAlertResult[];                // ★1 기타 논문
  totalFetched: number | null;
  journals: string[];
  insight: string;                                // 클라이언트 생성 (fallback)
  aiInsight: string | null;                       // AI 생성 시사점 (서버)
}

export default function PapersPage() {
  const [keywords, setKeywords] = useState('');
  const [selectedJournals, setSelectedJournals] = useState<string[]>([]);
  const [customFeeds, setCustomFeeds] = useState<Array<{ name: string; rssUrl: string }>>([]);
  const [crawling, setCrawling] = useState(false);
  const [crawlStep, setCrawlStep] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState('');
  const [expandedPapers, setExpandedPapers] = useState<Set<string>>(new Set());
  const [crawlStats, setCrawlStats] = useState<{ totalFetched: number; matched: number } | null>(() => {
    if (typeof window === 'undefined') return null;
    try { const s = localStorage.getItem('paper-crawl-stats'); return s ? JSON.parse(s) : null; } catch { return null; }
  });

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

  // SWR for paper results (keep full response for metadata)
  const { data: resultsResponse, isLoading: resultsLoading, mutate: refreshResults } = useApiData(
    'paper-results-v2',
    async () => { const data = await getPaperAlertResults(); return data; }
  );
  // Handle both old cache format (array) and new format (object with results)
  const results: PaperAlertResult[] = Array.isArray(resultsResponse)
    ? resultsResponse
    : (resultsResponse as any)?.results || (resultsResponse as any)?.data || [];
  const apiJournals: string[] = Array.isArray(resultsResponse) ? [] : ((resultsResponse as any)?.journals || []);
  const apiTotalFetched: number | null = Array.isArray(resultsResponse) ? null : ((resultsResponse as any)?.totalFetched || null);
  const apiWeeklyInsight: string | null = Array.isArray(resultsResponse) ? null : ((resultsResponse as any)?.weeklyInsight || null);

  useEffect(() => { loadAlerts(); }, []);

  const totalJournals = selectedJournals.length + customFeeds.length;

  // BLISS Lab 기본 저널 (설정 복원용)
  const DEFAULT_JOURNALS = [
    'Nature', 'Science', 'Nature Materials', 'Nature Nanotechnology',
    'Nature Biomedical Engineering', 'Nature Electronics', 'Science Advances',
    'Science Robotics', 'Advanced Materials', 'Advanced Functional Materials',
    'Nature Sensors', 'Nature Chemical Engineering', 'ACS Nano', 'ACS Sensors',
  ];

  async function loadAlerts() {
    try {
      const data = await getPaperAlerts();
      const alertList = data.alerts || data.data || [];
      if (alertList.length > 0) {
        const alert = alertList[0];
        const journals = alert.journals?.length > 0 ? alert.journals : DEFAULT_JOURNALS;
        const kws = alert.keywords?.length > 0 ? alert.keywords.join(', ') : '';
        setKeywords(kws);
        setSelectedJournals(journals);
        setCustomFeeds((alert as any).customFeeds || []);
        // 서버에 저널이 비어있으면 기본값으로 자동 저장
        if (alert.journals?.length === 0) {
          const themeKws = (data as any).researchThemes?.flatMap((t: any) => t.keywords || []) || [];
          savePaperAlert({ keywords: themeKws.length > 0 ? themeKws : [], journals: DEFAULT_JOURNALS }).catch(() => {});
        }
      }
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
      setError('설정에서 저널을 먼저 추가해주세요');
      return;
    }
    setCrawling(true);
    setCrawlStep(0);
    try {
      const kws = keywords.split(',').map(k => k.trim()).filter(Boolean);
      setCrawlStep(0); // 설정 저장
      await savePaperAlert({ keywords: kws, journals: selectedJournals });
      setCrawlStep(1); // RSS 수집 시작 (백그라운드)
      await runPaperCrawl();
      // 백그라운드 수집 완료 대기 — 주기적 폴링
      setCrawlStep(2);
      let attempts = 0;
      const maxAttempts = 30; // 최대 ~2.5분
      const poll = async () => {
        while (attempts < maxAttempts) {
          await new Promise(r => setTimeout(r, 5000)); // 5초 간격
          attempts++;
          const res = await refreshResults();
          const newResults = (res as any)?.results || (res as any)?.data || [];
          if (newResults.length > 0) {
            setCrawlStep(3);
            return;
          }
        }
        setCrawlStep(3); // 타임아웃이어도 완료 표시
      };
      await poll();
    } catch (err: any) { setError(err.message); }
    finally { setCrawling(false); setCrawlStep(0); }
  }

  function togglePaper(id: string) {
    setExpandedPapers(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // 주차별 그룹핑 (중복 제거: 각 논문은 가장 관련 높은 테마 하나에만 배치)
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
        // 테마별 분류 — ★2-3만 테마 섹션, ★1은 기타 논문
        const themes = new Map<string, PaperAlertResult[]>();
        const otherPapers: PaperAlertResult[] = [];
        const assigned = new Set<string>();
        // 별점 높은 논문 먼저 배치
        const sorted = [...papers].sort((a, b) => ((b as any).stars || 1) - ((a as any).stars || 1));
        for (const p of sorted) {
          if (assigned.has(p.id)) continue;
          const stars = (p as any).stars || 1;
          if (stars === 1) {
            otherPapers.push(p);
            assigned.add(p.id);
            continue;
          }
          const pThemes = ((p as any).themes as string[]) || ['기타'];
          const primaryTheme = pThemes[0];
          if (!themes.has(primaryTheme)) themes.set(primaryTheme, []);
          themes.get(primaryTheme)!.push(p);
          assigned.add(p.id);
        }

        // 수집 저널 목록 — 설정된 전체 저널 사용 (API > state > papers fallback)
        const journals = apiJournals.length > 0 ? apiJournals : selectedJournals.length > 0 ? selectedJournals : Array.from(new Set(papers.map(p => p.journal))).sort();

        // 핵심 시사점 — 테마별 분석 + 핵심 논문 aiSummary 활용
        const topPapers = sorted.filter(p => ((p as any).stars || 1) >= 3);
        const highPapers = sorted.filter(p => ((p as any).stars || 1) >= 2);
        const themeEntries = Array.from(themes.entries()).sort((a, b) => b[1].length - a[1].length);

        const insightParts: string[] = [];

        // 1. 테마별 분포 + 트렌드 해석
        if (themeEntries.length > 0) {
          const distribution = themeEntries.map(([t, ps]) => `**${t}**(${ps.length}편)`).join(', ');
          insightParts.push(`이번 주는 ${distribution} 순으로 논문이 수집되었습니다.`);
        }

        // 2. 핵심 논문(★★★) 상세 — aiSummary 활용
        if (topPapers.length > 0) {
          const highlights = topPapers.slice(0, 3).map(p => {
            const shortTitle = p.title.length > 55 ? p.title.slice(0, 55) + '…' : p.title;
            const summary = p.aiSummary ? ` — ${p.aiSummary.split('.')[0]}.` : '';
            return `**${shortTitle}**(${p.journal}, ★★★)${summary}`;
          });
          insightParts.push(`특히 ${highlights.join(' ')}이(가) 핵심 논문으로 선별되었습니다.`);
        }

        // 3. 복수 테마 논문 분석
        const multiThemePapers = sorted.filter(p => ((p as any).themes as string[])?.length > 1);
        if (multiThemePapers.length > 0) {
          const mt = multiThemePapers[0];
          const mtThemes = ((mt as any).themes as string[]);
          insightParts.push(`**${mt.title.slice(0, 50)}…**은(는) ${mtThemes.map(t => `**${t}**`).join('과 ')} 테마를 아우르며, 연구실의 융합 연구 방향과 직접적으로 연결됩니다.`);
        }

        // 4. 테마별 주요 키워드 트렌드
        const keywordCounts: Record<string, number> = {};
        for (const p of sorted) {
          for (const kw of ((p as any).matchedKeywords || []) as string[]) {
            keywordCounts[kw] = (keywordCounts[kw] || 0) + 1;
          }
        }
        const topKeywords = Object.entries(keywordCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
        if (topKeywords.length > 0) {
          insightParts.push(`주요 매칭 키워드는 ${topKeywords.map(([kw, c]) => `**${kw}**(${c}건)`).join(', ')} 순이며, ${themeEntries[0]?.[0] || '핵심'} 분야의 연구 동향을 반영합니다.`);
        }

        // 5. ★★ 논문 수 언급
        const twoStarOnly = highPapers.length - topPapers.length;
        if (twoStarOnly > 0) {
          insightParts.push(`높은 관련(★★) 논문 ${twoStarOnly}편도 추가 검토가 필요합니다.`);
        }

        const insight = insightParts.join(' ');

        // 테마 순서를 논문 수 내림차순으로 정렬
        const sortedThemes = new Map(
          Array.from(themes.entries()).sort((a, b) => b[1].length - a[1].length)
        );

        return { label, papers, themes: sortedThemes, otherPapers, totalFetched: apiTotalFetched, journals, insight, aiInsight: apiWeeklyInsight };
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
      await refreshResults();
    } catch (err: any) { setError(err.message); }
    finally { setPdfUploading(false); if (pdfInputRef.current) pdfInputRef.current.value = ''; }
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-text-heading flex items-center gap-2"><BookOpen className="w-6 h-6 text-primary" /> 연구동향</h1>
          <p className="text-text-muted text-base mt-1">
            {totalJournals}개 저널 모니터링 · 주간 자동 업데이트
          </p>
        </div>
        <div className="flex gap-2">
          <input type="file" ref={pdfInputRef} onChange={handlePdfUpload} className="hidden" accept=".pdf" />
          <button onClick={() => pdfInputRef.current?.click()} disabled={pdfUploading}
            className="px-4 py-2 bg-bg-card text-text-muted border border-border rounded-lg text-sm hover:text-text-heading">
            {pdfUploading ? <Loader2 className="w-4 h-4 animate-spin inline mr-1" /> : <Upload className="w-4 h-4 inline mr-1" />} PDF 업로드
          </button>
          <button onClick={handleCrawl} disabled={crawling}
            className="px-4 py-2 bg-bg-card text-text-muted border border-border rounded-lg text-sm hover:text-text-heading disabled:opacity-50">
            {crawling ? '수집 중...' : <><RefreshCw className="w-4 h-4 inline mr-1" /> 수집</>}
          </button>
          <button onClick={() => { setShowSettings(!showSettings); if (!showSettings) loadFields(); }}
            className={`px-4 py-2 rounded-lg text-sm ${showSettings ? 'bg-primary text-white' : 'bg-bg-card text-text-muted border border-border hover:text-text-heading'}`}>
            <Settings className="w-4 h-4 inline mr-1" /> 설정
          </button>
        </div>
      </div>

      {/* 수집 진행 상태 */}
      {crawling && (
        <div className="bg-bg-card rounded-xl border border-border p-5">
          <StepProgress
            steps={['설정 저장', 'RSS 수집 + 키워드 매칭', '결과 정리', '완료']}
            currentStep={crawlStep}
          />
        </div>
      )}

      {error && <div className="bg-red-500/10 text-red-400 px-4 py-3 rounded-lg text-sm flex items-center justify-between">{error}<button onClick={() => setError('')}><X className="w-4 h-4" /></button></div>}

      {/* Settings Panel */}
      {showSettings && (
        <div className="bg-bg-card rounded-xl border border-border p-5 space-y-5">
          <div className="flex items-center justify-between">
            <h3 className="text-text-heading font-semibold">저널 & 키워드 설정</h3>
            <span className="text-xs text-text-muted">{totalJournals}/{MAX_JOURNALS}</span>
          </div>

          {/* Current journals */}
          <div className="flex flex-wrap gap-2">
            {selectedJournals.map(j => (
              <span key={j} className="flex items-center gap-1 px-3 py-1.5 bg-primary-light text-primary rounded-full text-xs">
                {j} <button onClick={() => toggleJournal(j)} className="text-primary/50 hover:text-primary ml-1"><X className="w-3 h-3 inline" /></button>
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
              className="flex-1 bg-bg-input text-text-heading px-4 py-2.5 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary" />
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
                }} className="w-full flex items-center justify-between bg-bg-input hover:bg-bg-hover rounded-lg p-3 text-left">
                  <div><p className="text-sm text-text-heading">{j.name}</p><p className="text-xs text-text-muted">{j.publisher || ''}</p></div>
                  <span className="text-xs text-primary">+ 추가</span>
                </button>
              ))}
            </div>
          )}

          {/* Field picker */}
          <div className="flex flex-wrap gap-2">
            {allFields.map(field => (
              <button key={field} onClick={() => setExpandedField(expandedField === field ? null : field)}
                className={`px-3 py-1.5 rounded-lg text-xs border ${expandedField === field ? 'bg-primary text-white border-primary' : 'bg-bg-input text-text-muted border-border hover:text-text-heading'}`}>
                {field}
              </button>
            ))}
          </div>
          {expandedField && fieldData[expandedField] && (
            <div className="bg-bg-input rounded-lg p-4 grid grid-cols-2 gap-1.5">
              {fieldData[expandedField].map(j => (
                <label key={j.name} className={`flex items-center gap-2 text-xs cursor-pointer px-2 py-1.5 rounded hover:bg-bg-hover/30 ${!j.hasRss ? 'opacity-50' : ''}`}>
                  <input type="checkbox" checked={selectedJournals.includes(j.name)} onChange={() => toggleJournal(j.name)} disabled={!j.hasRss} className="accent-primary rounded" />
                  <span className="text-text-heading">{j.name}</span>
                </label>
              ))}
            </div>
          )}

          {/* Keywords */}
          <div>
            <p className="text-xs text-text-muted mb-2">연구 키워드 (쉼표 구분)</p>
            <textarea value={keywords} onChange={e => setKeywords(e.target.value)} rows={2}
              placeholder="biosensor, flexible electronics, hydrogel..."
              className="w-full bg-bg-input text-text-heading px-4 py-3 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary resize-none" />
          </div>

          {/* Schedule info + Reset */}
          <div className="flex items-center justify-between bg-bg-input rounded-lg px-4 py-3">
            <div>
              <p className="text-sm text-text-heading font-medium">자동 수집 주기</p>
              <p className="text-xs text-text-muted">매주 자동 실행 · 수동 수집도 가능</p>
            </div>
            <span className="px-3 py-1 bg-primary/10 text-primary rounded-full text-xs font-medium">주간</span>
          </div>

          <button onClick={async () => {
            if (!confirm('기존 수집 결과를 모두 삭제하고 다시 수집합니다. 계속하시겠습니까?')) return;
            try {
              await resetPaperAlertResults();
              refreshResults();
              setShowSettings(false);
            } catch { }
          }} className="w-full py-2.5 text-red-400 border border-red-500/20 rounded-lg text-sm hover:bg-red-500/10 transition-colors">
            결과 초기화 (설정 유지)
          </button>

          <button onClick={() => {
            // Optimistic: close settings immediately
            setShowSettings(false);
            const kws = keywords.split(',').map(k => k.trim()).filter(Boolean);
            if (kws.length > 0) savePaperAlert({ keywords: kws, journals: selectedJournals }).catch(() => setShowSettings(true));
          }} className="w-full py-2.5 bg-primary text-white rounded-lg text-sm font-medium">설정 저장</button>
        </div>
      )}

      {/* ── 주차별 논문 대시보드 ── */}
      {resultsLoading ? (
        <div className="flex items-center justify-center min-h-[40vh]">
          <div className="w-8 h-8 rounded-full border-[3px] border-border border-t-primary animate-spin" />
        </div>
      ) : results.length === 0 ? (
        <div className="bg-bg-card rounded-xl border border-border p-12 text-center">
          <BookOpen className="w-12 h-12 text-text-muted/40 mx-auto mb-4" />
          <p className="text-text-heading font-medium text-base">수집된 논문이 없습니다</p>
          <p className="text-text-muted text-base mt-2">설정에서 저널과 키워드를 설정한 후 수집을 실행하세요</p>
        </div>
      ) : weekGroups.map(week => (
        <div key={week.label} className="space-y-4">
          {/* 주차 헤더 */}
          <div className="border-t border-border/30 pt-6 space-y-3">
            <h2 className="text-lg font-bold text-text-heading flex items-center gap-2"><Calendar className="w-5 h-5 text-primary" /> {week.label}</h2>
            <div className="text-sm text-text-muted space-y-1">
              <p><span className="font-medium text-text-heading">수집 저널</span>: {week.journals.join(', ')}</p>
              <p>
                <span className="font-medium text-text-heading">필터링 결과</span>: {week.journals.length}개 저널 RSS에서{week.totalFetched ? <> 총 <strong className="text-text-heading">{week.totalFetched.toLocaleString()}편</strong> 수집,</> : ''} <strong className="text-primary">{week.papers.length}편</strong> 관련 논문 선별
                {Array.from(week.themes.entries()).length > 0 && <>
                  {' · 테마별: '}
                  {Array.from(week.themes.entries()).map(([t, ps]) => `${t}(${ps.length})`).join(', ')}
                </>}
                {week.otherPapers.length > 0 && <>, 기타({week.otherPapers.length})</>}
              </p>
            </div>
            {/* AI 생성 핵심 시사점 (서버에서 생성) */}
            {(week.aiInsight || week.insight) && (
              <div className="bg-primary/5 border border-primary/15 rounded-lg px-4 py-3">
                <p className="text-xs font-medium text-primary mb-1.5">핵심 시사점</p>
                <p className="text-sm text-text-heading leading-relaxed">
                  {(week.aiInsight || week.insight).split(/(\*\*[^*]+\*\*)/).map((part, i) =>
                    part.startsWith('**') && part.endsWith('**')
                      ? <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>
                      : part
                  )}
                </p>
              </div>
            )}
          </div>

          {/* 테마별 섹션 (★2-3 논문) */}
          {Array.from(week.themes.entries()).map(([theme, papers]) => (
            <div key={theme} className="bg-bg-card rounded-xl border border-border p-5">
              <h3 className="text-primary font-semibold text-base mb-2 flex items-center gap-1.5">
                {getThemeIcon(theme)} {theme} ({papers.length}편)
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
                        className="w-full flex items-center gap-2 text-left py-2 px-3 rounded-lg hover:bg-bg-hover/30 transition-colors"
                      >
                        {isOpen ? <ChevronDown className="w-3.5 h-3.5 text-text-muted flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />}
                        <span className="flex-1 min-w-0">
                          <span className="text-base text-text-heading truncate block">{paper.title}</span>
                          {(paper as any).matchedKeywords && (paper as any).matchedKeywords.length > 0 && (
                            <span className="text-xs text-text-muted/70 truncate block">{((paper as any).matchedKeywords as string[]).join(', ')}</span>
                          )}
                        </span>
                        <span className="text-xs text-text-muted flex-shrink-0">({paper.journal})</span>
                        <span className={`text-xs flex-shrink-0 flex items-center gap-0.5 ${si.color}`}><StarRating count={si.stars} /> {si.label}</span>
                      </button>

                      {/* 열림 상태: 상세 */}
                      {isOpen && (
                        <div className="ml-7 mb-3 pl-4 border-l-2 border-border space-y-2">
                          <p className="text-sm text-text-muted">
                            <span className="font-medium">저널</span>: {paper.journal}
                            {(paper as any).pubDate && <> | <span className="font-medium">발행일</span>: {new Date((paper as any).pubDate).toLocaleDateString('ko-KR')}</>}
                          </p>
                          {((paper as any).doi || paper.url) && (
                            <p className="text-xs flex items-center gap-1">
                              <Link2 className="w-3 h-3" />
                              {(paper as any).doi ? (
                                <a href={`https://doi.org/${(paper as any).doi}`} target="_blank" rel="noopener" className="text-primary hover:underline">논문 링크</a>
                              ) : paper.url ? (
                                <a href={paper.url} target="_blank" rel="noopener" className="text-primary hover:underline">논문 링크</a>
                              ) : null}
                            </p>
                          )}
                          {/* ★2 확인 추천 코멘트 */}
                          {stars === 2 && (paper as any).aiReason && (
                            <div className="bg-orange-500/8 border border-orange-500/15 rounded-md px-3 py-2">
                              <p className="text-xs text-orange-300">
                                <span className="font-semibold">확인 추천</span> — {(paper as any).aiReason}
                              </p>
                            </div>
                          )}
                          {paper.aiSummary && (
                            <p className="text-sm text-text-main leading-relaxed">{paper.aiSummary}</p>
                          )}
                          {((paper as any).matchedKeywords || (paper as any).themes) && (
                            <p className="text-xs text-text-muted">
                              <span className="font-medium">키워드 매칭</span>: {((paper as any).matchedKeywords || (paper as any).themes || []).join(', ')}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {/* 기타 논문 섹션 (★1) */}
          {week.otherPapers.length > 0 && (
            <div className="bg-bg-card/60 rounded-xl border border-border/50 p-5">
              <h3 className="text-text-muted font-semibold text-base mb-2 flex items-center gap-1.5">
                <FileText className="w-4 h-4" /> 기타 논문 ({week.otherPapers.length}편)
              </h3>
              <p className="text-xs text-text-muted/70 mb-3">동향 파악용 — 키워드 매칭되었으나 직접 연관은 낮은 논문</p>
              <div className="space-y-1">
                {week.otherPapers.map(paper => {
                  const isOpen = expandedPapers.has(paper.id);
                  return (
                    <div key={paper.id}>
                      <button
                        onClick={() => togglePaper(paper.id)}
                        className="w-full flex items-center gap-2 text-left py-1.5 px-3 rounded-lg hover:bg-bg-hover/20 transition-colors"
                      >
                        {isOpen ? <ChevronDown className="w-3 h-3 text-text-muted/50 flex-shrink-0" /> : <ChevronRight className="w-3 h-3 text-text-muted/50 flex-shrink-0" />}
                        <span className="flex-1 min-w-0 text-sm text-text-muted truncate">{paper.title}</span>
                        <span className="text-xs text-text-muted/50 flex-shrink-0">({paper.journal})</span>
                        <span className="text-xs text-gray-500 flex-shrink-0 flex items-center gap-0.5"><StarRating count={1} className="text-gray-500" /> 참고</span>
                      </button>
                      {isOpen && (
                        <div className="ml-7 mb-2 pl-4 border-l-2 border-border/30 space-y-1.5">
                          <p className="text-xs text-text-muted">
                            {paper.journal}
                            {(paper as any).pubDate && <> | {new Date((paper as any).pubDate).toLocaleDateString('ko-KR')}</>}
                            {((paper as any).doi || paper.url) && <>
                              {' | '}<Link2 className="w-3 h-3 inline" />{' '}
                              {(paper as any).doi ? (
                                <a href={`https://doi.org/${(paper as any).doi}`} target="_blank" rel="noopener" className="text-primary hover:underline">논문 링크</a>
                              ) : paper.url ? (
                                <a href={paper.url} target="_blank" rel="noopener" className="text-primary hover:underline">링크</a>
                              ) : null}
                            </>}
                          </p>
                          {paper.aiSummary && <p className="text-xs text-text-muted/80">{paper.aiSummary}</p>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
