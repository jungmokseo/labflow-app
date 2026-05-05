import { memo } from 'react';
import type { Manuscript } from '@/lib/api';
import {
  ExternalLink, FileText, ChevronRight, ChevronDown, Pencil,
} from 'lucide-react';
import { TAB_COLOR, fmtDate, daysUntil, timeAgo, stageToTab } from './types';

interface RowProps {
  m: Manuscript;
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  showStage?: boolean;
}

function Field({ label, children, mono = false }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <p className="text-[10px] text-text-muted uppercase tracking-wider">{label}</p>
      <p className={`text-text-heading ${mono ? 'font-mono text-[11px]' : ''}`}>{children}</p>
    </div>
  );
}

/** 한 줄 카드 — collapsed/expanded toggle */
function ManuscriptRowImpl({ m, expanded, onToggle, onEdit, showStage = true }: RowProps) {
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

/**
 * React.memo로 wrapping —
 * expanded prop 또는 m 객체 reference가 바뀔 때만 rerender.
 * onToggle/onEdit은 부모에서 useCallback으로 안정화하므로 reference가 유지됨.
 */
export const ManuscriptRow = memo(ManuscriptRowImpl);
