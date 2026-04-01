import type { Metadata } from 'next';
import './globals.css';
import { Sidebar } from './Sidebar';
import { AuthInit } from '@/components/AuthInit';
import { createServerSupabaseClient } from '@/lib/supabase-server';

export const metadata: Metadata = {
  title: 'LabFlow — Research Lab AI OS',
  description: 'AI-powered research lab management dashboard',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();

  return (
    <html lang="ko" className="dark">
      <body className="min-h-screen bg-bg text-text-main antialiased">
        <AuthInit />
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
      </body>
    </html>
  );
}
