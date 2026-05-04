'use client';

/**
 * 프로젝트 관리 (Worksheet Projects) — PI ↔ 학생 캐치볼 추적.
 * - 🔴 내 차례: 학생이 마지막 답변 → PI가 분석/지시할 차례
 * - 🟡 학생 차례 (1~3일): 응답 대기
 * - 🟠 학생 차례 (4~7일): 리마인드 권장
 * - 🔥 학생 차례 (8일+): 긴급 리마인드
 */
import { useState, useMemo, useEffect } from 'react';
import { useApiData } from '@/lib/use-api';
import { useToast } from '@/components/Toast';
import {
  getWorksheetProjects, syncWorksheetProjects, remindWorksheetStudent,
  getWorksheetReminders,
  type WorksheetProject, type WorksheetReminder, type WorksheetRecentChange,
} from '@/lib/api';
import {
  FlaskConical, RefreshCw, MessageSquare, Clock, User, ArrowRight,
  Filter, AlertCircle, Send, X, ExternalLink, Loader2, Inbox, Users,
  CheckCircle2, MailCheck,
} from 'lucide-react';

type FilterTab = 'piTurn' | 'stale' | 'all' | 'team';

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

interface TurnBadgeProps {
  whoseTurn: string;
  daysSinceTurn: number;
}

function TurnBadge({ whoseTurn, daysSinceTurn }: TurnBadgeProps) {
  if (whoseTurn === 'PI') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-red-500/15 text-red-700 dark:text-red-300 border border-red-500/30">
        <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
        내 차례
      </span>
    );
  }
  if (daysSinceTurn >= 8) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-orange-500/20 text-orange-800 dark:text-orange-300 border border-orange-500/40">
        🔥 긴급 {daysSinceTurn}일째
      </span>
    );
  }
  if (daysSinceTurn >= 4) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30">
        🟠 리마인드 권장 {daysSinceTurn}일
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-yellow-500/10 text-yellow-700 dark:text-yellow-300 border border-yellow-500/30">
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-bg-card rounded-2xl shadow-xl border border-border max-w-md w-full p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-text-heading">{modalTitle}</h3>
          <button onClick={onClose} className="p-1 hover:bg-bg-hover rounded-lg"><X className="w-4 h-4" /></button>
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
          <button onClick={onClose} className="flex-1 px-4 py-2 rounded-lg border border-border text-sm hover:bg-bg-hover">
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

function timeAgoShort(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  return `${Math.floor(hr / 24)}일 전`;
}

interface ActivityTimelineProps {
  changes: WorksheetRecentChange[];
}

function ActivityTimeline({ changes }: ActivityTimelineProps) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? changes : changes.slice(0, 3);
  if (changes.length === 0) return null;

  return (
    <div className="bg-bg-input/40 rounded-lg p-3 border-l-2 border-border">
      <p className="text-xs text-text-muted mb-2 font-medium flex items-center gap-1">
        <MessageSquare className="w-3 h-3" />
        최근 워크시트 활동 ({changes.length})
      </p>
      <ul className="space-y-2">
        {visible.map(c => {
          const isPi = c.role === 'PI';
          const dotColor = isPi ? 'bg-blue-500' : c.role === 'STUDENT' ? 'bg-emerald-500' : 'bg-gray-400';
          return (
            <li key={c.blockId} className="flex gap-2.5">
              <span className={`flex-shrink-0 mt-1.5 w-2 h-2 rounded-full ${dotColor}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-xs font-medium ${isPi ? 'text-blue-700 dark:text-blue-300' : 'text-emerald-700 dark:text-emerald-400'}`}>
                    {isPi ? '🔵 PI' : c.role === 'STUDENT' ? '🟢 학생' : '⚪ 외부'} · {c.byName || '?'}
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
}

function RemindersInline({ projectId }: RemindersInlineProps) {
  const [reminders, setReminders] = useState<WorksheetReminder[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || reminders !== null) return;
    getWorksheetReminders(projectId).then(r => setReminders(r.items)).catch(() => setReminders([]));
  }, [open, projectId, reminders]);

  // 항상 카운트는 빠르게 보여주기 위해 첫 mount 때 fetch (cache)
  useEffect(() => {
    if (reminders === null) {
      getWorksheetReminders(projectId).then(r => setReminders(r.items)).catch(() => setReminders([]));
    }
  }, [projectId]);

  const recent = (reminders || []).slice(0, 5);
  const sentCount = recent.length;
  const ackedCount = recent.filter(r => r.acked_at).length;

  if (sentCount === 0) return null;

  return (
    <div className="border-t border-border/50 pt-2.5 mt-1">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between text-xs text-text-muted hover:text-text-heading"
      >
        <span className="inline-flex items-center gap-1.5">
          <MailCheck className="w-3.5 h-3.5" />
          최근 Slack 발송 {sentCount}건
          {ackedCount > 0 && (
            <span className="text-emerald-700 dark:text-emerald-400 font-medium">· ✅ {ackedCount}/{sentCount} 확인</span>
          )}
        </span>
        <span className="text-xs">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <ul className="mt-2 space-y-1.5">
          {recent.map(r => (
            <li key={r.id} className="flex items-start gap-2 text-xs">
              <span className={`mt-1 flex-shrink-0 w-2 h-2 rounded-full ${r.acked_at ? 'bg-emerald-500' : 'bg-amber-400'}`} />
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
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-700 dark:text-red-300">검토 완료 알림</span>
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

interface ProjectCardProps {
  project: WorksheetProject;
  onRemind: () => void;
}

function ProjectCard({ project, onRemind }: ProjectCardProps) {
  return (
    <div className="bg-bg-card border border-border rounded-xl p-4 md:p-5 hover:border-primary/30 transition-colors">
      <div className="flex flex-col gap-3">
        {/* 헤더: 제목 + 차례 배지 */}
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="text-base md:text-lg font-bold text-text-heading leading-tight tracking-tight">
              {project.title}
            </h3>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1.5 text-sm text-text-muted">
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
                <span className="text-xs px-2 py-0.5 bg-bg-input rounded-full">{project.status}</span>
              )}
            </div>
          </div>
          <TurnBadge whoseTurn={project.whoseTurn} daysSinceTurn={project.daysSinceTurn} />
        </div>

        {/* 마지막 활동 발췌 + 최근 timeline (전후 맥락 — 노션 안 들어가도 OK) */}
        {project.recentChanges && project.recentChanges.length > 0 ? (
          <ActivityTimeline changes={project.recentChanges} />
        ) : project.lastActivitySnippet ? (
          <div className="bg-bg-input/40 rounded-lg p-3 border-l-2 border-border">
            <p className="text-xs text-text-muted mb-1">
              <MessageSquare className="w-3 h-3 inline mr-0.5" />
              {project.lastActivityByName || '?'} ({project.lastActivityRole === 'PI' ? 'PI' : '학생'}) · {timeAgo(project.lastActivityAt)}
            </p>
            <p className="text-sm text-text-main leading-relaxed line-clamp-2">
              "{project.lastActivitySnippet}"
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
          {/* PI 차례: '검토 완료 알림 보내기' / 학생 차례: 'Slack 리마인드' */}
          <button
            onClick={onRemind}
            className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            <Send className="w-4 h-4" />
            {project.whoseTurn === 'PI' ? '검토 완료 알림' : 'Slack 리마인드'}
          </button>
        </div>

        {/* 발송된 Slack 리마인드 + ✅ 수신 상태 (펼치기) */}
        <RemindersInline projectId={project.id} />
      </div>
    </div>
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

  const items = data?.items ?? [];
  const counts = data?.counts;

  const filtered = useMemo(() => {
    if (filter === 'piTurn') return items.filter(i => i.whoseTurn === 'PI');
    if (filter === 'stale') return items.filter(i => i.whoseTurn === 'STUDENT' && i.daysSinceTurn >= 7);
    return items;
  }, [items, filter]);

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

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-5 md:space-y-6">
      {/* 헤더 */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div className="min-w-0 flex-1 flex items-center gap-3">
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
          className="inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-bg-card border border-border rounded-lg text-sm hover:text-text-heading disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? '동기화 중…' : '지금 동기화'}
        </button>
      </div>

      {/* 필터 탭 */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setFilter('piTurn')}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
            filter === 'piTurn'
              ? 'bg-red-500/15 text-red-700 dark:text-red-300 border border-red-500/30'
              : 'bg-bg-card text-text-muted border border-border hover:text-text-heading'
          }`}
        >
          🔴 내 차례 {counts && <span className="font-bold">{counts.piTurn}</span>}
        </button>
        <button
          onClick={() => setFilter('stale')}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
            filter === 'stale'
              ? 'bg-orange-500/15 text-orange-700 dark:text-orange-300 border border-orange-500/30'
              : 'bg-bg-card text-text-muted border border-border hover:text-text-heading'
          }`}
        >
          🔥 리마인드 필요 {counts && <span className="font-bold">{counts.stale7d}</span>}
        </button>
        <button
          onClick={() => setFilter('all')}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
            filter === 'all'
              ? 'bg-primary text-white'
              : 'bg-bg-card text-text-muted border border-border hover:text-text-heading'
          }`}
        >
          전체 <span className="font-bold">{items.length}</span>
        </button>
      </div>

      {/* 콘텐츠 */}
      {error && (
        <div className="bg-red-500/10 text-red-400 px-4 py-3 rounded-lg text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4" /> 데이터 로드 실패: {String(error)}
        </div>
      )}

      {isLoading && (
        <div className="space-y-3">
          {[0, 1, 2].map(i => (
            <div key={i} className="bg-bg-input/40 rounded-xl skeleton-shimmer h-32" />
          ))}
        </div>
      )}

      {!isLoading && items.length === 0 && (
        <div className="bg-bg-card border border-border rounded-xl p-10 text-center">
          <Inbox className="w-12 h-12 text-text-muted/30 mx-auto mb-4" />
          <p className="text-text-heading font-semibold text-lg mb-2">아직 동기화된 워크시트가 없습니다</p>
          <p className="text-text-muted text-sm mb-6">위의 [지금 동기화] 버튼을 눌러 첫 sync를 실행하세요.</p>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary text-white rounded-xl text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? '동기화 중…' : '지금 동기화'}
          </button>
        </div>
      )}

      {!isLoading && filtered.length === 0 && items.length > 0 && (
        <div className="bg-bg-card border border-border rounded-xl p-10 text-center">
          <p className="text-text-heading font-medium">이 필터에 해당하는 프로젝트가 없습니다 🎉</p>
          <p className="text-text-muted text-sm mt-1">다른 필터를 선택하거나 [전체]를 보세요.</p>
        </div>
      )}

      {/* 카드 목록 — 팀별 그룹 */}
      {!isLoading && filtered.length > 0 && (
        <div className="space-y-6">
          {groupedByTeam.map(([team, projects]) => (
            <div key={team} className="space-y-3">
              <h2 className="text-base font-bold text-text-heading flex items-center gap-2">
                <Users className="w-4 h-4 text-primary" />{team}
                <span className="text-xs font-normal text-text-muted">({projects.length})</span>
              </h2>
              <div className="space-y-3">
                {projects.map(p => (
                  <ProjectCard key={p.id} project={p} onRemind={() => setRemindTarget(p)} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

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
