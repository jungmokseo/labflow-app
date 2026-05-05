'use client';

import { useEffect, useMemo, useState } from 'react';
import { mutate as globalMutate } from 'swr';
import {
  archiveBlissTask,
  completeBlissTask,
  confirmBlissTask,
  createBlissTaskDirect,
  getBlissActiveTasks,
  getBlissTaskReviewQueue,
  getLabMembers,
  holdBlissTask,
  type BlissTaskActiveItem,
  type BlissTaskMetadata,
  type BlissTaskPriority,
  type BlissTaskReviewItem,
  type LabMemberOption,
} from '@/lib/api';
import { useApiData } from '@/lib/use-api';
import { useToast } from '@/components/Toast';
import { SIDEBAR_COUNT_KEYS } from '../../Sidebar';
import {
  Calendar,
  Check,
  CheckCircle,
  ClipboardList,
  Clock,
  ExternalLink,
  Loader2,
  Pause,
  Plus,
  Send,
  User,
  X,
} from 'lucide-react';

type PriorityChoice = 'AUTO' | BlissTaskPriority;

type ReviewFormState = {
  actionDate: string;
  ownerName: string;
  priority: PriorityChoice;
  memo: string;
};

type DateShortcut = readonly [label: string, value: string];

const PRIORITY_OPTIONS: ReadonlyArray<{ value: PriorityChoice; label: string }> = [
  { value: 'AUTO', label: '자동' },
  { value: 'HIGH', label: 'HIGH' },
  { value: 'MEDIUM', label: 'MEDIUM' },
  { value: 'LOW', label: 'LOW' },
];

function toDateInput(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function addDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(base.getDate() + days);
  return next;
}

function nextWeekend(): Date {
  const today = new Date();
  const day = today.getDay();
  const daysUntilSaturday = day === 6 ? 0 : (6 - day + 7) % 7;
  return addDays(today, daysUntilSaturday);
}

function nextMonday(): Date {
  const today = new Date();
  const day = today.getDay();
  const daysUntilMonday = (8 - day) % 7 || 7;
  return addDays(today, daysUntilMonday);
}

function oneMonthLater(): Date {
  const next = new Date();
  next.setMonth(next.getMonth() + 1);
  return next;
}

function defaultActionDate(): string {
  return toDateInput(addDays(new Date(), 1));
}

function dateShortcuts(): DateShortcut[] {
  return [
    ['내일', toDateInput(addDays(new Date(), 1))],
    ['이번주말', toDateInput(nextWeekend())],
    ['다음주월', toDateInput(nextMonday())],
    ['한달후', toDateInput(oneMonthLater())],
  ];
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const min = Math.max(0, Math.floor(diff / 60000));
  if (min < 1) return '방금 전';
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}일 전`;
  return new Date(dateStr).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

function sourceFromMetadata(metadata: BlissTaskMetadata | null) {
  return metadata?.blissSource || {};
}

function isHeld(task: BlissTaskReviewItem): boolean {
  return Boolean(task.metadata?.heldAt);
}

function sortReviewTasks(tasks: BlissTaskReviewItem[]): BlissTaskReviewItem[] {
  return [...tasks].sort((a, b) => {
    if (isHeld(a) !== isHeld(b)) return isHeld(a) ? 1 : -1;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
}

function previewText(text: string, expanded: boolean): string {
  if (expanded || text.length <= 200) return text;
  return `${text.slice(0, 200)}...`;
}

function defaultForm(): ReviewFormState {
  return {
    actionDate: defaultActionDate(),
    ownerName: '',
    priority: 'AUTO',
    memo: '',
  };
}

export default function BlissTaskReviewPage() {
  const { toast } = useToast();
  const { data: queueData, isLoading, mutate } = useApiData('bliss-task-review-queue', getBlissTaskReviewQueue);
  const { data: activeData, mutate: mutateActive } = useApiData('bliss-task-active', getBlissActiveTasks);
  const { data: membersData } = useApiData('lab-members-for-review', getLabMembers);
  const [tasks, setTasks] = useState<BlissTaskReviewItem[]>([]);
  const [forms, setForms] = useState<Record<string, ReviewFormState>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [dismissing, setDismissing] = useState<Record<string, boolean>>({});

  // 직접 추가 폼 상태
  const [showDirect, setShowDirect] = useState(false);
  const [directForm, setDirectForm] = useState({
    title: '',
    content: '',
    actionDate: defaultActionDate(),
    ownerName: '',
    priority: 'AUTO' as PriorityChoice,
    memo: '',
  });
  const [directBusy, setDirectBusy] = useState(false);
  const [completingId, setCompletingId] = useState<string | null>(null);

  const members = useMemo(
    () => (membersData || []).filter((m: LabMemberOption) => m.name),
    [membersData]
  );

  const activeStats = useMemo(() => {
    const list = activeData || [];
    const pending = list.filter((t: BlissTaskActiveItem) => !t.completed).length;
    const done = list.filter((t: BlissTaskActiveItem) => t.completed).length;
    return { pending, done, total: list.length };
  }, [activeData]);

  useEffect(() => {
    if (!queueData) return;
    const sorted = sortReviewTasks(queueData);
    setTasks(sorted);
    setForms(prev => {
      const next = { ...prev };
      for (const task of sorted) {
        if (!next[task.id]) next[task.id] = defaultForm();
      }
      return next;
    });
  }, [queueData]);

  function updateForm(id: string, patch: Partial<ReviewFormState>) {
    setForms(prev => ({
      ...prev,
      [id]: { ...(prev[id] || defaultForm()), ...patch },
    }));
  }

  function clearBusy(id: string) {
    setBusy(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  function removeTask(id: string) {
    setDismissing(prev => ({ ...prev, [id]: true }));
    setTimeout(() => {
      setTasks(prev => prev.filter(task => task.id !== id));
      setDismissing(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }, 180);
  }

  async function handleConfirm(task: BlissTaskReviewItem) {
    const form = forms[task.id] || defaultForm();
    if (!form.actionDate) {
      toast('마감일을 선택해 주세요.', 'error');
      return;
    }
    if (!form.ownerName) {
      toast('담당자를 선택해 주세요.', 'error');
      return;
    }

    setBusy(prev => ({ ...prev, [task.id]: 'confirm' }));
    try {
      const result = await confirmBlissTask(task.id, {
        actionDate: form.actionDate,
        ownerName: form.ownerName,
        priority: form.priority === 'AUTO' ? undefined : form.priority,
        memo: form.memo.trim() || undefined,
      });
      removeTask(task.id);
      mutate();
      globalMutate(SIDEBAR_COUNT_KEYS.review);
      if (result.notified) toast('Slack DM 발송됨', 'success');
      else toast(`확정됨. Slack DM 실패: ${result.error || '원인 미상'}`, 'info');
    } catch (error) {
      toast(error instanceof Error ? error.message : '확정 실패', 'error');
    } finally {
      clearBusy(task.id);
    }
  }

  async function handleHold(task: BlissTaskReviewItem) {
    setBusy(prev => ({ ...prev, [task.id]: 'hold' }));
    try {
      await holdBlissTask(task.id);
      const heldTask: BlissTaskReviewItem = {
        ...task,
        metadata: { ...(task.metadata || {}), heldAt: new Date().toISOString() },
      };
      setTasks(prev => sortReviewTasks([...prev.filter(item => item.id !== task.id), heldTask]));
      toast('보류됨', 'info');
      mutate();
      globalMutate(SIDEBAR_COUNT_KEYS.review);
    } catch (error) {
      toast(error instanceof Error ? error.message : '보류 실패', 'error');
    } finally {
      clearBusy(task.id);
    }
  }

  async function handleArchive(task: BlissTaskReviewItem) {
    if (!confirm('이 검토 요청을 취소하고 보관하시겠습니까?')) return;
    setBusy(prev => ({ ...prev, [task.id]: 'archive' }));
    try {
      await archiveBlissTask(task.id);
      removeTask(task.id);
      toast('취소됨', 'info');
      mutate();
      globalMutate(SIDEBAR_COUNT_KEYS.review);
    } catch (error) {
      toast(error instanceof Error ? error.message : '취소 실패', 'error');
    } finally {
      clearBusy(task.id);
    }
  }

  async function handleDirectCreate() {
    if (!directForm.title.trim()) { toast('제목을 입력해 주세요.', 'error'); return; }
    if (!directForm.actionDate) { toast('마감일을 선택해 주세요.', 'error'); return; }
    if (!directForm.ownerName) { toast('담당자를 선택해 주세요.', 'error'); return; }
    setDirectBusy(true);
    try {
      const result = await createBlissTaskDirect({
        title: directForm.title.trim(),
        content: directForm.content.trim() || undefined,
        actionDate: directForm.actionDate,
        ownerName: directForm.ownerName,
        priority: directForm.priority === 'AUTO' ? undefined : directForm.priority,
        memo: directForm.memo.trim() || undefined,
      });
      if (result.notified) toast('할 일 추가됨 + Slack DM 발송', 'success');
      else toast(`추가됨. Slack DM 실패: ${result.error || '원인 미상'}`, 'info');
      setDirectForm({
        title: '',
        content: '',
        actionDate: defaultActionDate(),
        ownerName: '',
        priority: 'AUTO',
        memo: '',
      });
      setShowDirect(false);
      mutateActive();
    } catch (error) {
      toast(error instanceof Error ? error.message : '추가 실패', 'error');
    } finally {
      setDirectBusy(false);
    }
  }

  async function handleComplete(task: BlissTaskActiveItem) {
    setCompletingId(task.id);
    try {
      await completeBlissTask(task.id, !task.completed);
      toast(task.completed ? '미완료로 변경' : '완료 처리됨', 'success');
      mutateActive();
    } catch (error) {
      toast(error instanceof Error ? error.message : '완료 처리 실패', 'error');
    } finally {
      setCompletingId(null);
    }
  }

  const firstLoad = isLoading && !queueData;

  return (
    <div className="min-h-screen bg-bg pb-20 md:pb-12">
      {/* 표준 헤더 */}
      <div className="px-4 md:px-8 pt-4 md:pt-8 pb-4">
        <div className="flex items-start gap-3 mb-1">
          <span className="w-1 h-9 md:h-11 bg-primary rounded-full flex-shrink-0 mt-1" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <h1 className="text-2xl md:text-3xl font-bold text-text-heading tracking-tight flex items-center gap-2 leading-tight">
                  <ClipboardList className="w-6 h-6 text-primary flex-shrink-0" />
                  BLISS 검토 큐
                </h1>
                <p className="text-sm md:text-base text-text-muted mt-1">
                  {tasks.length}개 대기 중 · 진행 중 {activeStats.pending}건
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowDirect(prev => !prev)}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-primary text-white hover:bg-primary/90 shadow-card text-sm font-medium h-9 flex-shrink-0"
              >
                <Plus className="w-4 h-4" />
                직접 추가
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 md:px-8">
        {showDirect && (
          <DirectAddForm
            form={directForm}
            members={members}
            busy={directBusy}
            onChange={patch => setDirectForm(prev => ({ ...prev, ...patch }))}
            onCancel={() => setShowDirect(false)}
            onSubmit={handleDirectCreate}
          />
        )}

        {firstLoad ? (
          <div className="flex items-center justify-center min-h-[45vh]">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : tasks.length === 0 ? (
          <EmptyState
            icon={<CheckCircle className="w-10 h-10 text-accent" />}
            title="검토할 요청이 없습니다."
          />
        ) : (
          <div className="space-y-3 md:space-y-4">
            {tasks.map(task => (
              <ReviewCard
                key={task.id}
                task={task}
                form={forms[task.id] || defaultForm()}
                members={members}
                expanded={Boolean(expanded[task.id])}
                taskBusy={busy[task.id]}
                dismissing={Boolean(dismissing[task.id])}
                onUpdateForm={patch => updateForm(task.id, patch)}
                onToggleExpand={() => setExpanded(prev => ({ ...prev, [task.id]: !prev[task.id] }))}
                onArchive={() => handleArchive(task)}
                onHold={() => handleHold(task)}
                onConfirm={() => handleConfirm(task)}
              />
            ))}
          </div>
        )}

        {/* 진행 중 task list */}
        {activeData && activeData.length > 0 && (
          <section className="mt-8 md:mt-10">
            <h2 className="text-base md:text-lg font-semibold text-text-heading mb-3 flex items-center gap-2">
              <ClipboardList className="w-5 h-5 text-text-muted" />
              진행 중
              <span className="text-sm text-text-muted font-normal">
                ({activeStats.pending}건 · 완료 {activeStats.done}건)
              </span>
            </h2>
            <ul className="bg-bg-card border border-border rounded-lg divide-y divide-border overflow-hidden">
              {activeData.map((task: BlissTaskActiveItem) => (
                <ActiveTaskRow
                  key={task.id}
                  task={task}
                  completing={completingId === task.id}
                  onComplete={() => handleComplete(task)}
                />
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

// ── 직접 추가 폼 ──────────────────────────────────────────

interface DirectAddFormProps {
  form: {
    title: string;
    content: string;
    actionDate: string;
    ownerName: string;
    priority: PriorityChoice;
    memo: string;
  };
  members: LabMemberOption[];
  busy: boolean;
  onChange: (patch: Partial<DirectAddFormProps['form']>) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

function DirectAddForm({ form, members, busy, onChange, onCancel, onSubmit }: DirectAddFormProps) {
  const shortcuts = dateShortcuts();
  return (
    <section className="mb-4 md:mb-6 bg-bg-card border border-border rounded-lg shadow-card p-3 md:p-5">
      <h2 className="text-sm font-semibold text-text-heading mb-3">
        새 할 일 직접 추가 (즉시 학생에게 발송)
      </h2>
      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-text-muted mb-1.5">제목</label>
          <input
            type="text"
            value={form.title}
            onChange={e => onChange({ title: e.target.value })}
            placeholder="예: BRL 영수증 처리"
            className="w-full bg-bg-input border border-border rounded-lg px-3 py-2 text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-text-muted mb-1.5">설명 (선택)</label>
          <textarea
            value={form.content}
            onChange={e => onChange({ content: e.target.value })}
            rows={2}
            placeholder="task 상세 설명. 비우면 제목만 사용."
            className="w-full bg-bg-input border border-border rounded-lg px-3 py-2 text-sm text-text-heading placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="block text-xs font-medium text-text-muted mb-1.5">마감일</label>
            <div className="flex flex-col gap-2">
              <div className="relative">
                <Calendar className="w-4 h-4 text-text-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="date"
                  value={form.actionDate}
                  onChange={e => onChange({ actionDate: e.target.value })}
                  className="w-full bg-bg-input border border-border rounded-lg pl-9 pr-3 py-2 text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
              <div className="grid grid-cols-4 gap-1.5">
                {shortcuts.map(([label, value]) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => onChange({ actionDate: value })}
                    className={`px-2 py-2 text-xs rounded-lg border border-border ${
                      form.actionDate === value
                        ? 'bg-primary text-white border-primary'
                        : 'bg-bg-card text-text-muted hover:text-text-heading hover:bg-bg-hover'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-text-muted mb-1.5">담당자</label>
            <select
              value={form.ownerName}
              onChange={e => onChange({ ownerName: e.target.value })}
              className="w-full bg-bg-input border border-border rounded-lg px-3 py-2 text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              <option value="">담당자 선택</option>
              {members.map(member => (
                <option key={member.id} value={member.name}>
                  {member.name}{member.role ? ` · ${member.role}` : ''}
                </option>
              ))}
            </select>
            <label className="block text-xs font-medium text-text-muted mt-3 mb-1.5">우선순위</label>
            <PriorityPicker
              value={form.priority}
              onChange={priority => onChange({ priority })}
            />
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-text-muted mb-1.5">
            메모 (선택, Slack DM에 함께 전송)
          </label>
          <textarea
            value={form.memo}
            onChange={e => onChange({ memo: e.target.value })}
            rows={2}
            className="w-full bg-bg-input border border-border rounded-lg px-3 py-2 text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 rounded-lg border border-border text-text-muted hover:text-text-heading hover:bg-bg-hover disabled:opacity-50 text-sm h-9"
          >
            취소
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={busy}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-primary text-white hover:bg-primary/90 disabled:opacity-50 shadow-card text-sm font-medium h-9"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            추가 + 학생 알림
          </button>
        </div>
      </div>
    </section>
  );
}

// ── 검토 카드 ─────────────────────────────────────────────

interface ReviewCardProps {
  task: BlissTaskReviewItem;
  form: ReviewFormState;
  members: LabMemberOption[];
  expanded: boolean;
  taskBusy: string | undefined;
  dismissing: boolean;
  onUpdateForm: (patch: Partial<ReviewFormState>) => void;
  onToggleExpand: () => void;
  onArchive: () => void;
  onHold: () => void;
  onConfirm: () => void;
}

function ReviewCard({
  task,
  form,
  members,
  expanded,
  taskBusy,
  dismissing,
  onUpdateForm,
  onToggleExpand,
  onArchive,
  onHold,
  onConfirm,
}: ReviewCardProps) {
  const source = sourceFromMetadata(task.metadata);
  const held = isHeld(task);
  const shortcuts = dateShortcuts();
  const busyAny = Boolean(taskBusy);

  return (
    <article
      className={`bg-bg-card border rounded-lg shadow-card transition-all duration-200 ${
        dismissing ? 'opacity-0 translate-y-2' : 'opacity-100 translate-y-0'
      } ${held ? 'border-amber-500/40 ring-1 ring-amber-500/10' : 'border-border'}`}
    >
      {/* 헤더: 제목 + 메타 */}
      <div className="p-3 md:p-5 border-b border-border">
        <div className="min-w-0">
          {held && (
            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 border border-amber-500/20 mb-2">
              <Pause className="w-3 h-3" /> 보류 중
            </span>
          )}
          <h2 className="text-base md:text-lg font-semibold text-text-heading break-words leading-snug">
            {task.title}
          </h2>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-xs text-text-muted">
            <span className="inline-flex items-center gap-1">
              <Clock className="w-3.5 h-3.5" />
              {timeAgo(task.createdAt)}
            </span>
            {source.requesterName && (
              <span className="inline-flex items-center gap-1">
                <User className="w-3.5 h-3.5" />
                {source.requesterName}
              </span>
            )}
            {source.sourceChannel && (
              <span className="text-text-muted">#{source.sourceChannel}</span>
            )}
            {source.slackPermalink && (
              <a
                href={source.slackPermalink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                Slack <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
        </div>

        <div className="mt-3 text-sm text-text-main leading-relaxed whitespace-pre-wrap break-words bg-bg-input/40 border border-border rounded-lg p-3">
          {previewText(task.content, expanded)}
          {task.content.length > 200 && (
            <button
              type="button"
              onClick={onToggleExpand}
              className="ml-2 text-primary text-sm hover:underline"
            >
              {expanded ? '접기' : '더보기'}
            </button>
          )}
        </div>
      </div>

      {/* 폼 영역 */}
      <div className="p-3 md:p-5">
        <div className="grid gap-4 lg:grid-cols-[1.15fr_0.9fr]">
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1.5">마감일</label>
              <div className="flex flex-col gap-2">
                <div className="relative">
                  <Calendar className="w-4 h-4 text-text-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="date"
                    value={form.actionDate}
                    onChange={event => onUpdateForm({ actionDate: event.target.value })}
                    className="w-full bg-bg-input border border-border rounded-lg pl-9 pr-3 py-2 text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  {shortcuts.map(([label, value]) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => onUpdateForm({ actionDate: value })}
                      className={`px-2 py-2 text-xs rounded-lg border border-border ${
                        form.actionDate === value
                          ? 'bg-primary text-white border-primary'
                          : 'bg-bg-card text-text-muted hover:text-text-heading hover:bg-bg-hover'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-text-muted mb-1.5">담당자</label>
                <select
                  value={form.ownerName}
                  onChange={event => onUpdateForm({ ownerName: event.target.value })}
                  className="w-full bg-bg-input border border-border rounded-lg px-3 py-2 text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary/30"
                >
                  <option value="">담당자 선택</option>
                  {members.map(member => (
                    <option key={member.id} value={member.name}>
                      {member.name}{member.role ? ` · ${member.role}` : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-text-muted mb-1.5">우선순위</label>
                <PriorityPicker
                  value={form.priority}
                  onChange={priority => onUpdateForm({ priority })}
                />
              </div>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-text-muted mb-1.5">메모</label>
            <textarea
              value={form.memo}
              onChange={event => onUpdateForm({ memo: event.target.value })}
              rows={5}
              placeholder="학생에게 전달할 메모"
              className="w-full min-h-[100px] md:min-h-[116px] resize-none bg-bg-input border border-border rounded-lg px-3 py-2 text-sm text-text-heading placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
        </div>

        {/* 액션 버튼: 모바일에서 wrap, 데스크탑에서 우측 정렬 */}
        <div className="mt-4 flex flex-wrap gap-2 sm:justify-end">
          <button
            type="button"
            onClick={onArchive}
            disabled={busyAny}
            className="flex-1 sm:flex-none min-w-[6rem] inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-border text-text-muted hover:text-text-heading hover:bg-bg-hover disabled:opacity-50 text-sm h-9"
          >
            {taskBusy === 'archive' ? <Loader2 className="w-4 h-4 animate-spin" /> : <X className="w-4 h-4" />}
            취소
          </button>
          <button
            type="button"
            onClick={onHold}
            disabled={busyAny}
            className={`flex-1 sm:flex-none min-w-[6rem] inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border text-sm h-9 disabled:opacity-50 ${
              held
                ? 'border-amber-500/40 bg-amber-500/15 text-amber-600'
                : 'border-amber-500/20 text-amber-600 hover:bg-amber-500/10'
            }`}
          >
            {taskBusy === 'hold' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Pause className="w-4 h-4" />}
            {held ? '보류됨' : '보류'}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busyAny}
            className="flex-1 sm:flex-none min-w-[8rem] inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-white hover:bg-primary/90 disabled:opacity-50 shadow-card text-sm font-medium h-9"
          >
            {taskBusy === 'confirm' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            확정 + 알림
          </button>
        </div>
      </div>
    </article>
  );
}

// ── 우선순위 picker ────────────────────────────────────────

function PriorityPicker({
  value,
  onChange,
}: {
  value: PriorityChoice;
  onChange: (value: PriorityChoice) => void;
}) {
  return (
    <div className="grid grid-cols-4 gap-1 bg-bg-input border border-border rounded-lg p-1">
      {PRIORITY_OPTIONS.map(option => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={`px-2 py-1.5 rounded-md text-xs font-medium transition-colors ${
            value === option.value
              ? 'bg-primary text-white'
              : 'text-text-muted hover:text-text-heading hover:bg-bg-card'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

// ── 진행 중 task row ──────────────────────────────────────

interface ActiveTaskRowProps {
  task: BlissTaskActiveItem;
  completing: boolean;
  onComplete: () => void;
}

function ActiveTaskRow({ task, completing, onComplete }: ActiveTaskRowProps) {
  const owner = task.metadata?.assignedOwner || task.metadata?.blissDirect?.assignedOwner || '?';
  const due = task.actionDate
    ? new Date(task.actionDate).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })
    : '미정';
  const overdue =
    task.actionDate && !task.completed && new Date(task.actionDate).getTime() < Date.now() - 24 * 3600 * 1000;
  const slackLink = task.metadata?.blissSource?.slackPermalink;

  return (
    <li className={`flex items-center gap-3 p-3 ${task.completed ? 'opacity-50' : ''}`}>
      <button
        type="button"
        onClick={onComplete}
        disabled={completing}
        className={`flex-shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
          task.completed ? 'bg-accent border-accent' : 'border-border hover:border-primary'
        } disabled:opacity-50`}
        title={task.completed ? '완료 취소' : '완료 처리'}
      >
        {completing ? (
          <Loader2 className="w-3 h-3 animate-spin text-text-muted" />
        ) : task.completed ? (
          <Check className="w-3.5 h-3.5 text-white" />
        ) : null}
      </button>
      <div className="min-w-0 flex-1">
        <div
          className={`text-sm font-medium text-text-heading break-words leading-snug ${
            task.completed ? 'line-through' : ''
          }`}
        >
          {task.title}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 text-xs text-text-muted">
          <span className="inline-flex items-center gap-1">
            <User className="w-3 h-3" />{owner}
          </span>
          <span className={`inline-flex items-center gap-1 ${overdue ? 'text-red-500 font-medium' : ''}`}>
            <Calendar className="w-3 h-3" />{due}
          </span>
          {task.priority === 'HIGH' && (
            <span className="text-red-500 font-medium">HIGH</span>
          )}
          {slackLink && (
            <a
              href={slackLink}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline inline-flex items-center gap-0.5"
            >
              Slack <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
      </div>
    </li>
  );
}

// ── Empty state ───────────────────────────────────────────

function EmptyState({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="bg-bg-card border border-border rounded-lg shadow-card p-8 text-center">
      <div className="mx-auto mb-3 flex justify-center">{icon}</div>
      <p className="text-text-heading font-medium">{title}</p>
    </div>
  );
}
