'use client';

import { useState, useRef } from 'react';
import { mutate as globalMutate } from 'swr';
import {
  getCaptures, createCapture, updateCapture, deleteCapture, deleteCompletedCaptures,
  type Capture,
} from '@/lib/api';
import { useApiData } from '@/lib/use-api';
import {
  CheckCircle, Lightbulb, FileText, ClipboardList, Calendar, Mic,
  X, Pencil, Trash2, ExternalLink, PlayCircle, Send,
} from 'lucide-react';
import { useToast } from '@/components/Toast';

type TabFilter = 'all' | 'TASK' | 'IDEA' | 'MEMO';

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  task: <CheckCircle className="w-4 h-4 text-green-400" />,
  idea: <Lightbulb className="w-4 h-4 text-amber-600" />,
  memo: <FileText className="w-4 h-4 text-gray-400" />,
};

const PRIORITY_INFO: Record<string, { label: string; color: string }> = {
  high: { label: 'HIGH', color: 'bg-red-500/10 text-red-400 border-red-500/20' },
  medium: { label: 'MED', color: 'bg-orange-500/10 text-orange-400 border-orange-500/20' },
  low: { label: 'LOW', color: 'bg-gray-500/10 text-gray-500 border-gray-500/20' },
};

const TABS: ReadonlyArray<readonly [TabFilter, string]> = [
  ['all', '전체'],
  ['TASK', '할일'],
  ['IDEA', '아이디어'],
  ['MEMO', '메모'],
];

// URL detection
const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/g;
const YOUTUBE_REGEX = /https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//;

function renderContentWithLinks(text: string) {
  const parts: (string | JSX.Element)[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const regex = new RegExp(URL_REGEX.source, 'g');

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const url = match[0];
    const isYoutube = YOUTUBE_REGEX.test(url);
    const displayUrl = url.length > 50 ? url.slice(0, 47) + '...' : url;
    parts.push(
      <a
        key={match.index}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary underline hover:opacity-80 inline-flex items-center gap-1 break-all"
        onClick={(e) => e.stopPropagation()}
      >
        {isYoutube && <PlayCircle className="w-3.5 h-3.5 inline flex-shrink-0" />}
        {!isYoutube && <ExternalLink className="w-3 h-3 inline flex-shrink-0" />}
        {displayUrl}
      </a>
    );
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts.length > 0 ? parts : [text];
}

export default function TasksPage() {
  const [tab, setTab] = useState<TabFilter>('all');
  const [newInput, setNewInput] = useState('');
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { toast } = useToast();

  // Fetch active tasks
  const { data: activeData, isLoading: loadingActive, isValidating: validatingActive, mutate: refreshActive } = useApiData(
    `captures-${tab}-active`,
    async () => {
      return await getCaptures({
        category: tab === 'all' ? undefined : tab,
        completed: 'false',
        sort: 'newest',
        limit: 100,
      });
    }
  );

  // Fetch completed tasks
  const { data: completedData, mutate: refreshCompleted } = useApiData(
    `captures-${tab}-completed`,
    async () => {
      return await getCaptures({
        category: tab === 'all' ? undefined : tab,
        completed: 'true',
        sort: 'newest',
        limit: 20,
      });
    }
  );

  const activeCaptures = activeData?.data || [];
  const completedCaptures = completedData?.data || [];
  const meta = activeData?.meta || null;

  async function handleAdd() {
    if (!newInput.trim()) return;
    const inputText = newInput.trim();
    setNewInput('');
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.focus(); // 연속 입력을 위해 즉시 포커스 유지
    }
    // API 호출은 백그라운드 — 입력창은 즉시 비워서 연속 입력 가능
    // 현재 탭의 카테고리를 명시 전달 (AI 재분류로 다른 탭에 뜨는 문제 방지)
    createCapture(inputText, tab !== 'all' ? tab : undefined).then(res => {
      if (res.data) {
        refreshActive((prev: any) => prev ? { ...prev, data: [res.data, ...(prev.data || [])] } : prev, { revalidate: false });
      }
      // 1초 후 서버와 동기화 — 모든 탭 캐시 갱신
      setTimeout(() => {
        globalMutate((key: any) => typeof key === 'string' && key.startsWith('captures-'));
      }, 1000);
    }).catch((err: any) => {
      setError(err.message);
      toast('저장 실패: ' + inputText.slice(0, 20), 'error');
      refreshActive(); // 실패 시 서버 상태로 롤백
    });
  }

  async function handleToggleComplete(c: Capture) {
    const newCompleted = !c.completed;
    if (newCompleted) {
      refreshActive((prev: any) => prev ? { ...prev, data: (prev.data || []).filter((cap: Capture) => cap.id !== c.id) } : prev, { revalidate: false });
      refreshCompleted((prev: any) => prev ? { ...prev, data: [{ ...c, completed: true }, ...(prev.data || [])] } : prev, { revalidate: false });
    } else {
      refreshCompleted((prev: any) => prev ? { ...prev, data: (prev.data || []).filter((cap: Capture) => cap.id !== c.id) } : prev, { revalidate: false });
      refreshActive((prev: any) => prev ? { ...prev, data: [{ ...c, completed: false }, ...(prev.data || [])] } : prev, { revalidate: false });
    }
    try {
      await updateCapture(c.id, { completed: newCompleted });
      toast(newCompleted ? '완료 처리됨' : '미완료로 변경됨', 'success');
    } catch {
      refreshActive();
      refreshCompleted();
      toast('변경 실패. 다시 시도해 주세요.', 'error');
    }
  }

  async function handleReview(c: Capture) {
    refreshActive((prev: any) => prev ? { ...prev, data: (prev.data || []).map((cap: Capture) => cap.id === c.id ? { ...cap, reviewed: true } : cap) } : prev, { revalidate: false });
    try {
      await updateCapture(c.id, { reviewed: true });
    } catch { refreshActive(); }
  }

  async function handleDelete(id: string) {
    refreshActive((prev: any) => prev ? { ...prev, data: (prev.data || []).filter((cap: Capture) => cap.id !== id) } : prev, { revalidate: false });
    refreshCompleted((prev: any) => prev ? { ...prev, data: (prev.data || []).filter((cap: Capture) => cap.id !== id) } : prev, { revalidate: false });
    try {
      await deleteCapture(id);
      toast('삭제됨', 'info');
    } catch { refreshActive(); refreshCompleted(); toast('삭제 실패', 'error'); }
  }

  async function handleClearCompleted() {
    refreshCompleted((prev: any) => prev ? { ...prev, data: [] } : prev, { revalidate: false });
    try {
      await deleteCompletedCaptures();
      toast('완료 항목 삭제됨', 'info');
    } catch { refreshCompleted(); }
  }

  async function handleSaveEdit(c: Capture) {
    if (!editContent.trim()) return;
    const updatedContent = editContent.trim();
    // summary도 함께 갱신 — 메인 리스트 제목에 반영
    const updatedSummary = updatedContent.substring(0, 80);
    const updateFn = (prev: any) => prev ? {
      ...prev,
      data: (prev.data || []).map((cap: Capture) =>
        cap.id === c.id ? { ...cap, content: updatedContent, summary: updatedSummary } : cap
      ),
    } : prev;
    refreshActive(updateFn, { revalidate: false });
    refreshCompleted(updateFn, { revalidate: false });
    setEditingId(null);
    try {
      await updateCapture(c.id, { content: updatedContent, summary: updatedSummary });
      toast('수정됨', 'success');
      // 서버 응답으로 최신 상태 동기화 (AI 재분류 결과 반영) — 모든 탭 캐시 갱신
      setTimeout(() => {
        globalMutate((key: any) => typeof key === 'string' && key.startsWith('captures-'));
      }, 1500);
    } catch {
      refreshActive();
      refreshCompleted();
      toast('수정 실패', 'error');
    }
  }

  function handleStartEdit(c: Capture) {
    setEditingId(c.id);
    setEditContent(c.content);
  }

  function handleCancelEdit() {
    setEditingId(null);
    setEditContent('');
  }

  function toggleExpand(c: Capture) {
    if (expandedId === c.id) {
      setExpandedId(null);
      setEditingId(null);
    } else {
      setExpandedId(c.id);
      setEditingId(null);
      if (!c.reviewed && !c.completed) handleReview(c);
    }
  }

  function handleInputChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setNewInput(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
  }

  const firstLoad = loadingActive && !activeData;
  if (firstLoad) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-10 h-10 rounded-full border-[3px] border-border border-t-primary animate-spin" />
      </div>
    );
  }

  const pendingLabel = meta?.taskStats?.pending ? `${meta.taskStats.pending} pending` : '';
  const ideasCount = meta?.counts?.idea || 0;

  return (
    <div className="min-h-screen bg-bg flex flex-col">
      {/* Scrollable content area */}
      <div className="flex-1 overflow-y-auto pb-36 md:pb-32">
        {/* 표준 헤더 */}
        <div className="px-4 md:px-8 pt-4 md:pt-8 pb-4">
          <div className="flex items-center gap-3 mb-1">
            <span className="w-1 h-9 md:h-11 bg-primary rounded-full flex-shrink-0" />
            <div className="min-w-0">
              <h1 className="text-2xl md:text-3xl font-bold text-text-heading tracking-tight flex items-center gap-2 leading-tight">
                <ClipboardList className="w-6 h-6 text-primary flex-shrink-0" />
                Tasks &amp; Ideas
              </h1>
              <p className="text-sm md:text-base text-text-muted mt-1">
                {pendingLabel || '아이디어와 메모를 빠르게 캡처하세요'}
                {ideasCount > 0 && pendingLabel && <span className="ml-2">· {ideasCount} ideas</span>}
              </p>
            </div>
          </div>
        </div>

        <div className="max-w-2xl mx-auto px-4 md:px-8">
          {/* Category tabs */}
          <div className="flex bg-bg-card rounded-lg p-1 gap-1 mb-4 border border-border">
            {TABS.map(([key, label]) => {
              const count = key !== 'all' ? meta?.counts?.[key.toLowerCase()] || 0 : 0;
              const active = tab === key;
              return (
                <button
                  key={key}
                  onClick={() => setTab(key)}
                  className={`flex-1 px-2 sm:px-3 py-2 rounded-md text-sm font-medium transition-colors min-h-[36px] ${
                    active
                      ? 'bg-primary text-white shadow-sm'
                      : 'text-text-muted hover:text-text-heading hover:bg-bg-hover'
                  }`}
                >
                  {label}
                  {count > 0 && (
                    <span className={`ml-1 text-xs ${active ? 'opacity-90' : 'opacity-70'}`}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Error */}
          {error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 mb-4 text-red-400 text-sm flex items-center justify-between">
              <span className="break-words">{error}</span>
              <button
                onClick={() => setError('')}
                className="ml-2 text-red-400 hover:text-red-300 flex-shrink-0"
                aria-label="에러 닫기"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Revalidation indicator */}
          {validatingActive && activeCaptures.length > 0 && (
            <div className="h-0.5 bg-primary/20 rounded-full mb-3 overflow-hidden">
              <div className="h-full bg-primary/60 rounded-full animate-pulse w-1/2" />
            </div>
          )}

          {/* Empty state */}
          {activeCaptures.length === 0 && completedCaptures.length === 0 ? (
            <EmptyState tab={tab} validating={validatingActive} />
          ) : (
            <>
              {/* Active list */}
              <div className="space-y-1.5">
                {activeCaptures.map(c => (
                  <TaskCard
                    key={c.id}
                    capture={c}
                    expanded={expandedId === c.id}
                    editing={editingId === c.id}
                    editContent={editContent}
                    onToggleExpand={() => toggleExpand(c)}
                    onToggleComplete={() => handleToggleComplete(c)}
                    onDelete={() => handleDelete(c.id)}
                    onStartEdit={() => handleStartEdit(c)}
                    onSaveEdit={() => handleSaveEdit(c)}
                    onCancelEdit={handleCancelEdit}
                    onEditContentChange={setEditContent}
                  />
                ))}
              </div>

              {/* Completed section */}
              {completedCaptures.length > 0 && (
                <div className="mt-8">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-medium text-text-muted">
                      완료됨 ({completedCaptures.length})
                    </h3>
                    <button
                      onClick={handleClearCompleted}
                      className="text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded hover:bg-red-500/10 transition-colors"
                    >
                      모두 삭제
                    </button>
                  </div>
                  <div className="space-y-1.5">
                    {completedCaptures.map(c => (
                      <TaskCard
                        key={c.id}
                        capture={c}
                        expanded={expandedId === c.id}
                        editing={editingId === c.id}
                        editContent={editContent}
                        onToggleExpand={() => toggleExpand(c)}
                        onToggleComplete={() => handleToggleComplete(c)}
                        onDelete={() => handleDelete(c.id)}
                        onStartEdit={() => handleStartEdit(c)}
                        onSaveEdit={() => handleSaveEdit(c)}
                        onCancelEdit={handleCancelEdit}
                        onEditContentChange={setEditContent}
                      />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Bottom input bar — sticky within content area */}
      <div className="sticky bottom-0 bg-bg-card border-t border-border z-30 mt-auto">
        <div className="max-w-4xl mx-auto px-4 md:px-6 py-3 md:py-4">
          <div className="flex items-end gap-2 md:gap-3">
            <textarea
              ref={inputRef}
              value={newInput}
              onChange={handleInputChange}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  handleAdd();
                }
              }}
              placeholder="할일, 아이디어, 메모를 입력하세요..."
              rows={1}
              className="flex-1 bg-bg-input border border-border rounded-xl px-4 md:px-5 py-3 md:py-3.5 text-base text-text-heading placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary resize-none min-h-[48px] md:min-h-[52px] max-h-[120px]"
            />
            <button
              onClick={handleAdd}
              disabled={!newInput.trim()}
              aria-label="추가"
              className="flex-shrink-0 bg-primary text-white p-3 md:p-3.5 rounded-xl disabled:opacity-40 hover:bg-primary/90 transition-colors min-h-[48px] min-w-[48px] flex items-center justify-center"
            >
              <Send className="w-5 h-5" />
            </button>
          </div>
          <div className="h-[env(safe-area-inset-bottom)]" />
        </div>
      </div>
    </div>
  );
}

// ── Empty state ──────────────────────────────────────────

function EmptyState({ tab, validating }: { tab: TabFilter; validating: boolean }) {
  const icon =
    tab === 'TASK' ? <CheckCircle className="w-10 h-10 text-green-400" /> :
    tab === 'IDEA' ? <Lightbulb className="w-10 h-10 text-amber-600" /> :
    <ClipboardList className="w-10 h-10 text-text-muted" />;

  return (
    <div className="text-center py-16 md:py-20">
      <div className="mb-3 flex justify-center">{icon}</div>
      <h3 className="text-text-heading font-medium mb-1">
        {validating ? '불러오는 중...' : '아직 항목이 없습니다'}
      </h3>
      {!validating && (
        <p className="text-text-muted text-sm leading-relaxed">
          아래 입력창에 할일이나 아이디어를 입력하세요.<br />
          AI가 자동으로 분류합니다.
        </p>
      )}
    </div>
  );
}

// ── Task Card Component ──────────────────────────────────

interface TaskCardProps {
  capture: Capture;
  expanded: boolean;
  editing: boolean;
  editContent: string;
  onToggleExpand: () => void;
  onToggleComplete: () => void;
  onDelete: () => void;
  onStartEdit: () => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onEditContentChange: (val: string) => void;
}

function TaskCard({
  capture: c,
  expanded,
  editing,
  editContent,
  onToggleExpand,
  onToggleComplete,
  onDelete,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onEditContentChange,
}: TaskCardProps) {
  const pri = PRIORITY_INFO[c.priority] || PRIORITY_INFO.low;
  const dateLabel = c.actionDate
    ? c.actionDate.split('T')[0].slice(5)
    : new Date(c.createdAt).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });

  return (
    <div
      className={`bg-bg-card rounded-xl border transition-all duration-200 ${
        c.completed
          ? 'border-border opacity-50'
          : expanded
          ? 'border-primary/40 shadow-sm'
          : 'border-border hover:border-primary/30'
      }`}
    >
      {/* Compact row */}
      <div
        className="flex items-center gap-3 px-3 md:px-4 py-3 cursor-pointer"
        onClick={onToggleExpand}
      >
        {/* Checkbox */}
        <button
          onClick={(e) => { e.stopPropagation(); onToggleComplete(); }}
          aria-label={c.completed ? '완료 해제' : '완료 처리'}
          className={`w-5 h-5 rounded-full border-2 flex-shrink-0 flex items-center justify-center transition-all duration-200 ${
            c.completed
              ? 'bg-green-500 border-green-500 text-white'
              : 'border-border hover:border-primary hover:scale-110'
          }`}
        >
          {c.completed && <span className="text-xs font-bold">&#10003;</span>}
        </button>

        {/* Title */}
        <span className={`flex-1 min-w-0 truncate text-sm ${
          c.completed ? 'line-through text-text-muted' : 'text-text-heading font-medium'
        }`}>
          {c.summary || c.content.substring(0, 60)}
        </span>

        {/* Right: category icon + date */}
        <div className="flex items-center gap-1.5 md:gap-2 flex-shrink-0">
          {CATEGORY_ICONS[c.category] || CATEGORY_ICONS.memo}
          <span className="text-xs text-text-muted inline-flex items-center gap-0.5">
            {c.actionDate && <Calendar className="w-3 h-3" />}
            {dateLabel}
          </span>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-3 md:px-4 pb-3 md:pb-4 border-t border-border pt-3 space-y-3 animate-msg-in">
          {editing ? (
            <div className="space-y-2">
              <textarea
                value={editContent}
                onChange={(e) => onEditContentChange(e.target.value)}
                className="w-full bg-bg-input border border-border rounded-lg px-3 py-2 text-sm text-text-heading placeholder:text-text-muted focus:outline-none focus:border-primary resize-none min-h-[80px]"
                autoFocus
              />
              <div className="flex gap-2 justify-end">
                <button
                  onClick={onCancelEdit}
                  className="text-xs text-text-muted hover:text-text-heading px-3 py-2 rounded-lg border border-border hover:bg-bg-input transition-colors h-9"
                >
                  취소
                </button>
                <button
                  onClick={onSaveEdit}
                  className="text-xs text-white bg-primary px-3 py-2 rounded-lg hover:bg-primary/90 transition-colors h-9"
                >
                  저장
                </button>
              </div>
            </div>
          ) : (
            c.content && (
              <p className="text-sm text-text-heading leading-relaxed whitespace-pre-wrap break-words">
                {renderContentWithLinks(c.content)}
              </p>
            )
          )}

          {/* Meta: tags, priority */}
          {!editing && (
            <div className="flex items-center gap-1.5 flex-wrap">
              {c.category === 'task' && c.priority && (
                <span className={`text-xs px-2 py-0.5 rounded border ${pri.color}`}>
                  {pri.label}
                </span>
              )}
              {c.tags.map(t => (
                <span key={t} className="text-xs bg-bg-input text-text-muted px-2 py-0.5 rounded">
                  #{t}
                </span>
              ))}
              {c.sourceType === 'voice' && (
                <span className="text-xs text-text-muted inline-flex items-center gap-1">
                  <Mic className="w-3 h-3" /> 음성
                </span>
              )}
            </div>
          )}

          {/* Action buttons */}
          {!editing && (
            <div className="flex items-center gap-1.5 pt-1 flex-wrap">
              <button
                onClick={(e) => { e.stopPropagation(); onStartEdit(); }}
                className="text-xs text-text-muted hover:text-text-heading inline-flex items-center gap-1 px-2 py-2 rounded-lg hover:bg-bg-input transition-colors h-9"
              >
                <Pencil className="w-3.5 h-3.5" /> 수정
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                className="text-xs text-text-muted hover:text-red-400 inline-flex items-center gap-1 px-2 py-2 rounded-lg hover:bg-red-500/10 transition-colors h-9"
              >
                <Trash2 className="w-3.5 h-3.5" /> 삭제
              </button>
              <span className="ml-auto text-xs text-text-muted">
                {new Date(c.createdAt).toLocaleDateString('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' })}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
