'use client';

/**
 * 📝 논문 파이프라인 — 한 줄 카드 + 토글 펼침 (MindNode 스타일)
 * - 4 탭: 준비중 / 제출 / 리비전 / 게재 완료
 * - 모든 카드 default collapsed (한 줄). 클릭하면 자세한 정보 펼침
 * - 게재 완료 = 연도별 토글 (2023+ 만)
 */
import { useState, useMemo, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { mutate as globalMutate } from 'swr';
import { useApiData } from '@/lib/use-api';
import { useToast } from '@/components/Toast';
import {
  getManuscripts, syncManuscripts, scanManuscriptMail, getManuscriptKpi,
  type Manuscript, type ManuscriptCounts, type ManuscriptKpi,
} from '@/lib/api';
import {
  BookOpen, RefreshCw, Mail, Inbox, AlertCircle, Plus,
  Award, TrendingUp, GraduationCap, FileText, ChevronRight, ChevronDown,
} from 'lucide-react';
import { ManuscriptRow } from './ManuscriptRow';
import { TAB_TO_STAGES, TAB_LABEL, TAB_COLOR, stageToTab, type TabKey } from './types';
import { SIDEBAR_COUNT_KEYS } from '../Sidebar';

// EditModal — 모달 첫 마운트 시 lazy load (bundle ↓)
const EditModal = dynamic(() => import('./EditModal').then(m => m.EditModal), { ssr: false, loading: () => null });

const TAB_KEYS: TabKey[] = ['preparing', 'submitted', 'revision', 'published'];

const EMPTY_MSG: Record<TabKey, { title: string; desc: string }> = {
  preparing: { title: '준비 중인 논문이 없습니다', desc: '노션에서 새 논문을 추가하세요.' },
  submitted: { title: '제출된 논문이 없습니다', desc: 'Gmail 감지로 자동 채워집니다.' },
  revision: { title: '리비전 중인 논문이 없습니다 🎉', desc: '저널 응답을 기다리는 중입니다.' },
  published: { title: '게재 완료 논문이 없습니다', desc: '노션에 publication을 추가하세요.' },
};

const NOTION_DB_URL = 'https://www.notion.so/06e9070b661d4d7d829f3aed16dda560';

const Kpi = ({ label, value, icon }: { label: string; value: number | string; icon: React.ReactNode }) => (
  <div className="flex flex-col">
    <div className="flex items-center gap-1 text-[10px] text-text-muted">{icon}{label}</div>
    <div className="text-base md:text-lg font-bold text-text-heading mt-0.5">{value}</div>
  </div>
);

export default function ManuscriptsPage() {
  const { toast } = useToast();
  const [tab, setTab] = useState<TabKey>('preparing');
  const [syncing, setSyncing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [collapsedYears, setCollapsedYears] = useState<Set<number>>(new Set());
  const [editTarget, setEditTarget] = useState<Manuscript | null>(null);

  const { data, error, isLoading, mutate } = useApiData<{
    items: Manuscript[]; counts: ManuscriptCounts;
  }>('manuscripts', () => getManuscripts());
  const kpi = useApiData<ManuscriptKpi>('manuscripts:kpi', () => getManuscriptKpi());

  // useMemo 의존성 안정화 — data?.items가 같으면 같은 배열 reference 유지
  const allItems = useMemo(() => data?.items ?? [], [data?.items]);
  const items = useMemo(() => allItems.filter(m => TAB_TO_STAGES[tab].includes(m.stage)), [allItems, tab]);

  const publishedByYear = useMemo(() => {
    if (tab !== 'published') return null;
    const map = new Map<number, { corresponding: Manuscript[]; coAuthor: Manuscript[] }>();
    for (const m of items) {
      const year = m.publishedAt ? new Date(m.publishedAt).getFullYear() : 0;
      if (!map.has(year)) map.set(year, { corresponding: [], coAuthor: [] });
      const g = map.get(year)!;
      if (m.piRole === '교신') g.corresponding.push(m); else g.coAuthor.push(m);
    }
    return Array.from(map.entries()).sort((a, b) => b[0] - a[0]);
  }, [items, tab]);

  const tabCounts = useMemo(() => {
    const c: Record<TabKey, number> = { preparing: 0, submitted: 0, revision: 0, published: 0 };
    for (const m of allItems) c[stageToTab(m.stage)]++;
    return c;
  }, [allItems]);

  // useCallback — Set 토글 함수 안정화 (ManuscriptRow memo의 prop reference 유지)
  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }, []);
  const toggleYear = useCallback((year: number) => {
    setCollapsedYears(prev => { const n = new Set(prev); n.has(year) ? n.delete(year) : n.add(year); return n; });
  }, []);
  const handleEdit = useCallback((m: Manuscript) => setEditTarget(m), []);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const r = await syncManuscripts();
      toast(`Sync: ${r.updated}편 갱신`, 'success');
      mutate(); kpi.mutate();
      globalMutate(SIDEBAR_COUNT_KEYS.manuscripts);
    } catch (e: any) { toast(`Sync 실패: ${e.message}`, 'error'); }
    finally { setSyncing(false); }
  };

  const handleScan = async () => {
    setScanning(true);
    try {
      const r = await scanManuscriptMail(90);
      const events = Object.entries(r.events).map(([k, v]) => `${k} ${v}`).join(' / ');
      toast(`Gmail: ${r.scanned}건 (매칭 ${r.matched}, 미매칭 ${r.unmatched}) ${events}`, 'success');
      await syncManuscripts();
      mutate();
    } catch (e: any) { toast(`스캔 실패: ${e.message}`, 'error'); }
    finally { setScanning(false); }
  };

  const renderRow = (m: Manuscript) => (
    <ManuscriptRow key={m.id} m={m} expanded={expandedIds.has(m.id)}
      onToggle={() => toggleExpanded(m.id)} onEdit={() => handleEdit(m)} showStage={false} />
  );

  return (
    <div className="min-h-full pb-20 md:pb-12">
      {/* 헤더 */}
      <div className="px-4 md:px-8 pt-4 md:pt-8 pb-3">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <span className="w-1 h-9 md:h-11 bg-primary rounded-full flex-shrink-0" />
            <div className="min-w-0">
              <h1 className="text-2xl md:text-3xl font-bold text-text-heading tracking-tight flex items-center gap-2 leading-tight">
                <BookOpen className="w-6 h-6 text-primary flex-shrink-0" /> 논문 파이프라인
              </h1>
              <p className="text-sm md:text-base text-text-muted mt-1">Notion 기반 한눈에 보기 · Gmail 자동 감지로 단계 갱신</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 self-start sm:self-auto">
            <button onClick={handleScan} disabled={scanning}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-bg-card border border-border rounded-lg text-sm hover:text-text-heading disabled:opacity-50 whitespace-nowrap">
              <Mail className={`w-4 h-4 ${scanning ? 'animate-pulse' : ''}`} />{scanning ? '스캔 중…' : 'Gmail'}
            </button>
            <button onClick={handleSync} disabled={syncing}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-bg-card border border-border rounded-lg text-sm hover:text-text-heading disabled:opacity-50 whitespace-nowrap">
              <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />{syncing ? '동기화 중…' : '동기화'}
            </button>
          </div>
        </div>
      </div>

      {/* KPI — 게재 완료 탭에서만 강조 노출 */}
      {tab === 'published' && kpi.data && (
        <div className="px-4 md:px-8 pb-2">
          <div className="bg-bg-card border border-border rounded-lg p-3 grid grid-cols-2 sm:grid-cols-5 gap-3">
            <Kpi label="교신 누적" value={kpi.data.correspondingTotal} icon={<Award className="w-3.5 h-3.5 text-purple-500" />} />
            <Kpi label="올해 교신" value={kpi.data.correspondingThisYear} icon={<TrendingUp className="w-3.5 h-3.5 text-emerald-500" />} />
            <Kpi label="공저" value={kpi.data.coAuthorTotal} icon={<FileText className="w-3.5 h-3.5 text-blue-500" />} />
            <Kpi label="평균 IF (교신)" value={kpi.data.avgImpactFactor} icon={<TrendingUp className="w-3.5 h-3.5 text-amber-500" />} />
            <Kpi label="1저자 학생" value={kpi.data.uniqueFirstAuthors} icon={<GraduationCap className="w-3.5 h-3.5 text-primary" />} />
          </div>
        </div>
      )}

      {/* 4 탭 */}
      <div className="px-4 md:px-8 pb-3 flex flex-wrap gap-2">
        {TAB_KEYS.map(k => (
          <button key={k} onClick={() => setTab(k)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-colors whitespace-nowrap ${
              tab === k ? TAB_COLOR[k] : 'bg-bg-card text-text-muted border border-border hover:text-text-heading'
            }`}>
            {TAB_LABEL[k]} <span className="font-bold">{tabCounts[k]}</span>
          </button>
        ))}
      </div>

      {/* 콘텐츠 */}
      <div className="px-4 md:px-8 space-y-2">
        {error && (
          <div className="bg-red-500/10 text-red-400 px-4 py-3 rounded-lg text-sm flex items-center gap-2">
            <AlertCircle className="w-4 h-4" /> 데이터 로드 실패: {String(error)}
          </div>
        )}

        {isLoading && (
          <div className="space-y-2">
            {[0, 1, 2, 3, 4].map(i => <div key={i} className="bg-bg-input/40 rounded-lg skeleton-shimmer h-9" />)}
          </div>
        )}

        {!isLoading && items.length === 0 && (
          <div className="bg-bg-card border border-border rounded-lg p-6 md:p-8 text-center">
            <Inbox className="w-8 h-8 text-text-muted/30 mx-auto mb-2" />
            <p className="text-text-heading font-medium text-sm">{EMPTY_MSG[tab].title}</p>
            <p className="text-text-muted text-xs mb-3">{EMPTY_MSG[tab].desc}</p>
            <div className="flex justify-center gap-2">
              <a href={NOTION_DB_URL} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary text-white rounded-md text-xs font-medium hover:bg-primary/90">
                <Plus className="w-3.5 h-3.5" /> 노션 추가
              </a>
              <button onClick={handleSync} disabled={syncing}
                className="inline-flex items-center gap-1 px-3 py-1.5 bg-bg-input rounded-md text-xs font-medium hover:bg-bg-hover disabled:opacity-50">
                <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} /> 동기화
              </button>
            </div>
          </div>
        )}

        {/* 일반 탭 (준비중/제출/리비전) — 단순 list */}
        {!isLoading && tab !== 'published' && items.length > 0 && (
          <div className="space-y-1.5">{items.map(renderRow)}</div>
        )}

        {/* 게재 완료 — 연도별 토글 */}
        {!isLoading && tab === 'published' && publishedByYear && publishedByYear.length > 0 && (
          <div className="space-y-2">
            {publishedByYear.map(([year, group]) => {
              const collapsed = collapsedYears.has(year);
              const total = group.corresponding.length + group.coAuthor.length;
              return (
                <section key={year} className="bg-bg-card border border-border rounded-lg overflow-hidden">
                  <button onClick={() => toggleYear(year)} className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-bg-hover/50 text-left">
                    {collapsed ? <ChevronRight className="w-4 h-4 text-text-muted" /> : <ChevronDown className="w-4 h-4 text-text-muted" />}
                    <span className="text-base font-bold text-text-heading">{year || '연도 미상'}</span>
                    <span className="text-xs text-text-muted">{total}편 · 교신 {group.corresponding.length} · 공저 {group.coAuthor.length}</span>
                  </button>
                  {!collapsed && (
                    <div className="px-3 pb-3 space-y-1.5">
                      {group.corresponding.length > 0 && (
                        <div>
                          <h3 className="text-[10px] font-semibold text-purple-700 dark:text-purple-300 uppercase tracking-wider px-1 py-1">교신 ({group.corresponding.length})</h3>
                          <div className="space-y-1">{group.corresponding.map(renderRow)}</div>
                        </div>
                      )}
                      {group.coAuthor.length > 0 && (
                        <div>
                          <h3 className="text-[10px] font-semibold text-blue-700 dark:text-blue-300 uppercase tracking-wider px-1 py-1 mt-2">공저 ({group.coAuthor.length})</h3>
                          <div className="space-y-1">{group.coAuthor.map(renderRow)}</div>
                        </div>
                      )}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}

        <p className="text-[11px] text-text-muted/70 text-center pt-3">
          카드의 [편집] 버튼으로 직접 수정 가능 · 또는{' '}
          <a href={NOTION_DB_URL} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">노션 DB</a>에서 편집 (매시간 sync)
        </p>
      </div>

      {editTarget && <EditModal m={editTarget} onClose={() => setEditTarget(null)} onSaved={() => { mutate(); kpi.mutate(); }} />}
    </div>
  );
}
