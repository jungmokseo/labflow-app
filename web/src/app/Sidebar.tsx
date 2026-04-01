'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { UserButton, useUser } from '@clerk/nextjs';

const NAV_ITEMS = [
  { href: '/', icon: '🏠', label: '대시보드' },
  { href: '/brain', icon: '🧠', label: 'Brain' },
  { href: '/tasks', icon: '📋', label: 'Tasks & Ideas' },
  { href: '/papers', icon: '📚', label: '연구동향' },
  { href: '/meetings', icon: '🎙️', label: '회의 노트' },
  { href: '/lab-profile', icon: '🔬', label: '연구실 프로필' },
  { href: '/settings', icon: '⚙️', label: '설정' },
];

function NavContent({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  const { user, isLoaded } = useUser();

  return (
    <>
      <div className="p-6">
        <h1 className="text-xl font-bold text-white">
          🧪 <span className="text-primary">LabFlow</span>
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
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                active
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'text-text-muted hover:bg-bg-input/50 hover:text-white'
              }`}
            >
              <span className="text-base">{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="p-4 border-t border-bg-input/50">
        <div className="flex items-center gap-3">
          <UserButton
            afterSignOutUrl="/sign-in"
            appearance={{
              elements: {
                avatarBox: 'w-8 h-8',
              },
            }}
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-white truncate">
              {isLoaded && user ? (user.fullName || user.primaryEmailAddress?.emailAddress || 'User') : '...'}
            </p>
            <p className="text-xs text-text-muted truncate">
              {isLoaded && user ? user.primaryEmailAddress?.emailAddress : ''}
            </p>
          </div>
        </div>
      </div>
    </>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close drawer on route change
  useEffect(() => { setMobileOpen(false); }, [pathname]);

  // Prevent body scroll when drawer open
  useEffect(() => {
    document.body.style.overflow = mobileOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [mobileOpen]);

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-64 flex-col bg-bg-card border-r border-bg-input/50">
        <NavContent pathname={pathname} />
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
            <NavContent pathname={pathname} onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}
    </>
  );
}
