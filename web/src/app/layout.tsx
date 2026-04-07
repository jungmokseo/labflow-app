import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Sidebar } from './Sidebar';
import { AuthInit } from '@/components/AuthInit';
import { ServiceWorkerRegister } from '@/components/ServiceWorkerRegister';
import { DataPrefetch } from '@/components/DataPrefetch';
import { ToastProvider } from '@/components/Toast';
import { KeyboardShortcuts } from '@/components/KeyboardShortcuts';
import { TokenHealthCheck } from '@/components/TokenHealthCheck';
import { createServerSupabaseClient } from '@/lib/supabase-server';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#2563EB',
};

export const metadata: Metadata = {
  title: 'Research Flow — Research Lab AI OS',
  description: 'AI-powered research lab management dashboard',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Research Flow',
  },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  let user = null;
  try {
    const supabase = await createServerSupabaseClient();
    const { data } = await supabase.auth.getUser();
    user = data.user;
  } catch {
    // 로컬 개발 시 인증 실패해도 UI 표시
  }

  // 로컬 개발 시 항상 인증된 UI 표시
  const isDev = process.env.NODE_ENV === 'development';
  const showAuthenticatedUI = !!user || isDev;

  return (
    <html lang="ko" suppressHydrationWarning>
      <head>
        {/* Theme initializer — prevents flash of wrong theme */}
        <script dangerouslySetInnerHTML={{ __html: `
          (function() {
            var t = localStorage.getItem('theme');
            if (t === 'dark' || (!t && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
              document.documentElement.setAttribute('data-theme', 'dark');
            }
          })();
        `}} />
      </head>
      <body className="min-h-screen bg-bg text-text-main antialiased">
        <ToastProvider>
          <KeyboardShortcuts />
          <AuthInit />
          <ServiceWorkerRegister />
          <DataPrefetch />
          <TokenHealthCheck />
          {showAuthenticatedUI ? (
            <div className="flex h-dvh">
              <Sidebar />
              <main className="flex-1 overflow-auto pt-14 md:pt-0 bg-bg">
                <div className="min-h-full bg-bg-card md:m-3 md:rounded-2xl md:shadow-card">
                  {children}
                </div>
              </main>
            </div>
          ) : (
            children
          )}
        </ToastProvider>
      </body>
    </html>
  );
}
