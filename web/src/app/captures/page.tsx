'use client';

import { useEffect, useState, useCallback } from 'react';
import { getCaptures, createCapture, updateCapture, deleteCapture, classifyCapture, deleteCompletedCaptures, Capture } from '@/lib/api';

const CATEGORY_COLORS: Record<string, string> = {
  IDEA: 'bg-yellow-500/20 text-yellow-400',
  TASK: 'bg-blue-500/20 text-blue-400',
  MEMO: 'bg-green-500/20 text-green-400',
  QUESTION: 'bg-purple-500/20 text-purple-400',
  REFERENCE: 'bg-cyan-500/20 text-cyan-400',
};

const PRIORITY_ICON: Record<string, string> = {
  HIGH: '🔴', MEDIUM: '🟡', LOW: '🟢',
};

type FilterType = 'ALL' | 'IDEA' | 'TASK' | 'MEMO' | 'QUESTION' | 'REFERENCE';

export default function CapturesPage() {
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [loading, setLoading] = useState(true);
  const [newContent, setNewContent] = useState('');
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<FilterType>('ALL');
  const [showCompleted, setShowCompleted] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await getCaptures(50);
      setCaptures(res.data);
    } catch (err) {
      console.error('Failed to load captures:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    if (!newContent.trim() || creating) return;
    setCreating(true);
    try {
      const res = await createCapture(newContent.trim());
      setCaptures(prev => [res.data, ...prev]);
      setNewContent('');
      // Auto-classify
      try {
        const classified = await classifyCapture(res.data.id);
        setCaptures(prev => prev.map(c => c.id === classified.data.id ? classified.data : c));
      } catch { /* classification is optional */ }
    } catch (err) {
      console.error('Failed to create capture:', err);
    } finally {
      setCreating(false);
    }
  };

  const handleToggleComplete = async (capture: Capture) => {
    try {
      const res = await updateCapture(capture.id, { completed: !capture.completed });
      setCaptures(prev => prev.map(c => c.id === capture.id ? res.data : c));
    } catch (err) {
      console.error('Failed to update capture:', err);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteCapture(id);
      setCaptures(prev => prev.filter(c => c.id !== id));
    } catch (err) {
      console.error('Failed to delete capture:', err);
    }
  };

  const handleDeleteCompleted = async () => {
    try {
      await deleteCompletedCaptures();
      setCaptures(prev => prev.filter(c => !c.completed));
    } catch (err) {
      console.error('Failed to delete completed:', err);
    }
  };

  const filtered = captures.filter(c => {
    if (filter !== 'ALL' && c.category !== filter) return false;
    if (!showCompleted && c.completed) return false;
    return true;
  });

  const completedCount = captures.filter(c => c.completed).length;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-white">📝 캡처</h2>
        <p className="text-text-muted mt-1">아이디어, 할 일, 메모를 빠르게 기록하세요</p>
      </div>

      {/* 입력 */}
      <div className="bg-bg-card rounded-xl border border-bg-input/50 p-4">
        <div className="flex gap-3">
          <input
            type="text"
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            placeholder="새 캡처를 입력하세요... (Enter로 저장)"
            className="flex-1 bg-bg-input/50 border border-bg-input rounded-lg px-4 py-3 text-sm text-white placeholder-text-muted focus:outline-none focus:border-primary"
          />
          <button
            onClick={handleCreate}
            disabled={creating || !newContent.trim()}
            className="px-5 py-3 bg-primary hover:bg-primary-hover disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
          >
            {creating ? '저장 중...' : '저장'}
          </button>
        </div>
      </div>

      {/* 필터 */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex gap-2 flex-wrap">
          {(['ALL', 'IDEA', 'TASK', 'MEMO', 'QUESTION', 'REFERENCE'] as FilterType[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-xs transition-colors ${
                filter === f
                  ? 'bg-primary/20 text-primary font-medium'
                  : 'bg-bg-input/30 text-text-muted hover:text-white'
              }`}
            >
              {f === 'ALL' ? '전체' : f}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-text-muted cursor-pointer">
            <input
              type="checkbox"
              checked={showCompleted}
              onChange={(e) => setShowCompleted(e.target.checked)}
              className="rounded"
            />
            완료 표시
          </label>
          {completedCount > 0 && (
            <button
              onClick={handleDeleteCompleted}
              className="text-xs text-red-400 hover:text-red-300"
            >
              완료 삭제 ({completedCount})
            </button>
          )}
        </div>
      </div>

      {/* 캡처 목록 */}
      <div className="space-y-2">
        {filtered.length === 0 ? (
          <div className="text-center py-12 text-text-muted">
            {filter === 'ALL' ? '아직 캡처가 없습니다. 위에서 새 캡처를 만들어보세요!' : `${filter} 카테고리에 캡처가 없습니다.`}
          </div>
        ) : (
          filtered.map((c) => (
            <div
              key={c.id}
              className={`bg-bg-card rounded-xl border border-bg-input/50 p-4 flex items-start gap-3 group hover:border-primary/30 transition-colors ${
                c.completed ? 'opacity-60' : ''
              }`}
            >
              <button
                onClick={() => handleToggleComplete(c)}
                className={`mt-0.5 w-5 h-5 rounded border-2 flex items-center justify-center text-xs transition-colors ${
                  c.completed
                    ? 'bg-green-500/20 border-green-500 text-green-400'
                    : 'border-bg-input hover:border-primary'
                }`}
              >
                {c.completed ? '✓' : ''}
              </button>

              <div className="flex-1 min-w-0">
                <p className={`text-sm text-white ${c.completed ? 'line-through' : ''}`}>
                  {c.content}
                </p>
                {c.summary && (
                  <p className="text-xs text-text-muted mt-1">{c.summary}</p>
                )}
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  <span className={`text-[10px] px-2 py-0.5 rounded-full ${CATEGORY_COLORS[c.category] || 'bg-gray-500/20 text-gray-400'}`}>
                    {c.category}
                  </span>
                  <span className="text-[10px]">{PRIORITY_ICON[c.priority] || '⚪'} {c.priority}</span>
                  {c.tags?.map((t) => (
                    <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-bg-input/50 text-text-muted">#{t}</span>
                  ))}
                  <span className="text-[10px] text-text-muted">
                    {new Date(c.createdAt).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              </div>

              <button
                onClick={() => handleDelete(c.id)}
                className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-300 text-sm transition-opacity"
                title="삭제"
              >
                ✕
              </button>
            </div>
          ))
        )}
      </div>

      {/* 통계 */}
      <div className="text-xs text-text-muted text-center">
        전체 {captures.length}개 · 진행 중 {captures.length - completedCount}개 · 완료 {completedCount}개
      </div>
    </div>
  );
}
