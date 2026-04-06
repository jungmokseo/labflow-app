'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase';
import type { User } from '@supabase/supabase-js';
import { mutate } from 'swr';
import {
  getCaptures, getBrainChannels, getMeetings, getPaperAlertResults,
} from '@/lib/api';
import {
  LayoutDashboard, Brain, ClipboardList, BookOpen, Mic,
  FlaskConical, Settings, Loader2, Sun, Moon,
} from 'lucide-react';
import { useBackgroundTasks } from '@/store/background-tasks';

// Prefetch data on hover — warms SWR cache before navigation
const PREFETCH_MAP: Record<string, () => void> = {
  '/tasks': () => mutate('captures-all-active-newest', () => getCaptures({ sort: 'newest' }), { revalidate: false }),
  '/brain': () => mutate('brain-channels', () => getBrainChannels().then(r => Array.isArray(r.data) ? r.data : []), { revalidate: false }),
  '/meetings': () => mutate('meetings', () => getMeetings(), { revalidate: false }),
  '/papers': () => mutate('paper-results', () => getPaperAlertResults().then(r => r.results || r.data || []).catch(() => null), { revalidate: false }),
};

const NAV_ITEMS = [
  { href: '/', icon: LayoutDashboard, label: '대시보드' },
  { href: '/brain', icon: Brain, label: 'Brain' },
  { href: '/tasks', icon: ClipboardList, label: 'Tasks & Ideas' },
  { href: '/papers', icon: BookOpen, label: '연구동향' },
  { href: '/meetings', icon: Mic, label: '회의 노트' },
  { href: '/lab-profile', icon: FlaskConical, label: '연구실 프로필' },
  { href: '/settings', icon: Settings, label: '설정' },
];

function useTheme() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.getAttribute('data-theme') === 'dark');
  }, []);

  const toggle = useCallback(() => {
    const next = !dark;
    setDark(next);
    if (next) {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem('theme', 'light');
    }
  }, [dark]);

  return { dark, toggle };
}

function NavContent({ pathname, onNavigate, user, onSignOut }: {
  pathname: string;
  onNavigate?: () => void;
  user: User | null;
  onSignOut: () => void;
}) {
  const { tasks } = useBackgroundTasks();
  const runningTasks = tasks.filter(t => t.status === 'running');
  const { dark, toggle } = useTheme();

  return (
    <>
      <div className="p-6">
        <h1 className="text-xl font-bold text-text-heading">
          <FlaskConical className="w-5 h-5 text-primary inline-block" /> <span className="text-primary">Research Flow</span>
        </h1>
        <p className="text-xs text-text-muted mt-1">연구실 AI 비서</p>
      </div>

      <nav className="flex-1 px-3 space-y-1">
        {NAV_ITEMS.map((item) => {
          const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              onMouseEnter={() => PREFETCH_MAP[item.href]?.()}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all duration-150 focus-ring ${
                active
                  ? 'bg-primary-light text-primary font-medium'
                  : 'text-text-muted hover:bg-bg-hover hover:text-text-heading'
              }`}
            >
              <item.icon className="w-4 h-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Cmd+K shortcut hint — clickable */}
      <div className="px-3 mt-4 hidden md:block">
        <button
          onClick={() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))}
          className="w-full flex items-center justify-between px-3 py-2 text-sm text-text-muted bg-bg-input hover:bg-bg-hover rounded-lg border border-border transition-colors cursor-pointer"
        >
          <span>빠른 이동...</span>
          <kbd className="text-xs bg-bg-card px-1.5 py-0.5 rounded border border-border">⌘K</kbd>
        </button>
      </div>

      {runningTasks.length > 0 && (
        <div className="px-4 py-2 border-t border-border">
          {runningTasks.map(task => (
            <div key={task.id} className="flex items-center gap-2 text-xs text-text-muted py-1">
              <Loader2 className="w-3 h-3 animate-spin text-primary" />
              <span className="truncate">{task.label}</span>
            </div>
          ))}
        </div>
      )}

      <div className="p-4 border-t border-border">
        <div className="flex items-center gap-3">
          <button
            onClick={onSignOut}
            className="w-8 h-8 rounded-full bg-primary-light text-primary flex items-center justify-center text-sm font-bold hover:bg-primary-light transition-colors"
            title="로그아웃"
          >
            {user?.email?.charAt(0).toUpperCase() || '?'}
          </button>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-text-heading truncate">
              {user?.user_metadata?.name || user?.email || '...'}
            </p>
            <p className="text-xs text-text-muted truncate">
              {user?.email || ''}
            </p>
          </div>
          <button
            onClick={toggle}
            className="p-1.5 rounded-lg text-text-muted hover:text-text-heading hover:bg-bg-hover transition-colors"
            title={dark ? '라이트 모드' : '다크 모드'}
          >
            {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>
        <div className="mt-3 flex gap-2 text-xs text-text-muted">
          <a href="/legal/terms.html" className="hover:text-text-main transition-colors">이용약관</a>
          <span>·</span>
          <a href="/legal/privacy.html" className="hover:text-text-main transition-colors">개인정보처리방침</a>
        </div>
      </div>
    </>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => { setMobileOpen(false); }, [pathname]);

  useEffect(() => {
    document.body.style.overflow = mobileOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [mobileOpen]);

  // Supabase user 로드
  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => setUser(data.user));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });
    return () => subscription.unsubscribe();
  }, []);

  const handleSignOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/sign-in');
  };

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-64 flex-col bg-bg-sidebar border-r border-border">
        <NavContent pathname={pathname} user={user} onSignOut={handleSignOut} />
      </aside>

      {/* Mobile top bar */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-40 h-14 flex items-center px-3 bg-bg-sidebar/90 backdrop-blur border-b border-border">
        <button
          onClick={() => setMobileOpen(true)}
          className="p-2 rounded-lg text-text-heading"
          aria-label="메뉴 열기"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 5h14M3 10h14M3 15h14" />
          </svg>
        </button>
        <span className="flex-1 text-center text-base font-semibold text-text-heading">Research Flow</span>
        <div className="w-9" /> {/* Spacer to center title */}
      </div>

      {/* Mobile drawer overlay */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <div
            className="fixed inset-0 bg-[var(--color-overlay)] backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="relative w-72 flex flex-col bg-bg-card border-r border-border animate-in slide-in-from-left duration-200">
            <button
              onClick={() => setMobileOpen(false)}
              className="absolute top-4 right-4 p-1 text-text-muted hover:text-text-heading"
              aria-label="메뉴 닫기"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M5 5l10 10M15 5L5 15" />
              </svg>
            </button>
            <NavContent pathname={pathname} onNavigate={() => setMobileOpen(false)} user={user} onSignOut={handleSignOut} />
          </aside>
        </div>
      )}
    </>
  );
}
