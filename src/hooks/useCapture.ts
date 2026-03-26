import { useState, useCallback, useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CaptureItem, CaptureCategory } from '../types';
import { classify, ClassificationResult } from '../services/ai-classifier';
import * as api from '../services/api-client';

const STORAGE_KEY = '@labflow/captures';

const CATEGORY_META = {
  idea: { icon: 'bulb-outline', label: '아이디어', color: '#F59E0B' },
  task: { icon: 'checkmark-circle-outline', label: '할일', color: '#3B82F6' },
  memo: { icon: 'document-text-outline', label: '메모', color: '#10B981' },
};

export type SortMode = 'oldest' | 'dueDate';

export function useCapture() {
  const [items, setItems] = useState<CaptureItem[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [filter, setFilter] = useState<CaptureCategory | 'all'>('all');
  const [sortMode, setSortMode] = useState<SortMode>('oldest');
  const [isLoaded, setIsLoaded] = useState(false);
  const [isOnline, setIsOnline] = useState(false);
  const checkedOnline = useRef(false);

  // ── 서버 연결 확인 + 데이터 로드 ────────────────────
  useEffect(() => {
    initializeData();
  }, []);

  const initializeData = async () => {
    // 서버 연결 확인
    if (!checkedOnline.current) {
      checkedOnline.current = true;
      try {
        const healthy = await api.checkHealth();
        setIsOnline(healthy);
        if (healthy) {
          await loadFromServer();
          return;
        }
      } catch {
        setIsOnline(false);
      }
    }
    // 오프라인: AsyncStorage에서 로드
    await loadFromLocal();
  };

  const loadFromServer = async () => {
    try {
      const result = await api.listCaptures({ sort: 'newest', limit: 100 });
      setItems(result.items);
    } catch (error) {
      console.warn('서버 로드 실패, 로컬 fallback:', error);
      await loadFromLocal();
    } finally {
      setIsLoaded(true);
    }
  };

  const loadFromLocal = async () => {
    try {
      const stored = await AsyncStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        const restored = parsed.map((item: any) => ({
          ...item,
          timestamp: new Date(item.timestamp),
        }));
        setItems(restored);
      }
    } catch (error) {
      console.warn('캡처 데이터 로드 실패:', error);
    } finally {
      setIsLoaded(true);
    }
  };

  // ── 로컬 저장 (오프라인 백업) ──────────────────────
  const saveToLocal = async (newItems: CaptureItem[]) => {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(newItems));
    } catch (error) {
      console.warn('캡처 데이터 저장 실패:', error);
    }
  };

  // ── 새 캡처 추가 (온라인: API / 오프라인: 로컬) ────
  const addCapture = useCallback(async (text: string) => {
    setIsProcessing(true);

    try {
      let item: CaptureItem;

      if (isOnline) {
        // 서버 API로 생성 (Gemini 분류 포함)
        item = await api.createCapture(text, { useAI: true });
      } else {
        // 오프라인: 로컬 분류
        const result: ClassificationResult = await classify(text, { useAPI: false });
        await new Promise(resolve => setTimeout(resolve, 300 + Math.random() * 400));

        item = {
          id: `cap-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
          content: text,
          summary: result.summary,
          category: result.category,
          tags: result.tags,
          timestamp: new Date(),
          ...(result.actionDate && { actionDate: result.actionDate }),
          ...(result.priority && { priority: result.priority }),
          ...(result.confidence && { confidence: result.confidence }),
          modelUsed: result.modelUsed,
        };
      }

      setItems(prev => {
        const updated = [item, ...prev];
        saveToLocal(updated);
        return updated;
      });

      return item;
    } catch (error) {
      console.error('캡처 추가 실패:', error);
      throw error;
    } finally {
      setIsProcessing(false);
    }
  }, [isOnline]);

  // ── 음성 캡처 결과 추가 (서버에서 이미 저장됨) ──────
  const addCaptureFromVoice = useCallback((item: CaptureItem) => {
    setItems(prev => {
      const updated = [item, ...prev];
      saveToLocal(updated);
      return updated;
    });
  }, []);

  // ── 캡처 삭제 ─────────────────────────────────────
  const removeCapture = useCallback(async (id: string) => {
    if (isOnline) {
      try { await api.deleteCapture(id); } catch (e) { console.warn('서버 삭제 실패:', e); }
    }
    setItems(prev => {
      const updated = prev.filter(item => item.id !== id);
      saveToLocal(updated);
      return updated;
    });
  }, [isOnline]);

  // ── 카테고리 수동 변경 ────────────────────────────
  const reclassify = useCallback(async (id: string, newCategory: CaptureCategory) => {
    if (isOnline) {
      try { await api.updateCapture(id, { category: newCategory }); } catch (e) { console.warn(e); }
    }
    setItems(prev => {
      const updated = prev.map(item =>
        item.id === id
          ? { ...item, category: newCategory, completed: false, completedAt: undefined }
          : item
      );
      saveToLocal(updated);
      return updated;
    });
  }, [isOnline]);

  // ── 할일 완료 토글 ──────────────────────────────────
  const toggleComplete = useCallback(async (id: string) => {
    const target = items.find(i => i.id === id);
    if (isOnline && target) {
      try { await api.updateCapture(id, { completed: !target.completed }); } catch (e) { console.warn(e); }
    }
    setItems(prev => {
      const updated = prev.map(item =>
        item.id === id
          ? {
              ...item,
              completed: !item.completed,
              completedAt: !item.completed ? new Date() : undefined,
            }
          : item
      );
      saveToLocal(updated);
      return updated;
    });
  }, [isOnline, items]);

  // ── 완료된 항목 일괄 삭제 ─────────────────────────
  const clearCompleted = useCallback(async () => {
    if (isOnline) {
      try { await api.clearCompletedCaptures(); } catch (e) { console.warn(e); }
    }
    setItems(prev => {
      const updated = prev.filter(item => !item.completed);
      saveToLocal(updated);
      return updated;
    });
  }, [isOnline]);

  // ── 정렬 로직 ─────────────────────────────────────
  const sortedItems = [...items].sort((a, b) => {
    if (a.completed && !b.completed) return 1;
    if (!a.completed && b.completed) return -1;

    switch (sortMode) {
      case 'oldest':
        return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
      case 'dueDate': {
        if (a.actionDate && !b.actionDate) return -1;
        if (!a.actionDate && b.actionDate) return 1;
        if (a.actionDate && b.actionDate) {
          return a.actionDate.localeCompare(b.actionDate);
        }
        return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
      }
      default:
        return 0;
    }
  });

  const filteredItems = filter === 'all'
    ? sortedItems
    : sortedItems.filter(item => item.category === filter);

  const counts = {
    all: items.length,
    idea: items.filter(i => i.category === 'idea').length,
    task: items.filter(i => i.category === 'task').length,
    memo: items.filter(i => i.category === 'memo').length,
  };

  const taskCounts = {
    total: items.filter(i => i.category === 'task').length,
    completed: items.filter(i => i.category === 'task' && i.completed).length,
    pending: items.filter(i => i.category === 'task' && !i.completed).length,
  };

  return {
    items: filteredItems,
    allItems: items,
    isProcessing,
    isLoaded,
    isOnline,
    filter,
    setFilter,
    sortMode,
    setSortMode,
    addCapture,
    addCaptureFromVoice,
    removeCapture,
    reclassify,
    toggleComplete,
    clearCompleted,
    counts,
    taskCounts,
    CATEGORY_META,
  };
}

export { CATEGORY_META };
