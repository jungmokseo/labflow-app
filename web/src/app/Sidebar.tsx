'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase';
import type { User } from '@supabase/supabase-js';
import { mutate } from 'swr';
import {
  getCaptures, getBrainChannels, getMeetings, getPaperAlertResults,
  deleteBrainChannel, searchBrainMemory,
} from '@/lib/api';
import {
  LayoutDashboard, Brain, ClipboardList, BookOpen, Mic,
  FlaskConical, Settings, Loader2, Sun, Moon,
  Plus, Search, X, MessageSquare, Trash2,
  PanelLeftClose, PanelLeft, LogOut,
} from 'lucide-react';
import { useBackgroundTasks } from '@/store/background-tasks';
import { useBrainSessionsStore } from '@/store/brain-sessions';
import { useConversationsStore } from '@/store/conversations';

// Prefetch data on hover — warms SWR cache before navigation
const PREFETCH_MAP: Record<string, () => void> = {
  '/tasks': () => mutate('captures-all-active-newest', () => getCaptures({ sort: 'newest' }), { revalidate: false }),
  '/brain': () => mutate('brain-channels', () => getBrainChannels().then(r => Array.isArray(r.data) ? r.data : []), { revalidate: false }),
  '/meetings': () => mutate('meetings', () => getMeetings(), { revalidate: false }),
  '/papers': () => mutate('paper-results-v2', () => getPaperAlertResults().catch(() => null), { revalidate: false }),
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

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}일 전`;
  return new Date(dateStr).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

function isToday(dateStr: string): boolean {
  return new Date(dateStr).toDateString() === new Date().toDateString();
}

function isThisWeek(dateStr: string): boolean {
  return Date.now() - new Date(dateStr).getTime() < 7 * 24 * 60 * 60 * 1000;
}

function NavContent({ pathname, onNavigate, user, onSignOut, collapsed, onToggleCollapse }: {
  pathname: string;
  onNavigate?: () => void;
  user: User | null;
  onSignOut: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const { tasks } = useBackgroundTasks();
  const runningTasks = tasks.filter(t => t.status === 'running');
  const { dark, toggle } = useTheme();
  const isBrainPage = pathname.startsWith('/brain');

  // Brain sessions & search (only active on /brain)
  const { sessions } = useBrainSessionsStore();
  const { activeChannelId, setActive } = useConversationsStore();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any>(null);
  const [searching, setSearching] = useState(false);

  const todaySessions = sessions.filter((c) => isToday(c.lastMessageAt || c.createdAt));
  const weekSessions = sessions.filter((c) => !isToday(c.lastMessageAt || c.createdAt) && isThisWeek(c.lastMessageAt || c.createdAt));
  const olderSessions = sessions.filter((c) => !isThisWeek(c.lastMessageAt || c.createdAt));

  async function handleSearch() {
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const res = await searchBrainMemory(searchQuery);
      setSearchResults(res.data || res);
    } catch {
      setSearchResults(null);
    } finally { setSearching(false); }
  }

  async function handleDeleteSession(id: string) {
    if (!confirm('이 대화를 삭제하시겠습니까?')) return;
    try {
      await deleteBrainChannel(id);
      useBrainSessionsStore.getState().removeSession(id);
      if (activeChannelId === id) setActive(null);
    } catch {}
  }

  function handleSelectSession(id: string) {
    setActive(id);
    onNavigate?.();
  }

  return (
    <>
      <div className="p-4 pb-2 flex items-center justify-between">
        <h1 className="text-lg font-bold text-text-heading">
          <FlaskConical className="w-4 h-4 text-primary inline-block" /> <span className="text-primary">Research Flow</span>
        </h1>
        {onToggleCollapse && (
          <button onClick={onToggleCollapse} className="p-1.5 rounded-lg text-text-muted hover:text-text-heading hover:bg-bg-hover transition-colors" title="사이드바 접기">
            <PanelLeftClose className="w-4 h-4" />
          </button>
        )}
      </div>

      <nav className="px-3 space-y-0.5">
        {NAV_ITEMS.map((item) => {
          const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              onMouseEnter={() => PREFETCH_MAP[item.href]?.()}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-all duration-150 focus-ring ${
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

      {/* Brain session list — shown when on /brain */}
      {isBrainPage && (
        <div className="flex-1 flex flex-col min-h-0 mt-3 border-t border-border">
          {/* New chat + search */}
          <div className="px-3 pt-3 pb-1 space-y-2">
            <button
              onClick={() => { setActive(null); onNavigate?.(); }}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-primary-light text-primary rounded-lg text-sm hover:bg-primary/20 font-medium"
            >
              <Plus className="w-4 h-4" /> 새 대화
            </button>
            <button
              onClick={() => setSearchOpen(!searchOpen)}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                searchOpen ? 'bg-primary text-white' : 'bg-bg-input text-text-muted hover:text-text-heading hover:bg-bg-hover border border-border'
              }`}
            >
              <Search className="w-3.5 h-3.5" />
              <span>검색</span>
              <kbd className="ml-auto text-xs opacity-60">⌘K</kbd>
            </button>
          </div>

          {/* Search panel */}
          {searchOpen && (
            <div className="px-3 pb-2 space-y-2">
              <div className="flex gap-1.5">
                <input
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSearch()}
                  placeholder="과제, 논문, 메모..."
                  className="flex-1 bg-bg-input text-text-heading px-3 py-1.5 rounded-lg text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                  autoFocus
                />
                <button onClick={handleSearch} disabled={searching}
                  className="px-3 py-1.5 bg-primary text-white rounded-lg text-xs disabled:opacity-50">
                  {searching ? '...' : '검색'}
                </button>
              </div>
              {searchResults && (
                <div className="max-h-48 overflow-y-auto space-y-1">
                  {['projects', 'publications', 'members', 'memos'].map(key => {
                    const items = searchResults[key];
                    if (!items?.length) return null;
                    const labels: Record<string, string> = { projects: '과제', publications: '논문', members: '구성원', memos: '메모' };
                    return (
                      <div key={key}>
                        <p className="text-xs text-primary font-medium px-1 pt-1">{labels[key]} ({items.length})</p>
                        {items.slice(0, 3).map((item: any) => (
                          <div key={item.id} className="px-2 py-1.5 rounded text-xs text-text-heading bg-bg-input/50 mb-0.5">
                            {item.name || item.title || (item.content?.slice(0, 60) + '...')}
                          </div>
                        ))}
                      </div>
                    );
                  })}
                  {!searchResults.projects?.length && !searchResults.publications?.length && !searchResults.members?.length && !searchResults.memos?.length && (
                    <p className="text-xs text-text-muted text-center py-2">결과 없음</p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Session list */}
          <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-0.5">
            {!activeChannelId && (
              <div className="px-3 py-2 rounded-lg text-sm bg-primary-light text-primary flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                <span className="text-xs font-medium">새 대화</span>
              </div>
            )}
            {todaySessions.length > 0 && (
              <>
                <p className="text-[10px] text-text-muted uppercase tracking-wider px-2 pt-3 pb-1">오늘</p>
                {todaySessions.map((ch) => (
                  <SidebarSessionButton key={ch.id} ch={ch} isActive={activeChannelId === ch.id} onClick={() => handleSelectSession(ch.id)} onDelete={() => handleDeleteSession(ch.id)} />
                ))}
              </>
            )}
            {weekSessions.length > 0 && (
              <>
                <p className="text-[10px] text-text-muted uppercase tracking-wider px-2 pt-3 pb-1">이번 주</p>
                {weekSessions.map((ch) => (
                  <SidebarSessionButton key={ch.id} ch={ch} isActive={activeChannelId === ch.id} onClick={() => handleSelectSession(ch.id)} onDelete={() => handleDeleteSession(ch.id)} />
                ))}
              </>
            )}
            {olderSessions.length > 0 && (
              <>
                <p className="text-[10px] text-text-muted uppercase tracking-wider px-2 pt-3 pb-1">이전</p>
                {olderSessions.slice(0, 15).map((ch) => (
                  <SidebarSessionButton key={ch.id} ch={ch} isActive={activeChannelId === ch.id} onClick={() => handleSelectSession(ch.id)} onDelete={() => handleDeleteSession(ch.id)} />
                ))}
              </>
            )}
          </div>
        </div>
      )}

      {/* Non-brain: show flex spacer */}
      {!isBrainPage && <div className="flex-1" />}

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

      <div className="px-3 py-3 border-t border-border">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-primary-light text-primary flex items-center justify-center text-xs font-bold flex-shrink-0">
            {user?.email?.charAt(0).toUpperCase() || '?'}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-text-heading truncate">
              {user?.user_metadata?.name || user?.email || '...'}
            </p>
          </div>
          <button
            onClick={toggle}
            className="p-1 rounded-lg text-text-muted hover:text-text-heading hover:bg-bg-hover transition-colors"
            title={dark ? '라이트 모드' : '다크 모드'}
          >
            {dark ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={onSignOut}
            className="p-1 rounded-lg text-text-muted hover:text-red-500 hover:bg-bg-hover transition-colors"
            title="로그아웃"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </>
  );
}

function SidebarSessionButton({ ch, isActive, onClick, onDelete }: { ch: any; isActive: boolean; onClick: () => void; onDelete: () => void }) {
  const { conversations } = useConversationsStore();
  const isStreaming = conversations[ch.id]?.isStreaming;
  return (
    <div className={`group w-full flex items-center gap-1 px-3 py-2 rounded-lg text-sm transition-colors ${
      isActive ? 'bg-primary-light text-primary' : 'text-text-muted hover:bg-bg-hover hover:text-text-heading'
    }`}>
      <button onClick={onClick} className="flex-1 flex items-center gap-2 min-w-0">
        {isStreaming ? <Loader2 className="w-3 h-3 animate-spin text-primary flex-shrink-0" /> : isActive ? <span className="w-2 h-2 rounded-full bg-primary flex-shrink-0" /> : null}
        <span className="flex-1 text-left truncate text-xs">
          {ch.name || `대화 #${ch.id.slice(-4)}`}
        </span>
        <span className="text-[10px] text-text-muted flex-shrink-0">
          {timeAgo(ch.lastMessageAt || ch.createdAt)}
        </span>
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-red-400 flex-shrink-0 p-0.5 transition-opacity"
        title="삭제"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [user, setUser] = useState<User | null>(null);

  // Persist collapsed state
  useEffect(() => {
    const saved = localStorage.getItem('sidebar-collapsed');
    if (saved === 'true') setCollapsed(true);
  }, []);
  useEffect(() => {
    localStorage.setItem('sidebar-collapsed', String(collapsed));
  }, [collapsed]);

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
      <aside className={`hidden md:flex flex-col bg-bg-sidebar border-r border-border-strong transition-all duration-200 ${collapsed ? 'w-16' : 'w-64'}`}>
        {collapsed ? (
          <div className="flex flex-col h-full items-center py-4">
            <button onClick={() => setCollapsed(false)} className="p-2 rounded-lg text-text-muted hover:text-text-heading hover:bg-bg-hover mb-4" title="사이드바 펼치기">
              <PanelLeft className="w-5 h-5" />
            </button>
            {NAV_ITEMS.map((item) => {
              const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
              return (
                <Link key={item.href} href={item.href} onMouseEnter={() => PREFETCH_MAP[item.href]?.()}
                  className={`p-2.5 rounded-lg mb-1 transition-colors ${active ? 'bg-primary-light text-primary' : 'text-text-muted hover:bg-bg-hover hover:text-text-heading'}`}
                  title={item.label}>
                  <item.icon className="w-4 h-4" />
                </Link>
              );
            })}
            <div className="flex-1" />
            <button onClick={handleSignOut}
              className="w-8 h-8 rounded-full bg-primary-light text-primary flex items-center justify-center text-sm font-bold mb-2"
              title="로그아웃">
              {user?.email?.charAt(0).toUpperCase() || '?'}
            </button>
          </div>
        ) : (
          <NavContent pathname={pathname} user={user} onSignOut={handleSignOut} collapsed={collapsed} onToggleCollapse={() => setCollapsed(true)} />
        )}
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
