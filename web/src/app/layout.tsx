import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Sidebar } from './Sidebar';
import { AuthInit } from '@/components/AuthInit';
import { ServiceWorkerRegister } from '@/components/ServiceWorkerRegister';
import { DataPrefetch } from '@/components/DataPrefetch';
import { GlobalProgress } from '@/components/GlobalProgress';
import { ToastProvider } from '@/components/Toast';
import { KeyboardShortcuts } from '@/components/KeyboardShortcuts';
import { createServerSupabaseClient } from '@/lib/supabase-server';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#6366f1',
};

export const metadata: Metadata = {
  title: 'LabFlow — Research Lab AI OS',
  description: 'AI-powered research lab management dashboard',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'LabFlow',
  },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();

  return (
    <html lang="ko" className="dark">
      <body className="min-h-screen bg-bg text-text-main antialiased">
        <ToastProvider>
          <GlobalProgress />
          <KeyboardShortcuts />
          <AuthInit />
          <ServiceWorkerRegister />
          <DataPrefetch />
          {user ? (
            <div className="flex h-screen">
              <Sidebar />
              <main className="flex-1 overflow-auto">
                {children}
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
