/**
 * Supabase Auth 미들웨어 — Next.js App Router
 *
 * 공개 라우트: /sign-in, /sign-up, /legal/*
 * 보호 라우트: 나머지 전부 → 미인증 시 /sign-in으로 리다이렉트
 */

import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC_ROUTES = ['/sign-in', '/sign-up', '/legal', '/auth/callback', '/offline'];

function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTES.some((route) => pathname.startsWith(route));
}

export async function middleware(request: NextRequest) {
  // 로컬 개발 시 인증 우회 (npm run dev)
  if (process.env.NODE_ENV === 'development' && request.nextUrl.hostname === 'localhost') {
    return NextResponse.next({ request });
  }

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

  // 세션 검증 — getSession()은 cookie만 읽음 (네트워크 호출 없음, ~0ms).
  // getUser()는 매 요청마다 Supabase 서버 검증(200~500ms)이라 미들웨어에 부적합.
  // JWT signature는 cookie 자체에 포함되어 있어 cookie 위조는 불가능 → middleware 단계 보안 충분.
  // 민감한 API는 server에서 별도로 getUser()로 재검증.
  const { data: { session } } = await supabase.auth.getSession();
  const isAuthed = !!session?.user;

  // 보호 라우트에 비인증 접근 → 리다이렉트
  if (!isAuthed && !isPublicRoute(request.nextUrl.pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = '/sign-in';
    url.searchParams.set('redirect_url', request.nextUrl.pathname);
    return NextResponse.redirect(url);
  }

  // 인증된 사용자가 sign-in/sign-up 접근 → 대시보드로
  if (isAuthed && (request.nextUrl.pathname.startsWith('/sign-in') || request.nextUrl.pathname.startsWith('/sign-up'))) {
    const url = request.nextUrl.clone();
    url.pathname = '/brain';
    return NextResponse.redirect(url);
  }

  // pathname을 layout에 전달 — RootLayout이 SSR에서 supabase 호출하지 않도록
  supabaseResponse.headers.set('x-pathname', request.nextUrl.pathname);
  return supabaseResponse;
}

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
  ],
};
