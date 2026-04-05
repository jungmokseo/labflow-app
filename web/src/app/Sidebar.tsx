'use client';

import { useState, useEffect } from 'react';
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
  FlaskConical, Settings, Loader2,
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

function NavContent({ pathname, onNavigate, user, onSignOut }: {
  pathname: string;
  onNavigate?: () => void;
  user: User | null;
  onSignOut: () => void;
}) {
  const { tasks } = useBackgroundTasks();
  const runningTasks = tasks.filter(t => t.status === 'running');

  return (
    <>
      <div className="p-6">
        <h1 className="text-xl font-bold text-white">
          <FlaskConical className="w-5 h-5 text-primary inline-block" /> <span className="text-primary">LabFlow</span>
        </h1>
        <p className="text-xs text-text-muted mt-1">Research Lab AI OS</p>
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
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                active
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'text-text-muted hover:bg-bg-input/50 hover:text-white'
              }`}
            >
              <item.icon className="w-4 h-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {runningTasks.length > 0 && (
        <div className="px-4 py-2 border-t border-bg-input/50">
          {runningTasks.map(task => (
            <div key={task.id} className="flex items-center gap-2 text-xs text-text-muted py-1">
              <Loader2 className="w-3 h-3 animate-spin text-primary" />
              <span className="truncate">{task.label}</span>
            </div>
          ))}
        </div>
      )}

      <div className="p-4 border-t border-bg-input/50">
        <div className="flex items-center gap-3">
          <button
            onClick={onSignOut}
            className="w-8 h-8 rounded-full bg-primary/20 text-primary flex items-center justify-center text-sm font-bold hover:bg-primary/30 transition-colors"
            title="로그아웃"
          >
            {user?.email?.charAt(0).toUpperCase() || '?'}
          </button>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-white truncate">
              {user?.user_metadata?.name || user?.email || '...'}
            </p>
            <p className="text-xs text-text-muted truncate">
              {user?.email || ''}
            </p>
          </div>
        </div>
        <div className="mt-3 flex gap-2 text-[10px] text-text-muted/60">
          <a href="/legal/terms.html" className="hover:text-text-muted transition-colors">이용약관</a>
          <span>·</span>
          <a href="/legal/privacy.html" className="hover:text-text-muted transition-colors">개인정보처리방침</a>
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
      <aside className="hidden md:flex w-64 flex-col bg-bg-card border-r border-bg-input/50">
        <NavContent pathname={pathname} user={user} onSignOut={handleSignOut} />
      </aside>

      {/* Mobile hamburger button */}
      <button
        onClick={() => setMobileOpen(true)}
        className="md:hidden fixed top-3 left-3 z-50 p-2 rounded-lg bg-bg-card/80 backdrop-blur border border-bg-input/50 text-white"
        aria-label="메뉴 열기"
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 5h14M3 10h14M3 15h14" />
        </svg>
      </button>

      {/* Mobile drawer overlay */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="relative w-72 flex flex-col bg-bg-card border-r border-bg-input/50 animate-in slide-in-from-left duration-200">
            <button
              onClick={() => setMobileOpen(false)}
              className="absolute top-4 right-4 p-1 text-text-muted hover:text-white"
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
