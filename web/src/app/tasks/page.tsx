'use client';

import { useState, useRef } from 'react';
import {
  getCaptures, createCapture, updateCapture, deleteCapture, deleteCompletedCaptures,
  type Capture,
} from '@/lib/api';
import { useApiData } from '@/lib/use-api';
// Skeleton import removed — using inline spinner
import {
  CheckCircle, Lightbulb, FileText, ClipboardList, Calendar, Mic,
  X, Pencil, Trash2, ExternalLink, PlayCircle, Send,
} from 'lucide-react';
import { useToast } from '@/components/Toast';

type TabFilter = 'all' | 'TASK' | 'IDEA' | 'MEMO';

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  task: <CheckCircle className="w-4 h-4 text-green-400" />,
  idea: <Lightbulb className="w-4 h-4 text-yellow-400" />,
  memo: <FileText className="w-4 h-4 text-gray-400" />,
};

const PRIORITY_INFO: Record<string, { label: string; color: string }> = {
  high: { label: 'HIGH', color: 'bg-red-500/10 text-red-400 border-red-500/20' },
  medium: { label: 'MED', color: 'bg-orange-500/10 text-orange-400 border-orange-500/20' },
  low: { label: 'LOW', color: 'bg-gray-500/10 text-gray-500 border-gray-500/20' },
};

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
  const [adding, setAdding] = useState(false);
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
    createCapture(inputText).then(res => {
      if (res.data) {
        refreshActive((prev: any) => prev ? { ...prev, data: [res.data, ...(prev.data || [])] } : prev, { revalidate: false });
      }
      // 1초 후 서버와 동기화 (연속 입력이 끝난 뒤 최종 상태 확인)
      setTimeout(() => refreshActive(), 1000);
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
      await updateCapture(c.id, { content: updatedContent });
      toast('수정됨', 'success');
      // 서버 응답으로 최신 상태 동기화 (AI 재분류 결과 반영)
      setTimeout(() => { refreshActive(); refreshCompleted(); }, 1500);
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
  if (firstLoad) return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="w-10 h-10 rounded-full border-[3px] border-border border-t-primary animate-spin" />
    </div>
  );

  return (
    <div className="min-h-screen bg-bg flex flex-col">
      {/* Scrollable content area */}
      <div className="flex-1 overflow-y-auto pb-36">
        <div className="max-w-2xl mx-auto px-4 pt-6">
          {/* Header */}
          <div className="mb-5">
            <h1 className="text-2xl font-bold text-text-heading">Tasks & Ideas</h1>
            <p className="text-text-muted text-sm mt-1">
              {meta?.taskStats?.pending ? `${meta.taskStats.pending} pending` : ''}
              {meta?.counts?.idea > 0 && <span className="ml-2">{meta.counts.idea} ideas</span>}
            </p>
          </div>

          {/* Category tabs */}
          <div className="flex bg-bg-card rounded-lg p-1 gap-1 mb-5 border border-border">
            {([['all', '전체'], ['TASK', '할일'], ['IDEA', '아이디어'], ['MEMO', '메모']] as const).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`flex-1 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                  tab === key
                    ? 'bg-primary text-white'
                    : 'text-text-muted hover:text-text-heading'
                }`}
              >
                {label}
                {key !== 'all' && meta?.counts?.[key.toLowerCase()] > 0 && (
                  <span className="ml-1 text-xs opacity-70">{meta.counts[key.toLowerCase()]}</span>
                )}
              </button>
            ))}
          </div>

          {/* Error */}
          {error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 mb-4 text-red-400 text-sm flex items-center justify-between">
              <span>{error}</span>
              <button onClick={() => setError('')} className="ml-2 text-red-400 hover:text-red-300">
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
            <div className="text-center py-20">
              <div className="mb-3 flex justify-center">
                {tab === 'TASK' ? <CheckCircle className="w-10 h-10 text-green-400" /> :
                 tab === 'IDEA' ? <Lightbulb className="w-10 h-10 text-yellow-400" /> :
                 <ClipboardList className="w-10 h-10 text-text-muted" />}
              </div>
              <h3 className="text-text-heading font-medium mb-1">
                {validatingActive ? '불러오는 중...' : '아직 항목이 없습니다'}
              </h3>
              {!validatingActive && (
                <p className="text-text-muted text-sm">
                  아래 입력창에 할일이나 아이디어를 입력하세요.<br />
                  AI가 자동으로 분류합니다.
                </p>
              )}
            </div>
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
        <div className="max-w-3xl mx-auto px-6 py-4">
          <div className="flex items-end gap-3">
            <textarea
              ref={inputRef}
              value={newInput}
              onChange={handleInputChange}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleAdd();
                }
              }}
              placeholder="할일, 아이디어, 메모를 입력하세요..."
              rows={1}
              className="flex-1 bg-bg-input border border-border rounded-xl px-5 py-3.5 text-base text-text-heading placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary resize-none min-h-[52px] max-h-[120px]"
            />
            <button
              onClick={handleAdd}
              disabled={!newInput.trim()}
              className="flex-shrink-0 bg-primary text-white p-3.5 rounded-xl disabled:opacity-40 hover:bg-primary/90 transition-colors"
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

  return (
    <div
      className={`bg-bg-card rounded-xl border transition-all duration-200 ${
        c.completed ? 'border-border opacity-50' : 'border-border hover:border-primary/30'
      }`}
    >
      {/* Compact row */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer"
        onClick={onToggleExpand}
      >
        {/* Checkbox */}
        <button
          onClick={(e) => { e.stopPropagation(); onToggleComplete(); }}
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
        <div className="flex items-center gap-2 flex-shrink-0">
          {CATEGORY_ICONS[c.category] || CATEGORY_ICONS.memo}
          {c.actionDate ? (
            <span className="text-xs text-text-muted flex items-center gap-0.5">
              <Calendar className="w-3 h-3" />
              {c.actionDate.split('T')[0].slice(5)}
            </span>
          ) : (
            <span className="text-xs text-text-muted">
              {new Date(c.createdAt).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })}
            </span>
          )}
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-4 pb-4 border-t border-border pt-3 space-y-3 animate-msg-in">
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
                  className="text-xs text-text-muted hover:text-text-heading px-3 py-1.5 rounded-lg border border-border hover:bg-bg-input transition-colors"
                >
                  취소
                </button>
                <button
                  onClick={onSaveEdit}
                  className="text-xs text-white bg-primary px-3 py-1.5 rounded-lg hover:bg-primary/90 transition-colors"
                >
                  저장
                </button>
              </div>
            </div>
          ) : (
            <>
              {c.content && (
                <p className="text-sm text-text-heading leading-relaxed whitespace-pre-wrap">
                  {renderContentWithLinks(c.content)}
                </p>
              )}
            </>
          )}

          {/* Meta: tags, priority */}
          {!editing && (
            <div className="flex items-center gap-2 flex-wrap">
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
                <span className="text-xs text-text-muted flex items-center gap-1">
                  <Mic className="w-3 h-3" /> 음성
                </span>
              )}
            </div>
          )}

          {/* Action buttons */}
          {!editing && (
            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={(e) => { e.stopPropagation(); onStartEdit(); }}
                className="text-xs text-text-muted hover:text-text-heading flex items-center gap-1 px-2 py-1.5 rounded-lg hover:bg-bg-input transition-colors"
              >
                <Pencil className="w-3.5 h-3.5" /> 수정
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                className="text-xs text-text-muted hover:text-red-400 flex items-center gap-1 px-2 py-1.5 rounded-lg hover:bg-red-500/10 transition-colors"
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
