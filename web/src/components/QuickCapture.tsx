'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Plus, X, Zap, ClipboardList, Lightbulb, FileText } from 'lucide-react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { createCapture } from '@/lib/api';
import { useToast } from '@/components/Toast';

type Category = 'task' | 'idea' | 'memo';

const CATEGORIES: { value: Category; label: string; icon: React.ReactNode }[] = [
  { value: 'task', label: '할일', icon: <ClipboardList className="w-3.5 h-3.5" /> },
  { value: 'idea', label: '아이디어', icon: <Lightbulb className="w-3.5 h-3.5" /> },
  { value: 'memo', label: '메모', icon: <FileText className="w-3.5 h-3.5" /> },
];

const PLACEHOLDERS: Record<Category, string> = {
  task: '할 일을 입력하세요...',
  idea: '아이디어를 적어두세요...',
  memo: '메모할 내용을 입력하세요...',
};

export function QuickCapture() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [category, setCategory] = useState<Category>('task');
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { toast } = useToast();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // URL 파라미터 ?capture=1 이면 자동 오픈 (PWA 숏컷 진입점)
  useEffect(() => {
    if (searchParams.get('capture') === '1') {
      setOpen(true);
      // URL에서 파라미터 제거
      router.replace(pathname, { scroll: false });
    }
  }, [searchParams]);

  // 오픈 시 자동 포커스
  useEffect(() => {
    if (open) {
      setTimeout(() => textareaRef.current?.focus(), 150);
    } else {
      setText('');
    }
  }, [open]);

  // 키보드 숏컷: Cmd/Ctrl+Shift+N
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'n') {
        e.preventDefault();
        setOpen(prev => !prev);
      }
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const handleSave = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      await createCapture(trimmed, category);
      toast(`${CATEGORIES.find(c => c.value === category)?.label} 저장됨`, 'success');
      setText('');
      // 연속 입력 지원: 저장 후 바로 다시 포커스 (닫지 않음)
      setTimeout(() => textareaRef.current?.focus(), 50);
    } catch {
      toast('저장에 실패했습니다', 'error');
    } finally {
      setSaving(false);
    }
  }, [text, category, saving, toast]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSave();
    }
  }

  // Brain 페이지에서는 FAB 위치 조정 불필요 — 항상 오른쪽 하단
  const isBrainPage = pathname.startsWith('/brain');

  return (
    <>
      {/* ── FAB 버튼 ── */}
      <button
        onClick={() => setOpen(true)}
        className={`fixed z-40 w-12 h-12 rounded-full bg-primary text-white shadow-lg flex items-center justify-center
          hover:bg-primary/90 active:scale-95 transition-all duration-150
          ${isBrainPage ? 'bottom-24 right-4 md:bottom-6' : 'bottom-6 right-4'}`}
        aria-label="빠른 캡처 (Cmd+Shift+N)"
        title="빠른 캡처 (Cmd+Shift+N)"
      >
        <Plus className="w-5 h-5" />
      </button>

      {/* ── 바텀 시트 오버레이 ── */}
      {open && (
        <>
          {/* 배경 딤처리 */}
          <div
            className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />

          {/* 시트 본체 */}
          <div className="fixed bottom-0 left-0 right-0 z-50 bg-bg-card rounded-t-2xl shadow-2xl
            animate-in slide-in-from-bottom duration-200 safe-bottom">
            {/* 드래그 핸들 */}
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 rounded-full bg-border" />
            </div>

            <div className="px-4 pb-6 pt-2">
              {/* 카테고리 탭 + 닫기 */}
              <div className="flex items-center justify-between mb-3">
                <div className="flex gap-1.5">
                  {CATEGORIES.map(c => (
                    <button
                      key={c.value}
                      onClick={() => { setCategory(c.value); textareaRef.current?.focus(); }}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                        category === c.value
                          ? 'bg-primary text-white'
                          : 'bg-bg-input text-text-muted hover:bg-bg-hover hover:text-text-heading'
                      }`}
                    >
                      {c.icon}
                      {c.label}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => setOpen(false)}
                  className="p-1.5 rounded-lg text-text-muted hover:text-text-heading hover:bg-bg-hover transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* 입력 영역 */}
              <div className="bg-bg-input rounded-xl border border-border/30 focus-within:ring-2 focus-within:ring-primary/50 transition-all">
                <textarea
                  ref={textareaRef}
                  value={text}
                  onChange={e => setText(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={PLACEHOLDERS[category]}
                  rows={3}
                  className="w-full bg-transparent text-text-heading px-4 pt-3 pb-2 text-sm
                    focus:outline-none resize-none min-h-[80px] max-h-[180px]"
                />
                <div className="flex items-center justify-between px-3 pb-2.5">
                  <span className="text-[11px] text-text-muted">
                    Enter 저장 · Shift+Enter 줄바꿈 · Esc 닫기
                  </span>
                  <button
                    onClick={handleSave}
                    disabled={!text.trim() || saving}
                    className="flex items-center gap-1.5 px-3.5 py-1.5 bg-primary text-white rounded-lg
                      text-xs font-medium disabled:opacity-40 transition-opacity hover:bg-primary/90"
                  >
                    {saving ? (
                      <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    ) : (
                      <Zap className="w-3.5 h-3.5" />
                    )}
                    저장
                  </button>
                </div>
              </div>

              {/* 힌트: 연속 입력 가능 안내 */}
              <p className="text-[11px] text-text-muted text-center mt-2">
                저장 후 계속 입력 가능 · 닫으려면 배경을 탭하거나 Esc
              </p>
            </div>
          </div>
        </>
      )}
    </>
  );
}
