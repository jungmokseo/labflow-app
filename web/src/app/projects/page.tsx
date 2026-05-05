'use client';

/**
 * 프로젝트 관리 (Worksheet Projects) — PI ↔ 학생 캐치볼 추적.
 * - 🔴 내 차례: 학생이 마지막 답변 → PI가 분석/지시할 차례
 * - 🟡 학생 차례 (1~3일): 응답 대기
 * - 🟠 학생 차례 (4~7일): 리마인드 권장
 * - 🔥 학생 차례 (8일+): 긴급 리마인드
 */
import { useState, useMemo, useEffect, useRef } from 'react';
import { useApiData } from '@/lib/use-api';
import { useToast } from '@/components/Toast';
import {
  getWorksheetProjects, syncWorksheetProjects, remindWorksheetStudent,
  getWorksheetReminders, dismissWorksheetProject, switchWorksheetTurn,
  type WorksheetProject, type WorksheetReminder, type WorksheetRecentChange,
} from '@/lib/api';
import {
  FlaskConical, RefreshCw, MessageSquare, User, ExternalLink, Loader2, Inbox, Users,
  CheckCircle2, MailCheck, AlertCircle, Send, X, MoreVertical, PauseCircle, ArrowRightCircle,
} from 'lucide-react';

type FilterTab = 'piTurn' | 'stale' | 'all';

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}일 전`;
  return new Date(iso).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

function timeAgoShort(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  return `${Math.floor(hr / 24)}일 전`;
}

interface TurnBadgeProps {
  whoseTurn: string;
  daysSinceTurn: number;
}

function TurnBadge({ whoseTurn, daysSinceTurn }: TurnBadgeProps) {
  const baseCls = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs whitespace-nowrap';
  if (whoseTurn === 'PI') {
    return (
      <span className={`${baseCls} font-bold bg-red-500/15 text-red-700 dark:text-red-300 border border-red-500/30`}>
        <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
        내 차례
      </span>
    );
  }
  if (daysSinceTurn >= 8) {
    return (
      <span className={`${baseCls} font-bold bg-orange-500/20 text-orange-800 dark:text-orange-300 border border-orange-500/40`}>
        🔥 긴급 {daysSinceTurn}일째
      </span>
    );
  }
  if (daysSinceTurn >= 4) {
    return (
      <span className={`${baseCls} font-medium bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30`}>
        🟠 리마인드 {daysSinceTurn}일
      </span>
    );
  }
  return (
    <span className={`${baseCls} font-medium bg-yellow-500/10 text-yellow-700 dark:text-yellow-300 border border-yellow-500/30`}>
      🟡 학생 답변 대기 {daysSinceTurn}일
    </span>
  );
}

interface RemindModalProps {
  project: WorksheetProject;
  onClose: () => void;
  onSent: () => void;
}

function RemindModal({ project, onClose, onSent }: RemindModalProps) {
  const { toast } = useToast();
  const [sending, setSending] = useState(false);
  const [customMessage, setCustomMessage] = useState('');
  const [selectedStudent, setSelectedStudent] = useState<string>('');

  const isPiTurn = project.whoseTurn === 'PI';
  const modalTitle = isPiTurn ? '검토 완료 알림' : 'Slack 리마인드';
  const placeholder = isPiTurn
    ? `'${project.title}' 워크시트에 PI 검토 코멘트가 추가되었습니다. 노션에서 확인 후 다음 단계 진행해 주세요.`
    : `'${project.title}' 워크시트가 ${project.daysSinceTurn}일째 업데이트가 없습니다. 답변 부탁드려요.`;
  const sendButtonLabel = isPiTurn ? '알림 보내기' : 'Slack 발송';

  const handleSend = async () => {
    setSending(true);
    try {
      const r = await remindWorksheetStudent(project.id, {
        studentName: selectedStudent || undefined,
        customMessage: customMessage.trim() || undefined,
      });
      if (r.ok) {
        const baseMsg = `Slack DM 발송: ${r.sent}/${r.total}`;
        const turnMsg = r.turnChanged ? ' · 🟡 학생 차례로 전환됨' : '';
        toast(baseMsg + turnMsg, 'success');
        onSent();
        onClose();
      } else {
        toast(`발송 실패: ${r.results?.[0]?.error || '알 수 없는 오류'}`, 'error');
      }
    } catch (e: any) {
      toast(`오류: ${e.message}`, 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-bg-card rounded-2xl shadow-xl border border-border max-w-md w-full p-5"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-text-heading">{modalTitle}</h3>
          <button onClick={onClose} className="p-1 hover:bg-bg-hover rounded-lg">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-sm text-text-muted mb-4">
          <span className="font-medium text-text-heading">{project.title}</span>
          {isPiTurn && (
            <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-red-500/10 text-red-700 dark:text-red-300 border border-red-500/30">
              PI 검토 완료 → 학생 알림
            </span>
          )}
        </p>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">받는 사람</label>
            <select
              value={selectedStudent}
              onChange={e => setSelectedStudent(e.target.value)}
              className="w-full px-3 py-2 bg-bg-input rounded-lg text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="">전체 담당자 ({project.assignees.join(', ')})</option>
              {project.assignees.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">메시지 (비워두면 자동 생성)</label>
            <textarea
              value={customMessage}
              onChange={e => setCustomMessage(e.target.value)}
              placeholder={placeholder}
              rows={4}
              className="w-full px-3 py-2 bg-bg-input rounded-lg text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary resize-none"
            />
          </div>
          <p className="text-xs text-text-muted/70">
            보내는 사람: <span className="font-medium">@claude_connect 봇</span> (BLISS Lab Slack)
          </p>
        </div>
        <div className="flex gap-2 mt-5">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 rounded-lg border border-border text-sm hover:bg-bg-hover"
          >
            취소
          </button>
          <button
            onClick={handleSend}
            disabled={sending}
            className="flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
          >
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            {sending ? '발송 중…' : sendButtonLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

interface ActivityTimelineProps {
  changes: WorksheetRecentChange[];
}

function ActivityTimeline({ changes }: ActivityTimelineProps) {
  const [expanded, setExpanded] = useState(false);
  if (changes.length === 0) return null;
  const visible = expanded ? changes : changes.slice(0, 3);

  return (
    <div className="bg-bg-input/40 rounded-lg p-3 border-l-2 border-border">
      <p className="text-xs text-text-muted mb-2 font-medium flex items-center gap-1">
        <MessageSquare className="w-3 h-3" />
        최근 워크시트 활동 ({changes.length})
      </p>
      <ul className="space-y-2">
        {visible.map(c => {
          const isPi = c.role === 'PI';
          const isStudent = c.role === 'STUDENT';
          const dotColor = isPi ? 'bg-blue-500' : isStudent ? 'bg-emerald-500' : 'bg-gray-400';
          const labelColor = isPi
            ? 'text-blue-700 dark:text-blue-300'
            : 'text-emerald-700 dark:text-emerald-400';
          const roleLabel = isPi ? '🔵 PI' : isStudent ? '🟢 학생' : '⚪ 외부';
          return (
            <li key={c.blockId} className="flex gap-2.5">
              <span className={`flex-shrink-0 mt-1.5 w-2 h-2 rounded-full ${dotColor}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-xs font-medium ${labelColor}`}>
                    {roleLabel} · {c.byName || '?'}
                  </span>
                  <span className="text-xs text-text-muted">{timeAgoShort(c.createdAt)}</span>
                </div>
                <p className="text-sm text-text-main leading-relaxed mt-0.5 whitespace-pre-line line-clamp-3">
                  {c.text}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
      {changes.length > 3 && (
        <button
          onClick={() => setExpanded(e => !e)}
          className="text-xs text-primary hover:underline mt-2"
        >
          {expanded ? '접기' : `더 보기 (+${changes.length - 3})`}
        </button>
      )}
    </div>
  );
}

interface RemindersInlineProps {
  projectId: string;
  stats: { sent: number; acked: number; lastSentAt: string | null };
}

/**
 * 서버 응답의 reminderStats로 카운트 즉시 표시 (mount fetch 0회).
 * 펼쳤을 때만 상세 row fetch — 14개 카드 × 14 API call → 0 + N(필요시)
 */
function RemindersInline({ projectId, stats }: RemindersInlineProps) {
  const [details, setDetails] = useState<WorksheetReminder[] | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || details !== null) return;
    setLoading(true);
    getWorksheetReminders(projectId)
      .then(r => setDetails(r.items))
      .catch(() => setDetails([]))
      .finally(() => setLoading(false));
  }, [open, projectId, details]);

  if (stats.sent === 0) return null;

  return (
    <div className="border-t border-border/50 pt-2.5 mt-1">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between text-xs text-text-muted hover:text-text-heading"
      >
        <span className="inline-flex items-center gap-1.5 flex-wrap">
          <MailCheck className="w-3.5 h-3.5" />
          Slack 발송 {stats.sent}건
          {stats.acked > 0 && (
            <span className="text-emerald-700 dark:text-emerald-400 font-medium">
              · ✅ {stats.acked}/{stats.sent} 확인
            </span>
          )}
          {stats.lastSentAt && (
            <span className="text-text-muted/70">· 마지막 {timeAgoShort(stats.lastSentAt)}</span>
          )}
        </span>
        <span className="text-xs ml-2">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <ul className="mt-2 space-y-1.5">
          {loading && <li className="text-xs text-text-muted">불러오는 중…</li>}
          {!loading && details && details.slice(0, 5).map(r => (
            <li key={r.id} className="flex items-start gap-2 text-xs">
              <span
                className={`mt-1 flex-shrink-0 w-2 h-2 rounded-full ${r.acked_at ? 'bg-emerald-500' : 'bg-amber-400'}`}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-text-heading">{r.student_name}</span>
                  <span className="text-text-muted">{timeAgoShort(r.sent_at)} 발송</span>
                  {r.acked_at ? (
                    <span className="inline-flex items-center gap-0.5 text-emerald-700 dark:text-emerald-400">
                      <CheckCircle2 className="w-3 h-3" /> {timeAgoShort(r.acked_at)} 확인
                    </span>
                  ) : (
                    <span className="text-amber-700 dark:text-amber-400">미확인</span>
                  )}
                  {r.purpose === 'PI_TURN' && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-700 dark:text-red-300">
                      검토 완료 알림
                    </span>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface ProjectMenuProps {
  project: WorksheetProject;
  onDismiss: () => void;
  onPassToStudent: () => void;
}

/**
 * 카드 우측 ··· 메뉴 — "보류로 변경" + "학생 차례로 전환" (PI 차례일 때만).
 * 외부 클릭/Esc 시 닫힘.
 */
function ProjectMenu({ project, onDismiss, onPassToStudent }: ProjectMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const isPiTurn = project.whoseTurn === 'PI';

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        onClick={() => setOpen(o => !o)}
        className="p-1.5 rounded-lg text-text-muted hover:text-text-heading hover:bg-bg-hover transition-colors focus-ring"
        aria-label="더 보기"
        aria-haspopup="menu"
        aria-expanded={open}
        title="더 보기"
      >
        <MoreVertical className="w-4 h-4" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-9 z-20 min-w-[200px] bg-bg-card border border-border rounded-lg shadow-card py-1 animate-msg-in"
        >
          {isPiTurn && (
            <button
              role="menuitem"
              onClick={() => { setOpen(false); onPassToStudent(); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-heading hover:bg-bg-hover text-left"
            >
              <ArrowRightCircle className="w-4 h-4 text-yellow-600 dark:text-yellow-400 flex-shrink-0" />
              학생 차례로 전환
            </button>
          )}
          <button
            role="menuitem"
            onClick={() => { setOpen(false); onDismiss(); }}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-heading hover:bg-bg-hover text-left"
          >
            <PauseCircle className="w-4 h-4 text-text-muted flex-shrink-0" />
            보류로 변경 (목록에서 숨김)
          </button>
        </div>
      )}
    </div>
  );
}

interface ProjectCardProps {
  project: WorksheetProject;
  onRemind: () => void;
  onDismiss: () => void;
  onPassToStudent: () => void;
}

function ProjectCard({ project, onRemind, onDismiss, onPassToStudent }: ProjectCardProps) {
  const isPiTurn = project.whoseTurn === 'PI';
  return (
    <div className="bg-bg-card border border-border rounded-lg p-3 md:p-4 hover:border-primary/30 transition-colors">
      <div className="flex flex-col gap-3">
        {/* 헤더: 제목 + 차례 배지 + ··· 메뉴 */}
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="text-base md:text-lg font-bold text-text-heading leading-snug tracking-tight break-words">
              {project.title}
            </h3>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1.5 text-xs md:text-sm text-text-muted">
              {project.team && (
                <span className="inline-flex items-center gap-1">
                  <Users className="w-3.5 h-3.5" />{project.team}
                </span>
              )}
              {project.assignees.length > 0 && (
                <span className="inline-flex items-center gap-1">
                  <User className="w-3.5 h-3.5" />{project.assignees.join(', ')}
                </span>
              )}
              {project.status && (
                <span className="text-[11px] px-2 py-0.5 bg-bg-input rounded-full">{project.status}</span>
              )}
            </div>
          </div>
          <div className="flex items-start gap-1.5 flex-shrink-0">
            <TurnBadge whoseTurn={project.whoseTurn} daysSinceTurn={project.daysSinceTurn} />
            <ProjectMenu
              project={project}
              onDismiss={onDismiss}
              onPassToStudent={onPassToStudent}
            />
          </div>
        </div>

        {/* 마지막 활동 발췌 + 최근 timeline */}
        {project.recentChanges && project.recentChanges.length > 0 ? (
          <ActivityTimeline changes={project.recentChanges} />
        ) : project.lastActivitySnippet ? (
          <div className="bg-bg-input/40 rounded-lg p-3 border-l-2 border-border">
            <p className="text-xs text-text-muted mb-1 inline-flex items-center gap-1">
              <MessageSquare className="w-3 h-3" />
              {project.lastActivityByName || '?'} ({project.lastActivityRole === 'PI' ? 'PI' : '학생'})
              · {timeAgo(project.lastActivityAt)}
            </p>
            <p className="text-sm text-text-main leading-relaxed line-clamp-2">
              &ldquo;{project.lastActivitySnippet}&rdquo;
            </p>
          </div>
        ) : null}

        {/* 액션 버튼 */}
        <div className="flex gap-2 pt-1">
          <a
            href={project.notionUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-bg-input text-text-heading rounded-lg text-sm font-medium hover:bg-bg-hover transition-colors"
          >
            <ExternalLink className="w-4 h-4" />
            노션 열기
          </a>
          <button
            onClick={onRemind}
            className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            <Send className="w-4 h-4" />
            {isPiTurn ? '검토 완료 알림' : 'Slack 리마인드'}
          </button>
        </div>

        {/* 발송된 Slack 리마인드 + ✅ 수신 상태 */}
        <RemindersInline
          projectId={project.id}
          stats={project.reminderStats || { sent: 0, acked: 0, lastSentAt: null }}
        />
      </div>
    </div>
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

export default function ProjectsPage() {
  const { toast } = useToast();
  const [filter, setFilter] = useState<FilterTab>('piTurn');
  const [syncing, setSyncing] = useState(false);
  const [remindTarget, setRemindTarget] = useState<WorksheetProject | null>(null);

  const { data, error, isLoading, mutate } = useApiData<{
    items: WorksheetProject[];
    counts: { piTurn: number; studentTurn: number; stale7d: number };
  }>('worksheet-projects', () => getWorksheetProjects());

  const counts = data?.counts;

  const filtered = useMemo(() => {
    const items = data?.items ?? [];
    if (filter === 'piTurn') return items.filter(i => i.whoseTurn === 'PI');
    if (filter === 'stale') return items.filter(i => i.whoseTurn === 'STUDENT' && i.daysSinceTurn >= 7);
    return items;
  }, [data?.items, filter]);

  const totalCount = data?.items?.length ?? 0;

  // 팀별 그룹
  const groupedByTeam = useMemo(() => {
    const groups = new Map<string, WorksheetProject[]>();
    for (const p of filtered) {
      const team = p.team || '기타';
      if (!groups.has(team)) groups.set(team, []);
      groups.get(team)!.push(p);
    }
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const r = await syncWorksheetProjects();
      toast(`Sync 완료: ${r.worksheets} worksheets, ${r.errors} errors`, 'success');
      await mutate();
    } catch (e: any) {
      toast(`Sync 실패: ${e.message}`, 'error');
    } finally {
      setSyncing(false);
    }
  };

  const handleDismiss = async (project: WorksheetProject) => {
    // Optimistic — 즉시 목록에서 제거
    if (data) {
      mutate(
        { ...data, items: data.items.filter(i => i.id !== project.id) },
        { revalidate: false },
      );
    }
    try {
      const r = await dismissWorksheetProject(project.id);
      toast(
        r.notionUpdated
          ? `'${project.title}' 보류 처리됨 · 노션 ⏸ 보류 갱신`
          : `'${project.title}' 보류 처리됨 (노션 갱신 실패 — 다음 sync에서 재시도)`,
        'success',
      );
      // 카운트 정확화
      mutate();
    } catch (e: any) {
      toast(`보류 실패: ${e.message}`, 'error');
      mutate();  // 롤백
    }
  };

  const handlePassToStudent = async (project: WorksheetProject) => {
    // Optimistic — whoseTurn 즉시 STUDENT
    if (data) {
      mutate(
        {
          ...data,
          items: data.items.map(i =>
            i.id === project.id
              ? { ...i, whoseTurn: 'STUDENT' as const, daysSinceTurn: 0 }
              : i,
          ),
          counts: {
            ...data.counts,
            piTurn: Math.max(0, data.counts.piTurn - 1),
            studentTurn: data.counts.studentTurn + 1,
          },
        },
        { revalidate: false },
      );
    }
    try {
      await switchWorksheetTurn(project.id, 'STUDENT');
      toast(`'${project.title}' 학생 차례로 전환됨`, 'success');
      mutate();
    } catch (e: any) {
      toast(`전환 실패: ${e.message}`, 'error');
      mutate();
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
                <FlaskConical className="w-6 h-6 text-primary flex-shrink-0" /> 프로젝트 관리
              </h1>
              <p className="text-sm md:text-base text-text-muted mt-1">
                Notion 워크시트 캐치볼 추적 · 매시간 자동 sync
              </p>
            </div>
          </div>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-bg-card border border-border rounded-lg text-sm hover:text-text-heading disabled:opacity-50 self-start sm:self-auto whitespace-nowrap"
          >
            <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? '동기화 중…' : '지금 동기화'}
          </button>
        </div>
      </div>

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
          active={filter === 'stale'}
          onClick={() => setFilter('stale')}
          activeColor="bg-orange-500/15 text-orange-700 dark:text-orange-300 border border-orange-500/30"
        >
          🔥 리마인드 필요 {counts && <span className="font-bold">{counts.stale7d}</span>}
        </FilterPill>
        <FilterPill
          active={filter === 'all'}
          onClick={() => setFilter('all')}
          activeColor="bg-primary text-white border border-primary"
        >
          전체 <span className="font-bold">{totalCount}</span>
        </FilterPill>
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
              <div key={i} className="bg-bg-input/40 rounded-lg skeleton-shimmer h-32" />
            ))}
          </div>
        )}

        {!isLoading && totalCount === 0 && (
          <div className="bg-bg-card border border-border rounded-lg p-8 md:p-10 text-center">
            <Inbox className="w-12 h-12 text-text-muted/30 mx-auto mb-4" />
            <p className="text-text-heading font-semibold text-lg mb-2">아직 동기화된 워크시트가 없습니다</p>
            <p className="text-text-muted text-sm mb-6">위의 [지금 동기화] 버튼을 눌러 첫 sync를 실행하세요.</p>
            <button
              onClick={handleSync}
              disabled={syncing}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? '동기화 중…' : '지금 동기화'}
            </button>
          </div>
        )}

        {!isLoading && filtered.length === 0 && totalCount > 0 && (
          <div className="bg-bg-card border border-border rounded-lg p-8 md:p-10 text-center">
            <p className="text-text-heading font-medium">이 필터에 해당하는 프로젝트가 없습니다 🎉</p>
            <p className="text-text-muted text-sm mt-1">다른 필터를 선택하거나 [전체]를 보세요.</p>
          </div>
        )}

        {/* 카드 목록 — 팀별 그룹 */}
        {!isLoading && filtered.length > 0 && (
          <div className="space-y-5 md:space-y-6">
            {groupedByTeam.map(([team, projects]) => (
              <div key={team} className="space-y-3">
                <h2 className="text-sm md:text-base font-bold text-text-heading flex items-center gap-2">
                  <Users className="w-4 h-4 text-primary" />{team}
                  <span className="text-xs font-normal text-text-muted">({projects.length})</span>
                </h2>
                <div className="space-y-3">
                  {projects.map(p => (
                    <ProjectCard
                      key={p.id}
                      project={p}
                      onRemind={() => setRemindTarget(p)}
                      onDismiss={() => handleDismiss(p)}
                      onPassToStudent={() => handlePassToStudent(p)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {remindTarget && (
        <RemindModal
          project={remindTarget}
          onClose={() => setRemindTarget(null)}
          onSent={() => mutate()}
        />
      )}
    </div>
  );
}
