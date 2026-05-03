import type { Metadata, Viewport } from 'next';
import { Suspense } from 'react';
import { headers } from 'next/headers';
import './globals.css';
import { Sidebar } from './Sidebar';
import { AuthInit } from '@/components/AuthInit';
import { ServiceWorkerRegister } from '@/components/ServiceWorkerRegister';
import { DataPrefetch } from '@/components/DataPrefetch';
import { ToastProvider } from '@/components/Toast';
import { KeyboardShortcuts } from '@/components/KeyboardShortcuts';
import { TokenHealthCheck } from '@/components/TokenHealthCheck';
import { QuickCapture } from '@/components/QuickCapture';
import { OfflineStatusBadge } from '@/components/OfflineStatusBadge';
import { SWRProvider } from '@/lib/swr-provider';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
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

const PUBLIC_ROUTES = ['/sign-in', '/sign-up', '/legal', '/auth/callback', '/offline'];

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // middleware가 이미 인증을 보장 — SSR에서 Supabase를 다시 호출하지 않음 (TTFB 최적화)
  // pathname은 middleware가 x-pathname 헤더로 전달
  const hdrs = await headers();
  const pathname = hdrs.get('x-pathname') || '/';
  const isPublicRoute = PUBLIC_ROUTES.some((route) => pathname.startsWith(route));
  const showAuthenticatedUI = !isPublicRoute;

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
        <SWRProvider>
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
                {/* 빠른 캡처 FAB — 모든 페이지에서 접근 가능 */}
                <Suspense fallback={null}>
                  <QuickCapture />
                </Suspense>
              </div>
            ) : (
              children
            )}
            <OfflineStatusBadge />
          </ToastProvider>
        </SWRProvider>
      </body>
    </html>
  );
}
