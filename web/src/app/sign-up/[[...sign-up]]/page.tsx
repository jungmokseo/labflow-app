'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase';

export default function SignUpPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { name } },
    });
    if (error) {
      setError(error.message);
      setLoading(false);
    } else {
      setSent(true);
      setLoading(false);
    }
  };

  const handleGoogleSignUp = async () => {
    const supabase = createClient();
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
  };

  if (sent) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-bg px-4">
        <div className="w-full max-w-sm bg-bg-card border border-border rounded-xl p-6 shadow-xl text-center">
          <h2 className="text-lg font-semibold text-text-heading mb-4">이메일을 확인해주세요</h2>
          <p className="text-text-muted text-sm mb-4">{email}로 인증 메일을 보냈습니다.<br />메일의 링크를 클릭하면 가입이 완료됩니다.</p>
          <Link href="/sign-in" className="text-primary hover:text-primary-hover text-sm">로그인으로 돌아가기</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-bg px-4">
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-bold text-text-heading mb-2">
          <span className="text-primary">Research Flow</span>
        </h1>
        <p className="text-text-muted text-sm">Research Lab AI OS</p>
      </div>

      <div className="w-full max-w-sm bg-bg-card border border-border rounded-xl p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-text-heading mb-6 text-center">회원가입</h2>

        <button
          onClick={handleGoogleSignUp}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-bg-input border border-border text-text-heading hover:bg-bg-hover/80 transition-colors mb-4"
        >
          <svg width="18" height="18" viewBox="0 0 18 18"><path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/><path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853"/><path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.997 8.997 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/><path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/></svg>
          Google로 가입하기
        </button>

        <div className="relative my-4">
          <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-border" /></div>
          <div className="relative flex justify-center text-xs"><span className="bg-bg-card px-2 text-text-muted">또는</span></div>
        </div>

        <form onSubmit={handleSignUp} className="space-y-4">
          <div>
            <label className="block text-sm text-text-muted mb-1">이름</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} required
              className="w-full px-3 py-2 rounded-lg bg-bg-input border border-border text-text-heading text-sm focus:outline-none focus:border-primary" />
          </div>
          <div>
            <label className="block text-sm text-text-muted mb-1">이메일</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required
              className="w-full px-3 py-2 rounded-lg bg-bg-input border border-border text-text-heading text-sm focus:outline-none focus:border-primary" />
          </div>
          <div>
            <label className="block text-sm text-text-muted mb-1">비밀번호</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6}
              className="w-full px-3 py-2 rounded-lg bg-bg-input border border-border text-text-heading text-sm focus:outline-none focus:border-primary" />
          </div>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <button type="submit" disabled={loading}
            className="w-full py-2.5 rounded-lg bg-primary hover:bg-primary-hover text-white font-medium text-sm transition-colors disabled:opacity-50">
            {loading ? '가입 중...' : '가입하기'}
          </button>
        </form>

        <p className="mt-4 text-center text-sm text-text-muted">
          이미 계정이 있으신가요? <Link href="/sign-in" className="text-primary hover:text-primary-hover">로그인</Link>
        </p>
      </div>

      <div className="mt-6 text-center text-xs text-text-muted space-x-3">
        <a href="/legal/terms.html" className="hover:text-text-heading transition-colors">이용약관</a>
        <span>|</span>
        <a href="/legal/privacy.html" className="hover:text-text-heading transition-colors">개인정보처리방침</a>
      </div>
    </div>
  );
}
