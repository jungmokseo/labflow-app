'use client';

/**
 * 📝 논문 파이프라인 — 한 줄 카드 + 토글 펼침 (MindNode 스타일)
 * - 4 탭: 준비중 / 제출 / 리비전 / 게재 완료
 * - 모든 카드 default collapsed (한 줄). 클릭하면 자세한 정보 펼침
 * - 게재 완료 = 연도별 토글 (2023+ 만)
 */
import { useState, useMemo } from 'react';
import { useApiData } from '@/lib/use-api';
import { useToast } from '@/components/Toast';
import {
  getManuscripts, syncManuscripts, scanManuscriptMail, getManuscriptKpi,
  updateManuscript,
  type Manuscript, type ManuscriptCounts, type ManuscriptKpi, type ManuscriptUpdatePayload,
} from '@/lib/api';
import {
  BookOpen, RefreshCw, Mail, ExternalLink, Loader2, Inbox, AlertCircle, Plus,
  Award, TrendingUp, GraduationCap, Calendar, FileText, ChevronRight, ChevronDown, Pencil, X,
} from 'lucide-react';

type TabKey = 'preparing' | 'submitted' | 'revision' | 'published';

// 단계 → 탭 매핑 (단계 5종을 4 탭에 분배)
const TAB_TO_STAGES: Record<TabKey, Manuscript['stage'][]> = {
  preparing: ['작성'],
  submitted: ['심사 중', '억셉'],
  revision: ['대응 중'],
  published: ['게재 완료'],
};

const TAB_LABEL: Record<TabKey, string> = {
  preparing: '준비중',
  submitted: '제출',
  revision: '리비전',
  published: '게재 완료',
};

const TAB_COLOR: Record<TabKey, string> = {
  preparing: 'bg-gray-500/15 text-gray-700 dark:text-gray-300 border-gray-500/30',
  submitted: 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30',
  revision: 'bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30',
  published: 'bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/30',
};

function fmtDate(iso: string | null): string {
  if (!iso) return '';
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

interface RowProps {
  m: Manuscript;
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  showStage?: boolean;
}

/** 한 줄 카드 — collapsed/expanded toggle */
function ManuscriptRow({ m, expanded, onToggle, onEdit, showStage = true }: RowProps) {
  const dueDays = m.revisionDueAt ? daysUntil(m.revisionDueAt) : null;
  const dueSoon = dueDays !== null && dueDays <= 7 && dueDays >= 0;
  const overdue = dueDays !== null && dueDays < 0;

  return (
    <article className="bg-bg-card border border-border rounded-lg hover:border-primary/30 transition-colors">
      {/* 한 줄 헤더 — 클릭 시 토글 */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
      >
        <span className="text-text-muted flex-shrink-0">
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </span>
        <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-text-heading truncate">
            {m.title}
          </span>
          {m.firstAuthors && (
            <span className="text-xs text-text-muted flex-shrink-0">— {m.firstAuthors}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {m.currentJournal && (
            <span className="hidden sm:inline-block text-[11px] px-1.5 py-0.5 bg-bg-input rounded text-text-muted max-w-[140px] truncate">
              {m.currentJournal}
            </span>
          )}
          {m.impactFactor !== null && (
            <span className="hidden md:inline-block text-[11px] text-text-muted/70">IF {m.impactFactor}</span>
          )}
          {m.attempts && m.attempts > 1 && (
            <span className="text-[10px] px-1.5 py-0.5 bg-amber-500/10 text-amber-700 dark:text-amber-300 rounded">#{m.attempts}</span>
          )}
          {dueDays !== null && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium whitespace-nowrap ${
              overdue ? 'bg-red-500/20 text-red-700 dark:text-red-300' :
              dueSoon ? 'bg-orange-500/15 text-orange-700 dark:text-orange-300' :
              'bg-bg-input text-text-muted'
            }`}>
              {overdue ? `D+${-dueDays}` : `D-${dueDays}`}
            </span>
          )}
          {m.piRole === '공저' && (
            <span className="text-[10px] px-1.5 py-0.5 bg-gray-500/10 text-gray-700 dark:text-gray-300 rounded">공저</span>
          )}
          {showStage && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded border whitespace-nowrap ${TAB_COLOR[stageToTab(m.stage)]}`}>
              {m.stage}
            </span>
          )}
        </div>
      </button>

      {/* 펼친 자세한 정보 */}
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-border/60 space-y-2 text-xs text-text-main">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1.5 pt-2">
            {m.currentJournal && (
              <Field label="저널">
                {m.currentJournal}
                {m.impactFactor !== null && <span className="text-text-muted ml-1">(IF {m.impactFactor})</span>}
              </Field>
            )}
            {m.manuscriptNum && <Field label="Manuscript ID" mono>{m.manuscriptNum}</Field>}
            {m.attempts && m.attempts > 1 && <Field label="시도 횟수">#{m.attempts}</Field>}
            {m.submittedAt && <Field label="제출일">{fmtDate(m.submittedAt)}</Field>}
            {m.revisionDueAt && (
              <Field label="리비전 마감">
                <span className={overdue ? 'text-red-600' : dueSoon ? 'text-orange-600' : ''}>
                  {fmtDate(m.revisionDueAt)} {dueDays !== null && `(${overdue ? `D+${-dueDays}` : `D-${dueDays}`})`}
                </span>
              </Field>
            )}
            {m.publishedAt && <Field label="게재일">{fmtDate(m.publishedAt)}</Field>}
            {m.piRole && <Field label="PI 역할">{m.piRole}</Field>}
            {m.lastActivityType && (
              <Field label="마지막 활동">
                {m.lastActivityType} · <span className="text-text-muted">{timeAgo(m.lastActivityAt)}</span>
              </Field>
            )}
          </div>
          {m.rejectHistory && (
            <div>
              <p className="text-[10px] text-text-muted uppercase tracking-wider mb-0.5">거쳐온 저널</p>
              <p className="italic text-text-muted">{m.rejectHistory}</p>
            </div>
          )}
          {m.memo && (
            <div>
              <p className="text-[10px] text-text-muted uppercase tracking-wider mb-0.5">메모</p>
              <p className="text-text-muted whitespace-pre-line">{m.memo}</p>
            </div>
          )}
          <div className="flex flex-wrap gap-1.5 pt-1">
            <button
              onClick={e => { e.stopPropagation(); onEdit(); }}
              className="inline-flex items-center gap-1 px-2.5 py-1 bg-primary text-white rounded text-[11px] font-medium hover:bg-primary/90"
            >
              <Pencil className="w-3 h-3" /> 편집
            </button>
            <a
              href={m.notionUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              className="inline-flex items-center gap-1 px-2.5 py-1 bg-bg-input rounded text-[11px] font-medium hover:bg-bg-hover"
            >
              <ExternalLink className="w-3 h-3" /> 노션 열기
            </a>
            {m.doi && (
              <a
                href={m.doi}
                target="_blank"
                rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                className="inline-flex items-center gap-1 px-2.5 py-1 bg-bg-input rounded text-[11px] font-medium hover:bg-bg-hover"
              >
                <FileText className="w-3 h-3" /> DOI
              </a>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

/** 편집 modal — 모든 필드 in-place 수정 (DB + 노션 동시 갱신) */
function EditModal({ m, onClose, onSaved }: { m: Manuscript; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  // 폼 state — 빈 문자열은 null로 변환해서 저장
  const [form, setForm] = useState({
    title: m.title || '',
    stage: m.stage,
    whoseTurn: (m.whoseTurn || '') as '' | 'PI' | '학생' | '저널',
    firstAuthors: m.firstAuthors || '',
    piRole: (m.piRole || '') as '' | '교신' | '공저',
    currentJournal: m.currentJournal || '',
    impactFactor: m.impactFactor !== null ? String(m.impactFactor) : '',
    attempts: m.attempts !== null ? String(m.attempts) : '',
    rejectHistory: m.rejectHistory || '',
    manuscriptNum: m.manuscriptNum || '',
    submittedAt: m.submittedAt ? m.submittedAt.slice(0, 10) : '',
    revisionDueAt: m.revisionDueAt ? m.revisionDueAt.slice(0, 10) : '',
    publishedAt: m.publishedAt ? m.publishedAt.slice(0, 10) : '',
    doi: m.doi || '',
    memo: m.memo || '',
  });

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload: ManuscriptUpdatePayload = {
        title: form.title.trim(),
        stage: form.stage,
        whoseTurn: form.whoseTurn || null,
        firstAuthors: form.firstAuthors.trim() || null,
        piRole: form.piRole || null,
        currentJournal: form.currentJournal.trim() || null,
        impactFactor: form.impactFactor ? Number(form.impactFactor) : null,
        attempts: form.attempts ? Number(form.attempts) : null,
        rejectHistory: form.rejectHistory.trim() || null,
        manuscriptNum: form.manuscriptNum.trim() || null,
        submittedAt: form.submittedAt || null,
        revisionDueAt: form.revisionDueAt || null,
        publishedAt: form.publishedAt || null,
        doi: form.doi.trim() || null,
        memo: form.memo.trim() || null,
      };
      const r = await updateManuscript(m.id, payload);
      toast(r.notionUpdated ? '저장 완료 · 노션 갱신' : '저장 완료 (노션 갱신 실패 — 다음 sync에서 재시도)', 'success');
      onSaved();
      onClose();
    } catch (e: any) {
      toast(`저장 실패: ${e.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-3 md:p-4"
      onClick={onClose}
    >
      <div
        className="bg-bg-card rounded-2xl shadow-xl border border-border w-full max-w-2xl max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border sticky top-0 bg-bg-card">
          <h3 className="text-base md:text-lg font-bold text-text-heading flex items-center gap-2">
            <Pencil className="w-4 h-4" /> 논문 편집
          </h3>
          <button onClick={onClose} className="p-1 hover:bg-bg-hover rounded-lg">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <FormField label="제목">
            <input
              value={form.title}
              onChange={e => setForm({ ...form, title: e.target.value })}
              className="w-full px-3 py-2 bg-bg-input border border-border rounded-lg text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </FormField>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FormField label="단계">
              <select
                value={form.stage}
                onChange={e => setForm({ ...form, stage: e.target.value as Manuscript['stage'] })}
                className="w-full px-3 py-2 bg-bg-input border border-border rounded-lg text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="작성">작성 (준비중)</option>
                <option value="심사 중">심사 중 (제출됨)</option>
                <option value="대응 중">대응 중 (리비전)</option>
                <option value="억셉">억셉</option>
                <option value="게재 완료">게재 완료</option>
              </select>
            </FormField>
            <FormField label="차례">
              <select
                value={form.whoseTurn}
                onChange={e => setForm({ ...form, whoseTurn: e.target.value as any })}
                className="w-full px-3 py-2 bg-bg-input border border-border rounded-lg text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="">없음</option>
                <option value="PI">PI</option>
                <option value="학생">학생</option>
                <option value="저널">저널</option>
              </select>
            </FormField>
          </div>

          <FormField label="1저자 학생 (콤마 구분 — 여러명 가능)">
            <input
              value={form.firstAuthors}
              onChange={e => setForm({ ...form, firstAuthors: e.target.value })}
              placeholder="예: 김수아, 윤민"
              className="w-full px-3 py-2 bg-bg-input border border-border rounded-lg text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </FormField>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FormField label="PI 역할">
              <select
                value={form.piRole}
                onChange={e => setForm({ ...form, piRole: e.target.value as any })}
                className="w-full px-3 py-2 bg-bg-input border border-border rounded-lg text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="">미지정</option>
                <option value="교신">교신</option>
                <option value="공저">공저</option>
              </select>
            </FormField>
            <FormField label="현재/타겟 저널">
              <input
                value={form.currentJournal}
                onChange={e => setForm({ ...form, currentJournal: e.target.value })}
                placeholder="예: Advanced Materials"
                className="w-full px-3 py-2 bg-bg-input border border-border rounded-lg text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </FormField>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <FormField label="Impact Factor">
              <input
                type="number"
                step="0.1"
                value={form.impactFactor}
                onChange={e => setForm({ ...form, impactFactor: e.target.value })}
                className="w-full px-3 py-2 bg-bg-input border border-border rounded-lg text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </FormField>
            <FormField label="시도 횟수">
              <input
                type="number"
                min="1"
                value={form.attempts}
                onChange={e => setForm({ ...form, attempts: e.target.value })}
                className="w-full px-3 py-2 bg-bg-input border border-border rounded-lg text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </FormField>
            <FormField label="Manuscript ID">
              <input
                value={form.manuscriptNum}
                onChange={e => setForm({ ...form, manuscriptNum: e.target.value })}
                placeholder="nn-2026-..."
                className="w-full px-3 py-2 bg-bg-input border border-border rounded-lg text-sm font-mono text-text-heading focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </FormField>
          </div>

          <FormField label="리젝 이력">
            <input
              value={form.rejectHistory}
              onChange={e => setForm({ ...form, rejectHistory: e.target.value })}
              placeholder="예: Nano Today (2026-04 reject)"
              className="w-full px-3 py-2 bg-bg-input border border-border rounded-lg text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </FormField>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <FormField label="제출일">
              <input
                type="date"
                value={form.submittedAt}
                onChange={e => setForm({ ...form, submittedAt: e.target.value })}
                className="w-full px-3 py-2 bg-bg-input border border-border rounded-lg text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </FormField>
            <FormField label="리비전 마감">
              <input
                type="date"
                value={form.revisionDueAt}
                onChange={e => setForm({ ...form, revisionDueAt: e.target.value })}
                className="w-full px-3 py-2 bg-bg-input border border-border rounded-lg text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </FormField>
            <FormField label="게재일">
              <input
                type="date"
                value={form.publishedAt}
                onChange={e => setForm({ ...form, publishedAt: e.target.value })}
                className="w-full px-3 py-2 bg-bg-input border border-border rounded-lg text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </FormField>
          </div>

          <FormField label="DOI">
            <input
              value={form.doi}
              onChange={e => setForm({ ...form, doi: e.target.value })}
              placeholder="https://doi.org/10..."
              className="w-full px-3 py-2 bg-bg-input border border-border rounded-lg text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </FormField>

          <FormField label="메모">
            <textarea
              value={form.memo}
              onChange={e => setForm({ ...form, memo: e.target.value })}
              rows={3}
              className="w-full px-3 py-2 bg-bg-input border border-border rounded-lg text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary resize-none"
            />
          </FormField>
        </div>
        <div className="flex gap-2 p-4 border-t border-border sticky bottom-0 bg-bg-card">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 rounded-lg border border-border text-sm hover:bg-bg-hover"
          >
            취소
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {saving ? '저장 중…' : '저장'}
          </button>
        </div>
      </div>
    </div>
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-text-muted uppercase tracking-wider mb-1">{label}</label>
      {children}
    </div>
  );
}

function stageToTab(stage: Manuscript['stage']): TabKey {
  for (const [tab, stages] of Object.entries(TAB_TO_STAGES) as [TabKey, Manuscript['stage'][]][]) {
    if (stages.includes(stage)) return tab;
  }
  return 'preparing';
}

function Field({ label, children, mono = false }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <p className="text-[10px] text-text-muted uppercase tracking-wider">{label}</p>
      <p className={`text-text-heading ${mono ? 'font-mono text-[11px]' : ''}`}>{children}</p>
    </div>
  );
}

interface TabPillProps {
  active: boolean;
  onClick: () => void;
  color: string;
  children: React.ReactNode;
}

function TabPill({ active, onClick, color, children }: TabPillProps) {
  const base = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-colors whitespace-nowrap';
  const idle = 'bg-bg-card text-text-muted border border-border hover:text-text-heading';
  return (
    <button onClick={onClick} className={`${base} ${active ? color : idle}`}>
      {children}
    </button>
  );
}

export default function ManuscriptsPage() {
  const { toast } = useToast();
  const [tab, setTab] = useState<TabKey>('preparing');
  const [syncing, setSyncing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [collapsedYears, setCollapsedYears] = useState<Set<number>>(new Set());
  const [editTarget, setEditTarget] = useState<Manuscript | null>(null);

  const { data, error, isLoading, mutate } = useApiData<{
    items: Manuscript[];
    counts: ManuscriptCounts;
  }>('manuscripts', () => getManuscripts());

  const kpi = useApiData<ManuscriptKpi>('manuscripts:kpi', () => getManuscriptKpi());

  // 현재 탭에 해당하는 항목
  const items = useMemo(() => {
    const all = data?.items ?? [];
    return all.filter(m => TAB_TO_STAGES[tab].includes(m.stage));
  }, [data?.items, tab]);

  // 게재 완료 탭 — 연도별 그룹 (최근 → 오래된)
  const publishedByYear = useMemo(() => {
    if (tab !== 'published') return null;
    const map = new Map<number, { corresponding: Manuscript[]; coAuthor: Manuscript[] }>();
    for (const m of items) {
      const year = m.publishedAt ? new Date(m.publishedAt).getFullYear() : 0;
      if (!map.has(year)) map.set(year, { corresponding: [], coAuthor: [] });
      const g = map.get(year)!;
      if (m.piRole === '교신') g.corresponding.push(m);
      else g.coAuthor.push(m);
    }
    return Array.from(map.entries()).sort((a, b) => b[0] - a[0]);
  }, [items, tab]);

  // 탭별 카운트
  const tabCounts = useMemo(() => {
    const all = data?.items ?? [];
    const counts: Record<TabKey, number> = { preparing: 0, submitted: 0, revision: 0, published: 0 };
    for (const m of all) counts[stageToTab(m.stage)]++;
    return counts;
  }, [data?.items]);

  const toggleExpanded = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleYear = (year: number) => {
    setCollapsedYears(prev => {
      const next = new Set(prev);
      if (next.has(year)) next.delete(year); else next.add(year);
      return next;
    });
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const r = await syncManuscripts();
      toast(`Sync: ${r.updated}편 갱신`, 'success');
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
      const events = Object.entries(r.events).map(([k, v]) => `${k} ${v}`).join(' / ');
      toast(`Gmail: ${r.scanned}건 (매칭 ${r.matched}, 미매칭 ${r.unmatched}) ${events}`, 'success');
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
      <div className="px-4 md:px-8 pt-4 md:pt-8 pb-3">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <span className="w-1 h-9 md:h-11 bg-primary rounded-full flex-shrink-0" />
            <div className="min-w-0">
              <h1 className="text-2xl md:text-3xl font-bold text-text-heading tracking-tight flex items-center gap-2 leading-tight">
                <BookOpen className="w-6 h-6 text-primary flex-shrink-0" /> 논문 파이프라인
              </h1>
              <p className="text-sm md:text-base text-text-muted mt-1">
                Notion 기반 한눈에 보기 · Gmail 자동 감지로 단계 갱신
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 self-start sm:self-auto">
            <button
              onClick={handleScan}
              disabled={scanning}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-bg-card border border-border rounded-lg text-sm hover:text-text-heading disabled:opacity-50 whitespace-nowrap"
            >
              <Mail className={`w-4 h-4 ${scanning ? 'animate-pulse' : ''}`} />
              {scanning ? '스캔 중…' : 'Gmail'}
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

      {/* KPI — 게재 완료 탭에서만 강조 노출 */}
      {tab === 'published' && kpi.data && (
        <div className="px-4 md:px-8 pb-2">
          <div className="bg-bg-card border border-border rounded-lg p-3 grid grid-cols-2 sm:grid-cols-5 gap-3">
            <KpiCell label="교신 누적" value={kpi.data.correspondingTotal} icon={<Award className="w-3.5 h-3.5 text-purple-500" />} />
            <KpiCell label="올해 교신" value={kpi.data.correspondingThisYear} icon={<TrendingUp className="w-3.5 h-3.5 text-emerald-500" />} />
            <KpiCell label="공저" value={kpi.data.coAuthorTotal} icon={<FileText className="w-3.5 h-3.5 text-blue-500" />} />
            <KpiCell label="평균 IF (교신)" value={kpi.data.avgImpactFactor} icon={<TrendingUp className="w-3.5 h-3.5 text-amber-500" />} />
            <KpiCell label="1저자 학생" value={kpi.data.uniqueFirstAuthors} icon={<GraduationCap className="w-3.5 h-3.5 text-primary" />} />
          </div>
        </div>
      )}

      {/* 4 탭 */}
      <div className="px-4 md:px-8 pb-3 flex flex-wrap gap-2">
        {(['preparing', 'submitted', 'revision', 'published'] as const).map(k => (
          <TabPill key={k} active={tab === k} onClick={() => setTab(k)} color={TAB_COLOR[k]}>
            {TAB_LABEL[k]} <span className="font-bold">{tabCounts[k]}</span>
          </TabPill>
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
            {[0, 1, 2, 3, 4].map(i => (
              <div key={i} className="bg-bg-input/40 rounded-lg skeleton-shimmer h-9" />
            ))}
          </div>
        )}

        {!isLoading && items.length === 0 && (
          <EmptyState tab={tab} onSync={handleSync} syncing={syncing} />
        )}

        {/* 일반 탭 (준비중/제출/리비전) — 단순 list */}
        {!isLoading && tab !== 'published' && items.length > 0 && (
          <div className="space-y-1.5">
            {items.map(m => (
              <ManuscriptRow
                key={m.id}
                m={m}
                expanded={expandedIds.has(m.id)}
                onToggle={() => toggleExpanded(m.id)}
                onEdit={() => setEditTarget(m)}
                showStage={false}
              />
            ))}
          </div>
        )}

        {/* 게재 완료 — 연도별 토글 */}
        {!isLoading && tab === 'published' && publishedByYear && publishedByYear.length > 0 && (
          <div className="space-y-2">
            {publishedByYear.map(([year, group]) => {
              const collapsed = collapsedYears.has(year);
              const total = group.corresponding.length + group.coAuthor.length;
              return (
                <section key={year} className="bg-bg-card border border-border rounded-lg overflow-hidden">
                  <button
                    onClick={() => toggleYear(year)}
                    className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-bg-hover/50 text-left"
                  >
                    {collapsed
                      ? <ChevronRight className="w-4 h-4 text-text-muted" />
                      : <ChevronDown className="w-4 h-4 text-text-muted" />}
                    <span className="text-base font-bold text-text-heading">{year || '연도 미상'}</span>
                    <span className="text-xs text-text-muted">
                      {total}편 · 교신 {group.corresponding.length} · 공저 {group.coAuthor.length}
                    </span>
                  </button>
                  {!collapsed && (
                    <div className="px-3 pb-3 space-y-1.5">
                      {group.corresponding.length > 0 && (
                        <div>
                          <h3 className="text-[10px] font-semibold text-purple-700 dark:text-purple-300 uppercase tracking-wider px-1 py-1">
                            교신 ({group.corresponding.length})
                          </h3>
                          <div className="space-y-1">
                            {group.corresponding.map(m => (
                              <ManuscriptRow key={m.id} m={m} expanded={expandedIds.has(m.id)} onToggle={() => toggleExpanded(m.id)} onEdit={() => setEditTarget(m)} showStage={false} />
                            ))}
                          </div>
                        </div>
                      )}
                      {group.coAuthor.length > 0 && (
                        <div>
                          <h3 className="text-[10px] font-semibold text-blue-700 dark:text-blue-300 uppercase tracking-wider px-1 py-1 mt-2">
                            공저 ({group.coAuthor.length})
                          </h3>
                          <div className="space-y-1">
                            {group.coAuthor.map(m => (
                              <ManuscriptRow key={m.id} m={m} expanded={expandedIds.has(m.id)} onToggle={() => toggleExpanded(m.id)} onEdit={() => setEditTarget(m)} showStage={false} />
                            ))}
                          </div>
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
          <a
            href="https://www.notion.so/06e9070b661d4d7d829f3aed16dda560"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            노션 DB
          </a>
          에서 편집 (매시간 sync)
        </p>
      </div>

      {editTarget && (
        <EditModal
          m={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={() => { mutate(); kpi.mutate(); }}
        />
      )}
    </div>
  );
}

function KpiCell({ label, value, icon }: { label: string; value: number | string; icon: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1 text-[10px] text-text-muted">{icon}{label}</div>
      <div className="text-base md:text-lg font-bold text-text-heading mt-0.5">{value}</div>
    </div>
  );
}

function EmptyState({ tab, onSync, syncing }: { tab: TabKey; onSync: () => void; syncing: boolean }) {
  const messages: Record<TabKey, { title: string; desc: string }> = {
    preparing: { title: '준비 중인 논문이 없습니다', desc: '노션에서 새 논문을 추가하세요.' },
    submitted: { title: '제출된 논문이 없습니다', desc: 'Gmail 감지로 자동 채워집니다.' },
    revision: { title: '리비전 중인 논문이 없습니다 🎉', desc: '저널 응답을 기다리는 중입니다.' },
    published: { title: '게재 완료 논문이 없습니다', desc: '노션에 publication을 추가하세요.' },
  };
  const { title, desc } = messages[tab];
  return (
    <div className="bg-bg-card border border-border rounded-lg p-6 md:p-8 text-center">
      <Inbox className="w-8 h-8 text-text-muted/30 mx-auto mb-2" />
      <p className="text-text-heading font-medium text-sm">{title}</p>
      <p className="text-text-muted text-xs mb-3">{desc}</p>
      <div className="flex justify-center gap-2">
        <a
          href="https://www.notion.so/06e9070b661d4d7d829f3aed16dda560"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary text-white rounded-md text-xs font-medium hover:bg-primary/90"
        >
          <Plus className="w-3.5 h-3.5" /> 노션 추가
        </a>
        <button
          onClick={onSync}
          disabled={syncing}
          className="inline-flex items-center gap-1 px-3 py-1.5 bg-bg-input rounded-md text-xs font-medium hover:bg-bg-hover disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} /> 동기화
        </button>
      </div>
    </div>
  );
}
