'use client';

import { useState, useEffect } from 'react';
import { useUser } from '@clerk/nextjs';
import { useRouter } from 'next/navigation';
import {
  getCaptures, createCapture, updateCapture, deleteCapture, deleteCompletedCaptures,
  type Capture,
} from '@/lib/api';

type TabFilter = 'all' | 'TASK' | 'IDEA' | 'MEMO';
type StatusFilter = 'active' | 'completed';
type SortBy = 'newest' | 'oldest' | 'dueDate';

const CATEGORY_INFO: Record<string, { emoji: string; label: string; color: string }> = {
  task: { emoji: '✅', label: '할일', color: 'bg-blue-500/10 text-blue-400' },
  idea: { emoji: '💡', label: '아이디어', color: 'bg-yellow-500/10 text-yellow-400' },
  memo: { emoji: '📝', label: '메모', color: 'bg-gray-500/10 text-gray-400' },
};

const PRIORITY_INFO: Record<string, { label: string; color: string }> = {
  high: { label: 'HIGH', color: 'bg-red-500/10 text-red-400 border-red-500/20' },
  medium: { label: 'MED', color: 'bg-orange-500/10 text-orange-400 border-orange-500/20' },
  low: { label: 'LOW', color: 'bg-gray-500/10 text-gray-500 border-gray-500/20' },
};

export default function TasksPage() {
  const { isSignedIn, isLoaded } = useUser();
  const router = useRouter();

  const [captures, setCaptures] = useState<Capture[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [sortBy, setSortBy] = useState<SortBy>('newest');
  const [search, setSearch] = useState('');
  const [newInput, setNewInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const [meta, setMeta] = useState<any>(null);

  useEffect(() => {
    if (isLoaded && !isSignedIn) router.push('/sign-in');
  }, [isLoaded, isSignedIn, router]);

  useEffect(() => { loadCaptures(); }, [tab, statusFilter, sortBy]);

  async function loadCaptures() {
    setLoading(true);
    try {
      const res = await getCaptures({
        category: tab === 'all' ? undefined : tab,
        completed: statusFilter === 'completed' ? 'true' : 'false',
        sort: sortBy,
        limit: 100,
      });
      setCaptures(res.data || []);
      setMeta(res.meta || null);
    } catch { setError('데이터를 불러올 수 없습니다'); }
    finally { setLoading(false); }
  }

  async function handleAdd() {
    if (!newInput.trim()) return;
    setAdding(true);
    try {
      await createCapture(newInput.trim());
      setNewInput('');
      await loadCaptures();
    } catch (err: any) { setError(err.message); }
    finally { setAdding(false); }
  }

  async function handleToggleComplete(c: Capture) {
    await updateCapture(c.id, { completed: !c.completed });
    await loadCaptures();
  }

  async function handleReview(c: Capture) {
    await updateCapture(c.id, { reviewed: true });
    await loadCaptures();
  }

  async function handleDelete(id: string) {
    await deleteCapture(id);
    await loadCaptures();
  }

  async function handleClearCompleted() {
    await deleteCompletedCaptures();
    await loadCaptures();
  }

  // Client-side search filter
  const filtered = search
    ? captures.filter(c =>
        c.content.toLowerCase().includes(search.toLowerCase()) ||
        c.summary.toLowerCase().includes(search.toLowerCase()) ||
        c.tags.some(t => t.toLowerCase().includes(search.toLowerCase()))
      )
    : captures;

  const unreviewed = captures.filter(c => !c.reviewed && !c.completed).length;
  const pendingTasks = meta?.taskStats?.pending || 0;

  if (!isLoaded) return null;

  return (
    <div className="min-h-screen bg-bg p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Tasks & Ideas</h1>
          <p className="text-text-muted text-sm mt-1">
            {unreviewed > 0 && <span className="text-red-400 mr-3">NEW {unreviewed}</span>}
            {pendingTasks > 0 && <span className="mr-3">{pendingTasks} tasks pending</span>}
            {meta?.counts?.idea > 0 && <span>{meta.counts.idea} ideas</span>}
          </p>
        </div>
        {statusFilter === 'completed' && captures.length > 0 && (
          <button
            onClick={handleClearCompleted}
            className="text-xs text-red-400 hover:text-red-300 border border-red-500/20 rounded-lg px-3 py-1.5"
          >
            Clear All
          </button>
        )}
      </div>

      {/* Quick Input */}
      <div className="mb-5">
        <div className="flex gap-2">
          <input
            type="text"
            value={newInput}
            onChange={e => setNewInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !adding && handleAdd()}
            placeholder="할일, 아이디어, 메모를 입력하세요... (AI가 자동 분류)"
            className="flex-1 bg-bg-input/50 border border-bg-input rounded-lg px-4 py-3 text-white placeholder:text-text-muted focus:outline-none focus:border-primary/50"
          />
          <button
            onClick={handleAdd}
            disabled={adding || !newInput.trim()}
            className="bg-primary text-white px-5 py-3 rounded-lg font-medium disabled:opacity-50 hover:bg-primary/90 transition-colors"
          >
            {adding ? '...' : '추가'}
          </button>
        </div>
      </div>

      {/* Tab Filters */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <div className="flex bg-bg-input/30 rounded-lg p-0.5 gap-0.5">
          {([['all', '전체'], ['TASK', '✅ 할일'], ['IDEA', '💡 아이디어'], ['MEMO', '📝 메모']] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                tab === key ? 'bg-primary text-white' : 'text-text-muted hover:text-white'
              }`}
            >
              {label}
              {key !== 'all' && meta?.counts?.[key.toLowerCase()] > 0 && (
                <span className="ml-1 opacity-70">{meta.counts[key.toLowerCase()]}</span>
              )}
            </button>
          ))}
        </div>

        <div className="flex bg-bg-input/30 rounded-lg p-0.5 gap-0.5 ml-auto">
          {([['active', 'Active'], ['completed', 'Done']] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setStatusFilter(key)}
              className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                statusFilter === key ? 'bg-bg-input text-white' : 'text-text-muted hover:text-white'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <select
          value={sortBy}
          onChange={e => setSortBy(e.target.value as SortBy)}
          className="bg-bg-input/50 border border-bg-input rounded-lg px-2 py-1.5 text-sm text-text-muted"
        >
          <option value="newest">최신순</option>
          <option value="oldest">오래된순</option>
          <option value="dueDate">마감일순</option>
        </select>
      </div>

      {/* Search */}
      <input
        type="text"
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="검색..."
        className="w-full bg-bg-input/30 border border-bg-input/50 rounded-lg px-4 py-2 text-sm text-white placeholder:text-text-muted mb-4 focus:outline-none focus:border-primary/30"
      />

      {/* Error */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 mb-4 text-red-400 text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-2 underline">닫기</button>
        </div>
      )}

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center py-20 text-text-muted">
          <div className="animate-spin rounded-full h-6 w-6 border-t-2 border-primary mr-3" />
          불러오는 중...
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20">
          <div className="text-4xl mb-3">{tab === 'TASK' ? '✅' : tab === 'IDEA' ? '💡' : '📋'}</div>
          <h3 className="text-white font-medium mb-1">
            {statusFilter === 'completed' ? '완료된 항목이 없습니다' : '아직 항목이 없습니다'}
          </h3>
          <p className="text-text-muted text-sm">
            위 입력창에 할일이나 아이디어를 입력하거나, Brain 채팅에서 자연스럽게 말하면 자동으로 저장됩니다.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(c => {
            const cat = CATEGORY_INFO[c.category] || CATEGORY_INFO.memo;
            const pri = PRIORITY_INFO[c.priority] || PRIORITY_INFO.low;
            return (
              <div
                key={c.id}
                className={`bg-bg-card rounded-xl border p-4 transition-colors ${
                  !c.reviewed && !c.completed
                    ? 'border-primary/30 bg-primary/5'
                    : 'border-bg-input/50'
                } ${c.completed ? 'opacity-60' : ''}`}
              >
                <div className="flex items-start gap-3">
                  {/* Complete toggle */}
                  <button
                    onClick={() => handleToggleComplete(c)}
                    className={`mt-0.5 w-5 h-5 rounded-full border-2 flex-shrink-0 flex items-center justify-center transition-colors ${
                      c.completed
                        ? 'bg-green-500 border-green-500 text-white'
                        : 'border-bg-input hover:border-primary'
                    }`}
                  >
                    {c.completed && <span className="text-xs">✓</span>}
                  </button>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      {/* NEW badge */}
                      {!c.reviewed && !c.completed && (
                        <span className="text-[10px] font-bold bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded">
                          NEW
                        </span>
                      )}
                      {/* Category */}
                      <span className="text-sm">{cat.emoji}</span>
                      {/* Summary */}
                      <span className={`text-sm font-medium ${c.completed ? 'line-through text-text-muted' : 'text-white'}`}>
                        {c.summary || c.content.substring(0, 60)}
                      </span>
                    </div>

                    {/* Full content if different from summary */}
                    {c.content !== c.summary && c.content.length > 60 && (
                      <p className="text-xs text-text-muted mb-2 line-clamp-2">{c.content}</p>
                    )}

                    {/* Meta row */}
                    <div className="flex items-center gap-2 flex-wrap">
                      {/* Priority */}
                      {c.category === 'task' && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded border ${pri.color}`}>
                          {pri.label}
                        </span>
                      )}
                      {/* Due date */}
                      {c.actionDate && (
                        <span className="text-[10px] text-text-muted">
                          📅 {c.actionDate.split('T')[0]}
                        </span>
                      )}
                      {/* Tags */}
                      {c.tags.map(t => (
                        <span key={t} className="text-[10px] bg-bg-input/50 text-text-muted px-1.5 py-0.5 rounded">
                          #{t}
                        </span>
                      ))}
                      {/* Source */}
                      {c.sourceType === 'voice' && <span className="text-[10px] text-text-muted">🎤</span>}
                      {c.modelUsed === 'gemini-flash-auto' && <span className="text-[10px] text-text-muted">auto</span>}
                      {/* Date */}
                      <span className="text-[10px] text-text-muted ml-auto">
                        {new Date(c.createdAt).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })}
                      </span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {!c.reviewed && !c.completed && (
                      <button
                        onClick={() => handleReview(c)}
                        className="text-xs text-primary hover:text-primary/80 px-2 py-1 rounded hover:bg-primary/10"
                        title="확인"
                      >
                        확인
                      </button>
                    )}
                    <button
                      onClick={() => handleDelete(c.id)}
                      className="text-xs text-text-muted hover:text-red-400 px-2 py-1 rounded hover:bg-red-500/10"
                      title="삭제"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
