/**
 * Supabase Auth 미들웨어 — Next.js App Router
 *
 * 공개 라우트: /sign-in, /sign-up, /legal/*
 * 보호 라우트: 나머지 전부 → 미인증 시 /sign-in으로 리다이렉트
 */

import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC_ROUTES = ['/sign-in', '/sign-up', '/legal', '/auth/callback'];

function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTES.some((route) => pathname.startsWith(route));
}

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // 세션 갱신 (Supabase가 쿠키 기반 세션 사용)
  const { data: { user } } = await supabase.auth.getUser();

  // 보호 라우트에 비인증 접근 → 리다이렉트
  if (!user && !isPublicRoute(request.nextUrl.pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = '/sign-in';
    url.searchParams.set('redirect_url', request.nextUrl.pathname);
    return NextResponse.redirect(url);
  }

  // 인증된 사용자가 sign-in/sign-up 접근 → 대시보드로
  if (user && (request.nextUrl.pathname.startsWith('/sign-in') || request.nextUrl.pathname.startsWith('/sign-up'))) {
    const url = request.nextUrl.clone();
    url.pathname = '/brain';
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
  ],
};
