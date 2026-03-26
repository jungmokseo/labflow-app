import type { Metadata } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import { auth } from '@clerk/nextjs/server';
import './globals.css';
import { Sidebar } from './Sidebar';
import { AuthInit } from '@/components/AuthInit';

export const metadata: Metadata = {
  title: 'LabFlow — Research Lab AI OS',
  description: 'AI-powered research lab management dashboard',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { userId } = await auth();

  return (
    <ClerkProvider>
      <html lang="ko" className="dark">
        <body className="min-h-screen bg-bg text-text-main antialiased">
          <AuthInit />
          {userId ? (
            <div className="flex h-screen">
              <Sidebar />
              <main className="flex-1 overflow-auto">
                <header className="md:hidden flex items-center justify-between p-4 bg-bg-card border-b border-bg-input/50">
                  <h1 className="text-lg font-bold text-white">🧪 LabFlow</h1>
                </header>
                {children}
              </main>
            </div>
          ) : (
            children
          )}
        </body>
      </html>
    </ClerkProvider>
  );
}
