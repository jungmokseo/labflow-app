'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { UserButton, useUser } from '@clerk/nextjs';

const NAV_ITEMS = [
  { href: '/brain', icon: '🧠', label: 'Brain' },
  { href: '/papers', icon: '📚', label: '연구동향' },
  { href: '/meetings', icon: '🎙️', label: '회의 노트' },
  { href: '/settings', icon: '⚙️', label: '설정' },
];

export function Sidebar() {
  const pathname = usePathname();
  const { user, isLoaded } = useUser();

  return (
    <aside className="hidden md:flex w-64 flex-col bg-bg-card border-r border-bg-input/50">
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
    </aside>
  );
}
