'use client';

/**
 * 📝 논문 파이프라인 — Notion 기반 view
 * - 🔴 내 차례 default (PI가 다음 액션 줘야 할 논문)
 * - 📋 진행 전체: 작성/심사 중/대응 중/억셉 4단계 Kanban
 * - 📚 게재 완료: KPI 헤더 + 연도별 (교신/공저 분리)
 *
 * Gmail 자동 감지가 매시간 단계/차례를 자동 갱신.
 * 사용자는 노션에서 직접 카드 추가/수정 가능 — 다음 sync에 반영됨.
 */
import { useState, useMemo } from 'react';
import { useApiData } from '@/lib/use-api';
import { useToast } from '@/components/Toast';
import {
  getManuscripts, syncManuscripts, scanManuscriptMail, getManuscriptKpi,
  switchManuscriptTurn, changeManuscriptStage,
  type Manuscript, type ManuscriptCounts, type ManuscriptKpi,
} from '@/lib/api';
import {
  BookOpen, RefreshCw, Mail, ExternalLink, Loader2, Inbox, AlertCircle, Plus,
  Award, TrendingUp, GraduationCap, Calendar, ArrowRight, FileText, CheckCircle2,
} from 'lucide-react';

type FilterTab = 'piTurn' | 'inProgress' | 'published';

const STAGE_COLOR: Record<Manuscript['stage'], string> = {
  '작성': 'bg-gray-500/15 text-gray-700 dark:text-gray-300 border-gray-500/30',
  '심사 중': 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30',
  '대응 중': 'bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30',
  '억셉': 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
  '게재 완료': 'bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/30',
};

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
}

function timeAgo(iso: string): string {
  const day = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (day === 0) return '오늘';
  if (day === 1) return '어제';
  if (day < 30) return `${day}일 전`;
  return new Date(iso).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

interface CardProps {
  m: Manuscript;
  onChangeTurn: (id: string, t: 'PI' | '학생' | '저널' | null) => void;
}

function ManuscriptCard({ m, onChangeTurn }: CardProps) {
  const dueSoon = m.revisionDueAt ? daysUntil(m.revisionDueAt) <= 7 : false;
  const dueDays = m.revisionDueAt ? daysUntil(m.revisionDueAt) : null;
  const isPiTurn = m.whoseTurn === 'PI';

  return (
    <article className={`bg-bg-card border rounded-lg p-3 md:p-4 hover:border-primary/30 transition-colors ${
      isPiTurn ? 'border-red-400/50 ring-1 ring-red-400/20' : 'border-border'
    }`}>
      <div className="flex flex-col gap-2.5">
        {/* 제목 + 단계 */}
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="text-base md:text-lg font-bold text-text-heading leading-snug tracking-tight break-words">
              {m.title}
            </h3>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1.5 text-xs md:text-sm text-text-muted">
              {m.firstAuthors && (
                <span className="inline-flex items-center gap-1">
                  <GraduationCap className="w-3.5 h-3.5" />{m.firstAuthors}
                </span>
              )}
              {m.currentJournal && (
                <span className="inline-flex items-center gap-1">
                  <BookOpen className="w-3.5 h-3.5" />{m.currentJournal}
                  {m.impactFactor !== null && <span className="text-text-muted/70">(IF {m.impactFactor})</span>}
                </span>
              )}
              {m.attempts && m.attempts > 1 && (
                <span className="text-[11px] px-1.5 py-0.5 bg-bg-input rounded">시도 #{m.attempts}</span>
              )}
              {m.piRole === '공저' && (
                <span className="text-[11px] px-1.5 py-0.5 bg-gray-500/10 text-gray-700 dark:text-gray-300 rounded">공저</span>
              )}
            </div>
          </div>
          <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border whitespace-nowrap flex-shrink-0 ${STAGE_COLOR[m.stage]}`}>
            {m.stage}
          </span>
        </div>

        {/* 차례 + 마감 + 메모 */}
        <div className="flex flex-wrap items-center gap-2">
          {m.whoseTurn === 'PI' && (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-bold bg-red-500/15 text-red-700 dark:text-red-300 border border-red-500/30">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
              내 차례
            </span>
          )}
          {m.whoseTurn === '학생' && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-yellow-500/10 text-yellow-700 dark:text-yellow-300 border border-yellow-500/30">
              🟢 학생 작업 중
            </span>
          )}
          {m.whoseTurn === '저널' && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-gray-500/10 text-gray-700 dark:text-gray-300 border border-gray-500/30">
              ⏸ 저널 응답 대기
            </span>
          )}
          {m.revisionDueAt && (
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
              dueSoon ? 'bg-red-500/15 text-red-700 dark:text-red-300 border border-red-500/30' : 'bg-bg-input text-text-muted'
            }`}>
              <Calendar className="w-3 h-3" />
              리비전 D{dueDays !== null && dueDays >= 0 ? `-${dueDays}` : `+${-(dueDays ?? 0)}`}
            </span>
          )}
          {m.rejectHistory && (
            <span className="text-[11px] text-text-muted/80 italic">
              거쳐온 저널: {m.rejectHistory}
            </span>
          )}
        </div>

        {m.lastActivityType && (
          <p className="text-xs text-text-muted">
            {m.lastActivityType} · {timeAgo(m.lastActivityAt)}
          </p>
        )}

        {m.memo && (
          <p className="text-xs text-text-muted bg-bg-input/40 rounded px-2 py-1.5 border-l-2 border-border line-clamp-2">
            {m.memo}
          </p>
        )}

        {/* 액션: 노션 열기 + 차례 토글 */}
        <div className="flex flex-wrap gap-1.5 pt-1">
          <a
            href={m.notionUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-1 px-2.5 py-1.5 bg-bg-input text-text-heading rounded-md text-xs font-medium hover:bg-bg-hover"
          >
            <ExternalLink className="w-3.5 h-3.5" /> 노션
          </a>
          {m.doi && (
            <a
              href={m.doi}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-1 px-2.5 py-1.5 bg-bg-input text-text-heading rounded-md text-xs font-medium hover:bg-bg-hover"
            >
              <FileText className="w-3.5 h-3.5" /> DOI
            </a>
          )}
          {/* 차례 토글 — 진행 중 (게재 완료 X) */}
          {m.stage !== '게재 완료' && m.stage !== '억셉' && (
            <>
              {m.whoseTurn !== '학생' && (
                <button
                  onClick={() => onChangeTurn(m.id, '학생')}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300 rounded-md text-xs font-medium hover:bg-yellow-500/20 border border-yellow-500/30"
                  title="학생 차례로"
                >
                  <ArrowRight className="w-3.5 h-3.5" /> 학생 차례로
                </button>
              )}
              {m.whoseTurn !== 'PI' && (
                <button
                  onClick={() => onChangeTurn(m.id, 'PI')}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-red-500/10 text-red-700 dark:text-red-300 rounded-md text-xs font-medium hover:bg-red-500/20 border border-red-500/30"
                  title="내 차례로"
                >
                  <ArrowRight className="w-3.5 h-3.5" /> 내 차례로
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </article>
  );
}

interface FilterPillProps {
  active: boolean;
  onClick: () => void;
  activeColor: string;
  children: React.ReactNode;
}

function FilterPill({ active, onClick, activeColor, children }: FilterPillProps) {
  const base = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-colors whitespace-nowrap';
  const idle = 'bg-bg-card text-text-muted border border-border hover:text-text-heading';
  return (
    <button onClick={onClick} className={`${base} ${active ? activeColor : idle}`}>
      {children}
    </button>
  );
}

export default function ManuscriptsPage() {
  const { toast } = useToast();
  const [filter, setFilter] = useState<FilterTab>('piTurn');
  const [syncing, setSyncing] = useState(false);
  const [scanning, setScanning] = useState(false);

  const { data, error, isLoading, mutate } = useApiData<{
    items: Manuscript[];
    counts: ManuscriptCounts;
  }>('manuscripts', () => getManuscripts());

  const kpi = useApiData<ManuscriptKpi>('manuscripts:kpi', () => getManuscriptKpi());

  const filtered = useMemo(() => {
    const items = data?.items ?? [];
    if (filter === 'piTurn') {
      return items.filter(m => m.whoseTurn === 'PI' && m.stage !== '게재 완료' && m.stage !== '억셉');
    }
    if (filter === 'inProgress') {
      return items.filter(m => m.stage !== '게재 완료');
    }
    return items.filter(m => m.stage === '게재 완료');
  }, [data?.items, filter]);

  // 진행 전체 → 단계별 컬럼 그룹
  const byStage = useMemo(() => {
    if (filter !== 'inProgress') return null;
    const groups: Record<Manuscript['stage'], Manuscript[]> = {
      '작성': [], '심사 중': [], '대응 중': [], '억셉': [], '게재 완료': [],
    };
    for (const m of filtered) groups[m.stage].push(m);
    return groups;
  }, [filtered, filter]);

  // 게재 완료 → 연도별 + 교신/공저
  const byYear = useMemo(() => {
    if (filter !== 'published') return null;
    const map = new Map<number, { corresponding: Manuscript[]; coAuthor: Manuscript[] }>();
    for (const m of filtered) {
      const year = m.publishedAt ? new Date(m.publishedAt).getFullYear() : 0;
      if (!map.has(year)) map.set(year, { corresponding: [], coAuthor: [] });
      const g = map.get(year)!;
      if (m.piRole === '교신') g.corresponding.push(m);
      else g.coAuthor.push(m);
    }
    return Array.from(map.entries()).sort((a, b) => b[0] - a[0]);
  }, [filtered, filter]);

  const counts = data?.counts;
  const handleTurn = async (id: string, turn: 'PI' | '학생' | '저널' | null) => {
    // Optimistic
    if (data) {
      mutate({ ...data, items: data.items.map(m => m.id === id ? { ...m, whoseTurn: turn } : m) }, { revalidate: false });
    }
    try {
      await switchManuscriptTurn(id, turn);
      toast(`차례 변경: ${turn || '없음'}`, 'success');
      mutate();
    } catch (e: any) {
      toast(`변경 실패: ${e.message}`, 'error');
      mutate();
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const r = await syncManuscripts();
      toast(`Sync: ${r.updated}편 갱신, ${r.errors} errors`, 'success');
      mutate();
      kpi.mutate();
    } catch (e: any) {
      toast(`Sync 실패: ${e.message}`, 'error');
    } finally {
      setSyncing(false);
    }
  };

  const handleScan = async () => {
    setScanning(true);
    try {
      const r = await scanManuscriptMail(90);
      const eventsList = Object.entries(r.events).map(([k, v]) => `${k} ${v}`).join(' / ');
      toast(`Gmail 스캔: ${r.scanned}건 (매칭 ${r.matched}, 미매칭 ${r.unmatched}) ${eventsList ? `· ${eventsList}` : ''}`, 'success');
      // sync도 같이
      await syncManuscripts();
      mutate();
    } catch (e: any) {
      toast(`스캔 실패: ${e.message}`, 'error');
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="min-h-full pb-20 md:pb-12">
      {/* 헤더 */}
      <div className="px-4 md:px-8 pt-4 md:pt-8 pb-4">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <span className="w-1 h-9 md:h-11 bg-primary rounded-full flex-shrink-0" />
            <div className="min-w-0">
              <h1 className="text-2xl md:text-3xl font-bold text-text-heading tracking-tight flex items-center gap-2 leading-tight">
                <BookOpen className="w-6 h-6 text-primary flex-shrink-0" /> 논문 파이프라인
              </h1>
              <p className="text-sm md:text-base text-text-muted mt-1">
                Notion 기반 진행/게재 통합 관리 · Gmail 자동 감지로 제출/리젝/리비전 갱신
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 self-start sm:self-auto">
            <button
              onClick={handleScan}
              disabled={scanning}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-bg-card border border-border rounded-lg text-sm hover:text-text-heading disabled:opacity-50 whitespace-nowrap"
              title="Gmail에서 최근 90일 논문 이메일 자동 감지"
            >
              <Mail className={`w-4 h-4 ${scanning ? 'animate-pulse' : ''}`} />
              {scanning ? '스캔 중…' : 'Gmail 감지'}
            </button>
            <button
              onClick={handleSync}
              disabled={syncing}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-bg-card border border-border rounded-lg text-sm hover:text-text-heading disabled:opacity-50 whitespace-nowrap"
            >
              <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? '동기화 중…' : '동기화'}
            </button>
          </div>
        </div>
      </div>

      {/* KPI 요약 — 게재 완료 탭에서만 강조, 다른 탭에서도 노출 */}
      {kpi.data && (
        <div className="px-4 md:px-8 pb-2">
          <div className="bg-bg-card border border-border rounded-xl p-3 md:p-4 grid grid-cols-2 sm:grid-cols-5 gap-3 md:gap-4">
            <KpiCell label="교신 누적" value={kpi.data.correspondingTotal} icon={<Award className="w-4 h-4 text-purple-500" />} />
            <KpiCell label="올해 교신" value={kpi.data.correspondingThisYear} icon={<TrendingUp className="w-4 h-4 text-emerald-500" />} />
            <KpiCell label="공저" value={kpi.data.coAuthorTotal} icon={<FileText className="w-4 h-4 text-blue-500" />} />
            <KpiCell label="평균 IF (교신)" value={kpi.data.avgImpactFactor} icon={<TrendingUp className="w-4 h-4 text-amber-500" />} />
            <KpiCell label="1저자 학생" value={kpi.data.uniqueFirstAuthors} icon={<GraduationCap className="w-4 h-4 text-primary" />} />
          </div>
        </div>
      )}

      {/* 필터 탭 */}
      <div className="px-4 md:px-8 pb-3 flex flex-wrap gap-2">
        <FilterPill
          active={filter === 'piTurn'}
          onClick={() => setFilter('piTurn')}
          activeColor="bg-red-500/15 text-red-700 dark:text-red-300 border border-red-500/30"
        >
          🔴 내 차례 {counts && <span className="font-bold">{counts.piTurn}</span>}
        </FilterPill>
        <FilterPill
          active={filter === 'inProgress'}
          onClick={() => setFilter('inProgress')}
          activeColor="bg-blue-500/15 text-blue-700 dark:text-blue-300 border border-blue-500/30"
        >
          📋 진행 전체 {counts && <span className="font-bold">{counts.writing + counts.review + counts.responding + counts.accepted}</span>}
        </FilterPill>
        <FilterPill
          active={filter === 'published'}
          onClick={() => setFilter('published')}
          activeColor="bg-purple-500/15 text-purple-700 dark:text-purple-300 border border-purple-500/30"
        >
          📚 게재 완료 {counts && <span className="font-bold">{counts.published}</span>}
        </FilterPill>
        {counts && counts.revisionDueSoon > 0 && (
          <span className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-orange-500/15 text-orange-700 dark:text-orange-300 border border-orange-500/30">
            <Calendar className="w-3.5 h-3.5" />
            리비전 D-7 {counts.revisionDueSoon}편
          </span>
        )}
      </div>

      {/* 콘텐츠 */}
      <div className="px-4 md:px-8 space-y-4">
        {error && (
          <div className="bg-red-500/10 text-red-400 px-4 py-3 rounded-lg text-sm flex items-center gap-2">
            <AlertCircle className="w-4 h-4" /> 데이터 로드 실패: {String(error)}
          </div>
        )}

        {isLoading && (
          <div className="space-y-3">
            {[0, 1, 2].map(i => (
              <div key={i} className="bg-bg-input/40 rounded-lg skeleton-shimmer h-24" />
            ))}
          </div>
        )}

        {!isLoading && filtered.length === 0 && (
          <EmptyState filter={filter} onSync={handleSync} syncing={syncing} />
        )}

        {/* 내 차례 / 게재 완료(연도별) / 진행 전체 (단계별) */}
        {!isLoading && filter === 'piTurn' && filtered.length > 0 && (
          <div className="space-y-3">
            {filtered.map(m => <ManuscriptCard key={m.id} m={m} onChangeTurn={handleTurn} />)}
          </div>
        )}

        {!isLoading && filter === 'inProgress' && byStage && (
          <div className="space-y-5">
            {(['작성', '심사 중', '대응 중', '억셉'] as const).map(stage => {
              const items = byStage[stage];
              if (items.length === 0) return null;
              return (
                <section key={stage}>
                  <h2 className="text-sm md:text-base font-bold text-text-heading flex items-center gap-2 mb-2">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs border ${STAGE_COLOR[stage]}`}>{stage}</span>
                    <span className="text-xs font-normal text-text-muted">({items.length})</span>
                  </h2>
                  <div className="space-y-2.5">
                    {items.map(m => <ManuscriptCard key={m.id} m={m} onChangeTurn={handleTurn} />)}
                  </div>
                </section>
              );
            })}
          </div>
        )}

        {!isLoading && filter === 'published' && byYear && (
          <div className="space-y-6">
            {byYear.map(([year, group]) => (
              <section key={year}>
                <h2 className="text-base md:text-lg font-bold text-text-heading mb-2 flex items-baseline gap-2">
                  {year || '연도 미상'}
                  <span className="text-sm font-normal text-text-muted">
                    교신 {group.corresponding.length} · 공저 {group.coAuthor.length}
                  </span>
                </h2>
                {group.corresponding.length > 0 && (
                  <div className="mb-3">
                    <h3 className="text-xs font-medium text-purple-700 dark:text-purple-300 mb-1.5">교신</h3>
                    <div className="space-y-2">
                      {group.corresponding.map(m => <PublishedRow key={m.id} m={m} />)}
                    </div>
                  </div>
                )}
                {group.coAuthor.length > 0 && (
                  <div>
                    <h3 className="text-xs font-medium text-blue-700 dark:text-blue-300 mb-1.5">공저</h3>
                    <div className="space-y-2">
                      {group.coAuthor.map(m => <PublishedRow key={m.id} m={m} />)}
                    </div>
                  </div>
                )}
              </section>
            ))}
          </div>
        )}

        {/* 안내 — 노션에서 직접 추가 */}
        <p className="text-xs text-text-muted/70 text-center pt-4">
          새 논문 추가/수정은{' '}
          <a
            href="https://www.notion.so/06e9070b661d4d7d829f3aed16dda560"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            노션 DB
          </a>
          에서 직접 진행하면 매시간 sync로 자동 반영됩니다
        </p>
      </div>
    </div>
  );
}

function KpiCell({ label, value, icon }: { label: string; value: number | string; icon: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1 text-[11px] text-text-muted">{icon}{label}</div>
      <div className="text-lg md:text-xl font-bold text-text-heading mt-0.5">{value}</div>
    </div>
  );
}

function PublishedRow({ m }: { m: Manuscript }) {
  return (
    <article className="bg-bg-card border border-border rounded-lg px-3 py-2 hover:border-primary/30 transition-colors">
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-text-heading line-clamp-1">{m.title}</p>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5 text-xs text-text-muted">
            {m.firstAuthors && <span>👤 {m.firstAuthors}</span>}
            {m.currentJournal && <span className="font-medium">· {m.currentJournal}</span>}
            {m.impactFactor !== null && <span>(IF {m.impactFactor})</span>}
          </div>
        </div>
        <div className="flex gap-1.5 flex-shrink-0">
          <a href={m.notionUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 px-2 py-1 bg-bg-input rounded text-xs hover:bg-bg-hover">
            <ExternalLink className="w-3 h-3" /> 노션
          </a>
          {m.doi && (
            <a href={m.doi} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 px-2 py-1 bg-bg-input rounded text-xs hover:bg-bg-hover">
              <FileText className="w-3 h-3" /> DOI
            </a>
          )}
        </div>
      </div>
    </article>
  );
}

function EmptyState({ filter, onSync, syncing }: { filter: FilterTab; onSync: () => void; syncing: boolean }) {
  let title = '';
  let desc = '';
  if (filter === 'piTurn') {
    title = '내 차례인 논문이 없습니다 🎉';
    desc = '학생들의 작업이나 저널 응답을 기다리는 중입니다.';
  } else if (filter === 'inProgress') {
    title = '진행 중인 논문이 없습니다';
    desc = '노션 DB에 논문을 추가하고 [동기화]를 눌러주세요.';
  } else {
    title = '게재 완료 논문이 없습니다';
    desc = '노션 DB에 publication을 추가하면 여기 표시됩니다.';
  }
  return (
    <div className="bg-bg-card border border-border rounded-lg p-8 md:p-10 text-center">
      <Inbox className="w-10 h-10 text-text-muted/30 mx-auto mb-3" />
      <p className="text-text-heading font-semibold mb-1">{title}</p>
      <p className="text-text-muted text-sm mb-4">{desc}</p>
      <div className="flex justify-center gap-2">
        <a
          href="https://www.notion.so/06e9070b661d4d7d829f3aed16dda560"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 px-3 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90"
        >
          <Plus className="w-4 h-4" /> 노션에서 추가
        </a>
        <button
          onClick={onSync}
          disabled={syncing}
          className="inline-flex items-center gap-1.5 px-3 py-2 bg-bg-input rounded-lg text-sm font-medium hover:bg-bg-hover disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} /> 동기화
        </button>
      </div>
    </div>
  );
}
