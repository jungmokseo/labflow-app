'use client';

import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Search, X, Brain, ClipboardList, BookOpen, Mic, Settings, LayoutDashboard } from 'lucide-react';

const SHORTCUTS = [
  { key: 'b', label: 'Brain 채팅', path: '/brain', icon: Brain },
  { key: 't', label: 'Tasks & Ideas', path: '/tasks', icon: ClipboardList },
  { key: 'm', label: '미팅 노트', path: '/meetings', icon: Mic },
  { key: 'p', label: '논문 알림', path: '/papers', icon: BookOpen },
  { key: 'd', label: '대시보드', path: '/', icon: LayoutDashboard },
  { key: 's', label: '설정', path: '/settings', icon: Settings },
];

export function KeyboardShortcuts() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Cmd+K or Ctrl+K — toggle command palette
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen(prev => !prev);
        setQuery('');
      }
      // Escape — close
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        setOpen(false);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const filtered = query
    ? SHORTCUTS.filter(s => s.label.toLowerCase().includes(query.toLowerCase()) || s.key.includes(query.toLowerCase()))
    : SHORTCUTS;

  function navigate(path: string) {
    setOpen(false);
    router.push(path);
  }

  return (
    <>
      <div className="fixed inset-0 bg-[var(--color-overlay)] z-[9990] backdrop-blur-sm" onClick={() => setOpen(false)} />
      <div className="fixed top-[20%] left-1/2 -translate-x-1/2 w-full max-w-md z-[9991] animate-msg-in">
        <div className="bg-bg-card border border-border rounded-xl shadow-2xl overflow-hidden">
          <div className="flex items-center gap-3 p-4 border-b border-border">
            <Search className="w-5 h-5 text-text-muted flex-shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="이동할 페이지를 검색하세요..."
              className="flex-1 bg-transparent text-text-heading text-sm focus:outline-none placeholder:text-text-muted"
              onKeyDown={e => {
                if (e.key === 'Enter' && filtered.length > 0) navigate(filtered[0].path);
              }}
            />
            <kbd className="text-[10px] text-text-muted bg-bg-input px-1.5 py-0.5 rounded">ESC</kbd>
          </div>
          <div className="max-h-[300px] overflow-y-auto p-2">
            {filtered.map(s => (
              <button
                key={s.key}
                onClick={() => navigate(s.path)}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-text-muted hover:bg-bg-hover hover:text-text-heading transition-colors"
              >
                <s.icon className="w-4 h-4 flex-shrink-0" />
                <span className="flex-1 text-left">{s.label}</span>
                <kbd className="text-[10px] bg-bg-input px-1.5 py-0.5 rounded">
                  {navigator.platform?.includes('Mac') ? '⌘' : 'Ctrl+'}{s.key.toUpperCase()}
                </kbd>
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="text-center text-text-muted text-sm py-4">결과 없음</p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
