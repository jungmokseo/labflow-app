/**
 * Clerk 인증 미들웨어 — Next.js App Router
 *
 * 공개 라우트: /, /sign-in, /sign-up, /privacy-policy.html, /terms.html
 * 보호 라우트: 나머지 전부 → 미인증 시 /sign-in으로 리다이렉트
 */

import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

const isPublicRoute = createRouteMatcher([
  '/',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/privacy-policy.html',
  '/terms.html',
]);

export default clerkMiddleware((auth, request) => {
  if (!isPublicRoute(request)) {
    const { userId } = auth();
    if (!userId) {
      const signInUrl = new URL('/sign-in', request.url);
      signInUrl.searchParams.set('redirect_url', request.url);
      return NextResponse.redirect(signInUrl);
    }
  }
});

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
