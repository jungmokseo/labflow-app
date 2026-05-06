'use client';

/**
 * 연구 과제 — Grants panel
 *
 * GDrive 'BLISS Lab 과제 정보' Sheets ↔ Project DB sync (gdrive-cron 매시간).
 * PI 입력(목표·담당 학생·마일스톤·메모)은 metadata JSON에 저장 — sync 시 보존됨.
 *
 * 4 탭: 진행 중 / 종료 임박 (D-90) / 신청 중 / 종료됨
 * 한 줄 카드 + 펼쳐서 세부 + 마일스톤 체크리스트
 */
import { useState, useMemo, useCallback } from 'react';
import { useApiData } from '@/lib/use-api';
import { useToast } from '@/components/Toast';
import {
  getGrants, updateGrant, addGrantMilestone, patchGrantMilestone, deleteGrantMilestone,
  type Grant, type GrantCounts, type GrantMilestone,
} from '@/lib/api';
import {
  FlaskConical, RefreshCw, ChevronRight, ChevronDown, Inbox, AlertCircle,
  Plus, Pencil, Check, Copy, Trash2, ExternalLink, Calendar, Users, Target,
} from 'lucide-react';

type TabKey = 'active' | 'endingSoon' | 'submitted' | 'completed';

const TAB_LABEL: Record<TabKey, string> = {
  active: '진행 중',
  endingSoon: '종료 임박',
  submitted: '신청 중',
  completed: '종료됨',
};

const TAB_COLOR: Record<TabKey, string> = {
  active: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
  endingSoon: 'bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30',
  submitted: 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30',
  completed: 'bg-bg-input text-text-muted border-border',
};

const SHEETS_URL = 'https://docs.google.com/spreadsheets/d/1Zt5J1Kk6kwiYt_aF4lnz2k2xwuqoGl7Ovh219wa8ChE/';

function classifyTab(g: Grant): TabKey {
  // 종료됨 우선 (날짜 지난 것)
  if (g.daysToEnd !== null && g.daysToEnd < 0) return 'completed';
  if (g.status === 'completed') return 'completed';
  if (g.status === 'submitted' || g.status === 'preparing') return 'submitted';
  if ((g.daysToEnd !== null && g.daysToEnd >= 0 && g.daysToEnd <= 90) || g.status === 'ending_soon') return 'endingSoon';
  return 'active';
}

function fmtDate(iso?: string | null): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleDateString('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' });
}

function dueLabel(due: string | null | undefined): { text: string; color: string } | null {
  if (!due) return null;
  const days = Math.ceil((new Date(due).getTime() - Date.now()) / 86400000);
  if (days < 0) return { text: `D+${-days} (지남)`, color: 'text-red-600 dark:text-red-400' };
  if (days === 0) return { text: '오늘', color: 'text-orange-600 dark:text-orange-400' };
  if (days <= 7) return { text: `D-${days}`, color: 'text-orange-600 dark:text-orange-400' };
  if (days <= 30) return { text: `D-${days}`, color: 'text-amber-600 dark:text-amber-400' };
  return { text: fmtDate(due), color: 'text-text-muted' };
}

export default function GrantsPage() {
  const { toast } = useToast();
  const [tab, setTab] = useState<TabKey>('active');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const { data, error, isLoading, mutate } = useApiData<{ items: Grant[]; counts: GrantCounts }>(
    'grants',
    () => getGrants(),
  );

  const items = useMemo(() => data?.items ?? [], [data?.items]);
  const counts = data?.counts;

  const filtered = useMemo(() => items.filter(g => classifyTab(g) === tab), [items, tab]);

  // 종료 임박은 D-day 가까운 순으로 정렬
  const sorted = useMemo(() => {
    if (tab === 'endingSoon') {
      return [...filtered].sort((a, b) => (a.daysToEnd ?? 999) - (b.daysToEnd ?? 999));
    }
    return filtered;
  }, [filtered, tab]);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }, []);

  return (
    <div className="min-h-full pb-20 md:pb-12">
      {/* 헤더 */}
      <div className="px-4 md:px-8 pt-4 md:pt-8 pb-3">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <span className="w-1 h-9 md:h-11 bg-primary rounded-full flex-shrink-0" />
            <div className="min-w-0">
              <h1 className="text-2xl md:text-3xl font-bold text-text-heading tracking-tight flex items-center gap-2 leading-tight">
                <FlaskConical className="w-6 h-6 text-primary flex-shrink-0" /> 연구 과제
              </h1>
              <p className="text-sm md:text-base text-text-muted mt-1">
                Google Sheets 자동 sync · 목표/담당 학생/마일스톤은 ResearchFlow에서 직접 관리
              </p>
            </div>
          </div>
          <a
            href={SHEETS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-bg-card border border-border rounded-lg text-sm hover:text-text-heading whitespace-nowrap self-start sm:self-auto"
          >
            <ExternalLink className="w-4 h-4" /> Sheets 원본
          </a>
        </div>
      </div>

      {/* KPI */}
      {counts && (
        <div className="px-4 md:px-8 pb-2">
          <div className="bg-bg-card border border-border rounded-lg p-3 grid grid-cols-2 sm:grid-cols-5 gap-3">
            <Kpi label="진행 중" value={counts.active} color="text-emerald-600 dark:text-emerald-400" />
            <Kpi label="종료 임박 (D-90)" value={counts.endingSoon} color="text-orange-600 dark:text-orange-400" />
            <Kpi label="신청 중" value={counts.submitted} color="text-blue-600 dark:text-blue-400" />
            <Kpi label="종료됨" value={counts.completed} color="text-text-muted" />
            <Kpi label="마일스톤 D-14" value={counts.milestonesDueSoon} color="text-amber-600 dark:text-amber-400" />
          </div>
        </div>
      )}

      {/* 4 탭 */}
      <div className="px-4 md:px-8 pb-3 flex flex-wrap gap-2">
        {(['active', 'endingSoon', 'submitted', 'completed'] as TabKey[]).map(k => (
          <button key={k} onClick={() => setTab(k)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-colors whitespace-nowrap border ${
              tab === k ? TAB_COLOR[k] : 'bg-bg-card text-text-muted border-border hover:text-text-heading'
            }`}>
            {TAB_LABEL[k]} <span className="font-bold">{counts ? (counts as any)[k] : 0}</span>
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

        {!isLoading && sorted.length === 0 && (
          <div className="bg-bg-card border border-border rounded-lg p-6 text-center">
            <Inbox className="w-8 h-8 text-text-muted/30 mx-auto mb-2" />
            <p className="text-text-heading font-medium text-sm">{TAB_LABEL[tab]} 과제가 없습니다</p>
          </div>
        )}

        {!isLoading && sorted.length > 0 && (
          <div className="space-y-1.5">
            {sorted.map(g => (
              <GrantRow
                key={g.id}
                g={g}
                expanded={expandedIds.has(g.id)}
                onToggle={() => toggleExpanded(g.id)}
                onMutated={() => mutate()}
              />
            ))}
          </div>
        )}

        <p className="text-[11px] text-text-muted/70 text-center pt-3">
          기간·과제번호·부처 정보는{' '}
          <a href={SHEETS_URL} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Google Sheets</a>
          에서 편집 (매시간 sync) · 목표/담당 학생/마일스톤은 카드 [편집] 또는 [+] 버튼으로
        </p>
      </div>
    </div>
  );
}

function Kpi({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex flex-col">
      <p className="text-[10px] text-text-muted">{label}</p>
      <p className={`text-base md:text-lg font-bold mt-0.5 ${color}`}>{value}</p>
    </div>
  );
}

interface GrantRowProps {
  g: Grant;
  expanded: boolean;
  onToggle: () => void;
  onMutated: () => void;
}

function GrantRow({ g, expanded, onToggle, onMutated }: GrantRowProps) {
  const tab = classifyTab(g);
  const ms = g.metadata.milestones ?? [];
  const msStats = g.milestoneStats;
  const endDDay = g.daysToEnd !== null
    ? (g.daysToEnd >= 0 ? `D-${g.daysToEnd}` : `D+${-g.daysToEnd}`)
    : null;

  return (
    <article className="bg-bg-card border border-border rounded-lg hover:border-primary/30 transition-colors">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
      >
        <span className="text-text-muted flex-shrink-0">
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </span>
        <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-text-heading truncate">
            {g.shortName || g.name}
          </span>
          {g.shortName && g.shortName !== g.name && (
            <span className="hidden md:inline text-xs text-text-muted truncate">— {g.name.replace(/\s*\([^)]+\)\s*$/, '')}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {g.metadata.studentLeads && (
            <span className="hidden sm:inline text-[11px] px-1.5 py-0.5 bg-bg-input rounded text-text-muted">
              👥 {g.metadata.studentLeads.split(',').map(s => s.trim()).join(',')}
            </span>
          )}
          {msStats.total > 0 && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${msStats.dueSoon > 0 ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300' : 'bg-bg-input text-text-muted'}`}>
              {msStats.done}/{msStats.total}
              {msStats.dueSoon > 0 && ` · D-14 ${msStats.dueSoon}`}
            </span>
          )}
          {endDDay && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium whitespace-nowrap ${
              tab === 'endingSoon' || (g.daysToEnd !== null && g.daysToEnd < 0)
                ? 'bg-orange-500/15 text-orange-700 dark:text-orange-300'
                : 'bg-bg-input text-text-muted'
            }`}>
              {endDDay}
            </span>
          )}
          {g.funder && (
            <span className="hidden md:inline text-[10px] px-1.5 py-0.5 bg-bg-input rounded text-text-muted max-w-[120px] truncate">
              {g.funder}
            </span>
          )}
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-border/60 space-y-3">
          {/* 메타 */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1.5 pt-2 text-xs">
            {g.number && <Field label="과제번호" mono>{g.number}</Field>}
            {g.funder && <Field label="발주처">{g.funder}</Field>}
            {g.ministry && <Field label="부처">{g.ministry}</Field>}
            {g.period && <Field label="기간">{g.period}</Field>}
            {g.pi && <Field label="PI">{g.pi}</Field>}
            {g.pm && <Field label="PM">{g.pm}</Field>}
            {g.responsibility && <Field label="책임">{g.responsibility}</Field>}
            {g.businessName && <Field label="사업명">{g.businessName}</Field>}
          </div>

          {/* PI 입력 — 목표 / 담당 학생 / 메모 */}
          <PIFieldsEditor g={g} onSaved={onMutated} />

          {/* 마일스톤 체크리스트 */}
          <MilestonesEditor g={g} milestones={ms} onMutated={onMutated} />

          {/* 사사 문구 */}
          {(g.acknowledgmentKo || g.acknowledgmentEn) && (
            <div className="space-y-1">
              <p className="text-[10px] text-text-muted uppercase tracking-wider">사사 문구</p>
              {g.acknowledgmentKo && <AcknowledgeBlock label="국문" text={g.acknowledgmentKo} />}
              {g.acknowledgmentEn && <AcknowledgeBlock label="영문" text={g.acknowledgmentEn} />}
            </div>
          )}

          <div className="flex flex-wrap gap-1.5 pt-1 text-[11px]">
            <a
              href={SHEETS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2.5 py-1 bg-bg-input rounded font-medium hover:bg-bg-hover"
            >
              <ExternalLink className="w-3 h-3" /> Sheets 열기
            </a>
            <span className="ml-auto text-text-muted/70">
              마지막 sync: {fmtDate(g.syncedAt)}
            </span>
          </div>
        </div>
      )}
    </article>
  );
}

function Field({ label, children, mono = false }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <p className="text-[10px] text-text-muted uppercase tracking-wider">{label}</p>
      <p className={`text-text-heading ${mono ? 'font-mono text-[11px]' : ''}`}>{children}</p>
    </div>
  );
}

function AcknowledgeBlock({ label, text }: { label: string; text: string }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast(`${label} 사사 복사됨`, 'success');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast('복사 실패', 'error');
    }
  };
  return (
    <div className="bg-bg-input/50 rounded p-2 text-xs">
      <div className="flex items-start gap-2">
        <span className="text-[10px] font-semibold text-text-muted flex-shrink-0 mt-0.5">{label}</span>
        <p className="flex-1 text-text-main whitespace-pre-line break-words">{text}</p>
        <button
          onClick={handleCopy}
          className="flex-shrink-0 inline-flex items-center gap-1 px-2 py-0.5 text-[11px] bg-bg-card border border-border rounded hover:bg-bg-hover"
        >
          {copied ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
          {copied ? '복사됨' : '복사'}
        </button>
      </div>
    </div>
  );
}

interface PIFieldsEditorProps {
  g: Grant;
  onSaved: () => void;
}

function PIFieldsEditor({ g, onSaved }: PIFieldsEditorProps) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [goal, setGoal] = useState(g.metadata.goal || '');
  const [studentLeads, setStudentLeads] = useState(g.metadata.studentLeads || '');
  const [notes, setNotes] = useState(g.metadata.notes || '');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateGrant(g.id, {
        goal: goal.trim() || null,
        studentLeads: studentLeads.trim() || null,
        notes: notes.trim() || null,
      });
      toast('과제 정보 저장됨', 'success');
      setEditing(false);
      onSaved();
    } catch (e: any) {
      toast(`저장 실패: ${e.message?.slice(0, 80)}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    const hasContent = g.metadata.goal || g.metadata.studentLeads || g.metadata.notes;
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-[10px] text-text-muted uppercase tracking-wider">과제 목표 / 담당</p>
          <button onClick={() => setEditing(true)} className="text-[11px] inline-flex items-center gap-1 text-primary hover:underline">
            <Pencil className="w-3 h-3" /> {hasContent ? '편집' : '+ 추가'}
          </button>
        </div>
        {!hasContent && (
          <p className="text-xs text-text-muted/70 italic px-1">아직 목표/담당 학생 입력 안됨</p>
        )}
        {g.metadata.goal && (
          <div className="bg-emerald-500/5 border border-emerald-500/30 rounded p-2 text-xs">
            <div className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300 mb-1">
              <Target className="w-3 h-3" /> 목표
            </div>
            <p className="text-text-main whitespace-pre-line">{g.metadata.goal}</p>
          </div>
        )}
        {g.metadata.studentLeads && (
          <div className="text-xs text-text-main inline-flex items-center gap-1">
            <Users className="w-3 h-3 text-text-muted" />
            <span className="text-[10px] font-semibold text-text-muted uppercase mr-1">담당</span>
            {g.metadata.studentLeads}
          </div>
        )}
        {g.metadata.notes && (
          <div className="text-xs text-text-muted bg-bg-input/40 rounded p-2 whitespace-pre-line border-l-2 border-border">
            {g.metadata.notes}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2 bg-bg-input/30 border border-border rounded p-2">
      <p className="text-[10px] text-text-muted uppercase tracking-wider">편집</p>
      <div>
        <label className="text-[10px] text-text-muted">목표 (PI가 챙겨야 할 것)</label>
        <textarea
          value={goal}
          onChange={e => setGoal(e.target.value)}
          rows={3}
          placeholder="예: 1년차 마일스톤 - 4개 prototype, 2건 학회 발표, 1건 SCI 논문 (in revision 이상)"
          className="w-full mt-1 px-2 py-1.5 bg-bg-card border border-border rounded text-xs text-text-heading focus:outline-none focus:ring-2 focus:ring-primary resize-none"
        />
      </div>
      <div>
        <label className="text-[10px] text-text-muted">담당 학생 (콤마 구분)</label>
        <input
          value={studentLeads}
          onChange={e => setStudentLeads(e.target.value)}
          placeholder="예: 김수아, 윤민"
          className="w-full mt-1 px-2 py-1.5 bg-bg-card border border-border rounded text-xs text-text-heading focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>
      <div>
        <label className="text-[10px] text-text-muted">PI 메모</label>
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          rows={2}
          placeholder="기타 메모 (자유 형식)"
          className="w-full mt-1 px-2 py-1.5 bg-bg-card border border-border rounded text-xs text-text-heading focus:outline-none focus:ring-2 focus:ring-primary resize-none"
        />
      </div>
      <div className="flex gap-1.5">
        <button
          onClick={() => setEditing(false)}
          disabled={saving}
          className="flex-1 px-3 py-1.5 text-[11px] bg-bg-card border border-border rounded hover:bg-bg-hover disabled:opacity-50"
        >
          취소
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex-1 px-3 py-1.5 text-[11px] bg-primary text-white rounded font-medium hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? '저장 중…' : '저장'}
        </button>
      </div>
    </div>
  );
}

interface MilestonesEditorProps {
  g: Grant;
  milestones: GrantMilestone[];
  onMutated: () => void;
}

function MilestonesEditor({ g, milestones, onMutated }: MilestonesEditorProps) {
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDue, setNewDue] = useState('');
  const [newOwner, setNewOwner] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const handleToggle = async (mid: string, done: boolean) => {
    setBusy(mid);
    try {
      await patchGrantMilestone(g.id, mid, { done });
      onMutated();
    } catch (e: any) {
      toast(`수정 실패: ${e.message}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (mid: string) => {
    if (!confirm('마일스톤 삭제?')) return;
    setBusy(mid);
    try {
      await deleteGrantMilestone(g.id, mid);
      onMutated();
    } catch (e: any) {
      toast(`삭제 실패: ${e.message}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const handleAdd = async () => {
    if (!newTitle.trim()) return;
    setBusy('__add__');
    try {
      await addGrantMilestone(g.id, {
        title: newTitle.trim(),
        due: newDue || null,
        owner: newOwner.trim() || null,
      });
      setNewTitle('');
      setNewDue('');
      setNewOwner('');
      setAdding(false);
      onMutated();
    } catch (e: any) {
      toast(`추가 실패: ${e.message}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  // 미완료 → 완료, 마감 가까운 순
  const sorted = [...milestones].sort((a, b) => {
    if (!!a.done !== !!b.done) return a.done ? 1 : -1;
    if (a.due && b.due) return a.due.localeCompare(b.due);
    if (a.due) return -1;
    if (b.due) return 1;
    return 0;
  });

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <p className="text-[10px] text-text-muted uppercase tracking-wider">
          마일스톤 ({milestones.filter(m => m.done).length}/{milestones.length})
        </p>
        {!adding && (
          <button onClick={() => setAdding(true)} className="text-[11px] inline-flex items-center gap-1 text-primary hover:underline">
            <Plus className="w-3 h-3" /> 추가
          </button>
        )}
      </div>

      {sorted.length === 0 && !adding && (
        <p className="text-xs text-text-muted/70 italic px-1">마일스톤 없음 — 위 [+ 추가]로 등록</p>
      )}

      {sorted.map(m => {
        const due = dueLabel(m.due);
        return (
          <div
            key={m.id}
            className={`flex items-start gap-2 px-2 py-1.5 bg-bg-input/30 rounded text-xs ${m.done ? 'opacity-60' : ''}`}
          >
            <button
              onClick={() => handleToggle(m.id, !m.done)}
              disabled={busy === m.id}
              className={`flex-shrink-0 mt-0.5 w-4 h-4 rounded border ${
                m.done ? 'bg-primary border-primary text-white' : 'border-text-muted/40'
              } inline-flex items-center justify-center disabled:opacity-50`}
              aria-label={m.done ? '미완료로' : '완료로'}
            >
              {m.done && <Check className="w-3 h-3" />}
            </button>
            <div className="flex-1 min-w-0">
              <p className={`text-text-heading ${m.done ? 'line-through' : ''}`}>{m.title}</p>
              <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
                {due && <span className={`text-[10px] ${due.color}`}><Calendar className="w-2.5 h-2.5 inline mr-0.5" />{due.text}</span>}
                {m.owner && <span className="text-[10px] text-text-muted">👤 {m.owner}</span>}
                {m.note && <span className="text-[10px] text-text-muted/70 italic truncate">— {m.note}</span>}
              </div>
            </div>
            <button
              onClick={() => handleDelete(m.id)}
              disabled={busy === m.id}
              className="flex-shrink-0 p-1 text-text-muted/70 hover:text-red-500 disabled:opacity-50"
              aria-label="삭제"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        );
      })}

      {adding && (
        <div className="flex flex-wrap gap-1.5 px-2 py-1.5 bg-bg-input/40 border border-border rounded">
          <input
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            placeholder="마일스톤 제목"
            className="flex-1 min-w-[140px] px-2 py-1 bg-bg-card border border-border rounded text-xs focus:outline-none focus:ring-2 focus:ring-primary"
            autoFocus
            onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleAdd(); if (e.key === 'Escape') setAdding(false); }}
          />
          <input
            type="date"
            value={newDue}
            onChange={e => setNewDue(e.target.value)}
            className="px-2 py-1 bg-bg-card border border-border rounded text-xs focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <input
            value={newOwner}
            onChange={e => setNewOwner(e.target.value)}
            placeholder="담당"
            className="w-20 px-2 py-1 bg-bg-card border border-border rounded text-xs focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <button
            onClick={handleAdd}
            disabled={busy === '__add__' || !newTitle.trim()}
            className="px-2 py-1 bg-primary text-white text-[11px] font-medium rounded disabled:opacity-50"
          >
            추가
          </button>
          <button onClick={() => { setAdding(false); setNewTitle(''); setNewDue(''); setNewOwner(''); }} className="px-2 py-1 text-[11px] text-text-muted hover:text-text-heading">
            취소
          </button>
        </div>
      )}
    </div>
  );
}
