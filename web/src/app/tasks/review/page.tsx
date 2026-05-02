'use client';

import { useEffect, useMemo, useState } from 'react';
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

const PRIORITY_OPTIONS: Array<{ value: PriorityChoice; label: string }> = [
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

  const members = useMemo(() => (membersData || []).filter((m: LabMemberOption) => m.name), [membersData]);

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
      if (result.notified) toast('Slack DM 발송됨', 'success');
      else toast(`확정됨. Slack DM 실패: ${result.error || '원인 미상'}`, 'info');
    } catch (error) {
      toast(error instanceof Error ? error.message : '확정 실패', 'error');
    } finally {
      setBusy(prev => {
        const next = { ...prev };
        delete next[task.id];
        return next;
      });
    }
  }

  async function handleHold(task: BlissTaskReviewItem) {
    setBusy(prev => ({ ...prev, [task.id]: 'hold' }));
    try {
      await holdBlissTask(task.id);
      const heldTask = {
        ...task,
        metadata: { ...(task.metadata || {}), heldAt: new Date().toISOString() },
      };
      setTasks(prev => sortReviewTasks([...prev.filter(item => item.id !== task.id), heldTask]));
      toast('보류됨', 'info');
      mutate();
    } catch (error) {
      toast(error instanceof Error ? error.message : '보류 실패', 'error');
    } finally {
      setBusy(prev => {
        const next = { ...prev };
        delete next[task.id];
        return next;
      });
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
    } catch (error) {
      toast(error instanceof Error ? error.message : '취소 실패', 'error');
    } finally {
      setBusy(prev => {
        const next = { ...prev };
        delete next[task.id];
        return next;
      });
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
    <div className="min-h-screen bg-bg">
      <div className="max-w-5xl mx-auto px-4 py-6 md:px-8 md:py-8">
        <header className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-text-heading flex items-center gap-2">
              <ClipboardList className="w-6 h-6 text-primary" />
              📥 BLISS 검토 대기 큐
            </h1>
            <p className="text-sm text-text-muted mt-1">{tasks.length}개 대기 중 · 진행 중 {(activeData || []).filter((t: BlissTaskActiveItem) => !t.completed).length}건</p>
          </div>
          <button
            type="button"
            onClick={() => setShowDirect(prev => !prev)}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-primary text-white hover:bg-primary-hover shadow-card text-sm font-medium"
          >
            <Plus className="w-4 h-4" />
            직접 추가
          </button>
        </header>

        {showDirect && (
          <section className="mb-6 bg-bg-card border border-border rounded-lg shadow-card p-4 md:p-5">
            <h2 className="text-sm font-semibold text-text-heading mb-3">+ 새 할 일 직접 추가 (즉시 학생에게 발송)</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-text-muted mb-1.5">제목</label>
                <input
                  type="text"
                  value={directForm.title}
                  onChange={e => setDirectForm(f => ({ ...f, title: e.target.value }))}
                  placeholder="예: BRL 영수증 처리"
                  className="w-full bg-bg-input border border-border rounded-lg px-3 py-2 text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-text-muted mb-1.5">설명 (선택)</label>
                <textarea
                  value={directForm.content}
                  onChange={e => setDirectForm(f => ({ ...f, content: e.target.value }))}
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
                      <Calendar className="w-4 h-4 text-text-muted absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        type="date"
                        value={directForm.actionDate}
                        onChange={e => setDirectForm(f => ({ ...f, actionDate: e.target.value }))}
                        className="w-full bg-bg-input border border-border rounded-lg pl-9 pr-3 py-2 text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary/30"
                      />
                    </div>
                    <div className="grid grid-cols-4 gap-1.5">
                      {[
                        ['내일', toDateInput(addDays(new Date(), 1))],
                        ['이번주말', toDateInput(nextWeekend())],
                        ['다음주월', toDateInput(nextMonday())],
                        ['한달후', toDateInput(oneMonthLater())],
                      ].map(([label, value]) => (
                        <button
                          key={label}
                          type="button"
                          onClick={() => setDirectForm(f => ({ ...f, actionDate: value }))}
                          className="px-2 py-1.5 text-xs rounded-lg border border-border bg-bg-card text-text-muted hover:text-text-heading hover:bg-bg-hover"
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
                    value={directForm.ownerName}
                    onChange={e => setDirectForm(f => ({ ...f, ownerName: e.target.value }))}
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
                  <div className="grid grid-cols-4 gap-1 bg-bg-input border border-border rounded-lg p-1">
                    {PRIORITY_OPTIONS.map(option => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setDirectForm(f => ({ ...f, priority: option.value }))}
                        className={`px-2 py-1.5 rounded-md text-xs font-medium transition-colors ${
                          directForm.priority === option.value
                            ? 'bg-primary text-white'
                            : 'text-text-muted hover:text-text-heading hover:bg-bg-card'
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-text-muted mb-1.5">메모 (선택, Slack DM에 함께 전송)</label>
                <textarea
                  value={directForm.memo}
                  onChange={e => setDirectForm(f => ({ ...f, memo: e.target.value }))}
                  rows={2}
                  className="w-full bg-bg-input border border-border rounded-lg px-3 py-2 text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowDirect(false)}
                  disabled={directBusy}
                  className="px-4 py-2 rounded-lg border border-border text-text-muted hover:text-text-heading hover:bg-bg-hover disabled:opacity-50 text-sm"
                >
                  취소
                </button>
                <button
                  type="button"
                  onClick={handleDirectCreate}
                  disabled={directBusy}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-primary text-white hover:bg-primary-hover disabled:opacity-50 shadow-card text-sm font-medium"
                >
                  {directBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  추가 + 학생 알림
                </button>
              </div>
            </div>
          </section>
        )}

        {firstLoad ? (
          <div className="flex items-center justify-center min-h-[45vh]">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : tasks.length === 0 ? (
          <div className="bg-bg-card border border-border rounded-lg shadow-card p-8 text-center">
            <CheckCircle className="w-10 h-10 mx-auto text-accent mb-3" />
            <p className="text-text-heading font-medium">검토할 요청이 없습니다.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {tasks.map(task => {
              const form = forms[task.id] || defaultForm();
              const source = sourceFromMetadata(task.metadata);
              const taskBusy = busy[task.id];
              const expandedContent = Boolean(expanded[task.id]);

              return (
                <article
                  key={task.id}
                  className={`bg-bg-card border border-border rounded-lg shadow-card transition-all duration-200 ${
                    dismissing[task.id] ? 'opacity-0 translate-y-2' : 'opacity-100 translate-y-0'
                  } ${isHeld(task) ? 'border-amber-500/30' : ''}`}
                >
                  <div className="p-4 md:p-5 border-b border-border">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          {isHeld(task) && (
                            <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 border border-amber-500/20">
                              보류
                            </span>
                          )}
                          <h2 className="text-lg font-semibold text-text-heading break-words">{task.title}</h2>
                        </div>
                        <div className="flex flex-wrap items-center gap-3 text-xs text-text-muted">
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
                          {source.sourceChannel && <span>#{source.sourceChannel}</span>}
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
                    </div>

                    <div className="mt-4 text-sm text-text-main leading-6 whitespace-pre-wrap break-words bg-bg-input/40 border border-border rounded-lg p-3">
                      {previewText(task.content, expandedContent)}
                      {task.content.length > 200 && (
                        <button
                          type="button"
                          onClick={() => setExpanded(prev => ({ ...prev, [task.id]: !expandedContent }))}
                          className="ml-2 text-primary text-sm hover:underline"
                        >
                          {expandedContent ? '접기' : '더보기'}
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="p-4 md:p-5">
                    <div className="grid gap-4 lg:grid-cols-[1.15fr_0.9fr]">
                      <div className="space-y-3">
                        <div>
                          <label className="block text-xs font-medium text-text-muted mb-1.5">마감일</label>
                          <div className="flex flex-col gap-2 sm:flex-row">
                            <div className="relative sm:w-48">
                              <Calendar className="w-4 h-4 text-text-muted absolute left-3 top-1/2 -translate-y-1/2" />
                              <input
                                type="date"
                                value={form.actionDate}
                                onChange={event => updateForm(task.id, { actionDate: event.target.value })}
                                className="w-full bg-bg-input border border-border rounded-lg pl-9 pr-3 py-2 text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary/30"
                              />
                            </div>
                            <div className="grid grid-cols-2 sm:flex gap-1.5">
                              {[
                                ['내일', toDateInput(addDays(new Date(), 1))],
                                ['이번주말', toDateInput(nextWeekend())],
                                ['다음주월', toDateInput(nextMonday())],
                                ['한달후', toDateInput(oneMonthLater())],
                              ].map(([label, value]) => (
                                <button
                                  key={label}
                                  type="button"
                                  onClick={() => updateForm(task.id, { actionDate: value })}
                                  className="px-3 py-2 text-xs rounded-lg border border-border bg-bg-card text-text-muted hover:text-text-heading hover:bg-bg-hover"
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
                              onChange={event => updateForm(task.id, { ownerName: event.target.value })}
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
                            <div className="grid grid-cols-4 gap-1 bg-bg-input border border-border rounded-lg p-1">
                              {PRIORITY_OPTIONS.map(option => (
                                <button
                                  key={option.value}
                                  type="button"
                                  onClick={() => updateForm(task.id, { priority: option.value })}
                                  className={`px-2 py-1.5 rounded-md text-xs font-medium transition-colors ${
                                    form.priority === option.value
                                      ? 'bg-primary text-white'
                                      : 'text-text-muted hover:text-text-heading hover:bg-bg-card'
                                  }`}
                                >
                                  {option.label}
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-text-muted mb-1.5">메모</label>
                        <textarea
                          value={form.memo}
                          onChange={event => updateForm(task.id, { memo: event.target.value })}
                          rows={5}
                          placeholder="학생에게 전달할 메모"
                          className="w-full min-h-[116px] resize-none bg-bg-input border border-border rounded-lg px-3 py-2 text-sm text-text-heading placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/30"
                        />
                      </div>
                    </div>

                    <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                      <button
                        type="button"
                        onClick={() => handleArchive(task)}
                        disabled={Boolean(taskBusy)}
                        className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-border text-text-muted hover:text-text-heading hover:bg-bg-hover disabled:opacity-50"
                      >
                        {taskBusy === 'archive' ? <Loader2 className="w-4 h-4 animate-spin" /> : <X className="w-4 h-4" />}
                        취소
                      </button>
                      <button
                        type="button"
                        onClick={() => handleHold(task)}
                        disabled={Boolean(taskBusy)}
                        className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-amber-500/20 text-amber-600 hover:bg-amber-500/10 disabled:opacity-50"
                      >
                        {taskBusy === 'hold' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Pause className="w-4 h-4" />}
                        보류
                      </button>
                      <button
                        type="button"
                        onClick={() => handleConfirm(task)}
                        disabled={Boolean(taskBusy)}
                        className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-primary text-white hover:bg-primary-hover disabled:opacity-50 shadow-card"
                      >
                        {taskBusy === 'confirm' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                        확정 + 알림
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {/* 진행 중 task list */}
        {activeData && activeData.length > 0 && (
          <section className="mt-10">
            <h2 className="text-lg font-semibold text-text-heading mb-3 flex items-center gap-2">
              <ClipboardList className="w-5 h-5 text-text-muted" />
              진행 중 ({activeData.filter((t: BlissTaskActiveItem) => !t.completed).length}건 · 완료 {activeData.filter((t: BlissTaskActiveItem) => t.completed).length}건)
            </h2>
            <ul className="bg-bg-card border border-border rounded-lg divide-y divide-border">
              {activeData.map((task: BlissTaskActiveItem) => {
                const owner = task.metadata?.assignedOwner || task.metadata?.blissDirect?.assignedOwner || '?';
                const due = task.actionDate ? new Date(task.actionDate).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' }) : '미정';
                const overdue = task.actionDate && !task.completed && new Date(task.actionDate).getTime() < Date.now() - 24 * 3600 * 1000;
                return (
                  <li key={task.id} className={`flex items-center gap-3 p-3 ${task.completed ? 'opacity-50' : ''}`}>
                    <button
                      type="button"
                      onClick={() => handleComplete(task)}
                      disabled={completingId === task.id}
                      className={`flex-shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                        task.completed ? 'bg-accent border-accent' : 'border-border hover:border-primary'
                      } disabled:opacity-50`}
                      title={task.completed ? '완료 취소' : '완료 처리'}
                    >
                      {completingId === task.id ? (
                        <Loader2 className="w-3 h-3 animate-spin text-text-muted" />
                      ) : task.completed ? (
                        <Check className="w-3.5 h-3.5 text-white" />
                      ) : null}
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className={`text-sm font-medium text-text-heading break-words ${task.completed ? 'line-through' : ''}`}>
                        {task.title}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-0.5 text-xs text-text-muted">
                        <span className="inline-flex items-center gap-1">
                          <User className="w-3 h-3" />{owner}
                        </span>
                        <span className={`inline-flex items-center gap-1 ${overdue ? 'text-red-500 font-medium' : ''}`}>
                          <Calendar className="w-3 h-3" />{due}
                        </span>
                        {task.priority === 'HIGH' && <span className="text-red-500">HIGH</span>}
                        {task.metadata?.blissSource?.slackPermalink && (
                          <a href={task.metadata.blissSource.slackPermalink} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-0.5">
                            Slack <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
