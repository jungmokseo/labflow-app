/**
 * Research Flow Service Worker v5
 *
 * Caching strategy:
 * - /_next/static/*, /icons/*, /manifest.json → cache-first (immutable assets)
 * - Whitelisted GET /api/* → stale-while-revalidate (오프라인 읽기)
 * - Navigation requests → network-first, /offline fallback (페이지 캐싱 금지 유지)
 * - Non-GET /api/*, auth, sign-* → bypass (앱 레벨 offline queue가 처리)
 * - /_next/data/*, SSE, 기타 → bypass
 *
 * 주의 (CLAUDE.md 제약):
 * - 페이지 HTML은 절대 캐시하지 않는다 (구버전 UI 방지).
 * - CACHE_NAME은 이전 버전(v4)보다 반드시 높은 번호 사용.
 *
 * v5 변경:
 * - /api/captures를 stale-while-revalidate에서 제거. cross-device로 Chrome에서
 *   task 삭제 후 모바일에서 stale 데이터 보이는 문제(첫 fetch가 cache hit으로
 *   지운 항목 표시) 해결. captures는 자주 변하므로 항상 network-first로 fresh
 *   data 받는다.
 */
const VERSION = 'researchflow-v5';
const STATIC_CACHE = `${VERSION}-static`;
const API_CACHE = `${VERSION}-api`;
const OFFLINE_URL = '/offline';

const PRECACHE_URLS = [OFFLINE_URL, '/manifest.json'];

// stale-while-revalidate로 캐시할 GET API 경로 (prefix match).
// 정적·반정적 데이터용. cross-device 즉시 반영이 필요 없는 것만 여기 둘 것.
const CACHEABLE_API_PREFIXES = [
  '/api/briefing',
  '/api/meetings',
  '/api/papers/alerts',
  '/api/lab',
  '/api/brain/channels',
  '/api/brain/settings-summary',
  '/api/calendar/today',
  '/api/calendar/week',
  '/api/calendar/pending',
  '/api/email/profile',
  '/api/email/briefing',
  '/api/wiki',
  '/api/graph',
];

// network-first로 처리할 GET API 경로 (prefix match).
// 자주 mutation되어 cross-device 즉시 반영이 필요하지만, 오프라인에서도 마지막 본 데이터는
// 보여주고 싶은 경우에 사용. fresh fetch 우선, 실패 시 cache fallback.
const NETWORK_FIRST_API_PREFIXES = [
  '/api/captures',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) =>
      cache.addAll(PRECACHE_URLS).catch((err) => {
        console.warn('[sw] precache failed:', err);
      })
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Cross-origin 무시
  if (url.origin !== self.location.origin) return;

  // Auth/OAuth callback은 절대 건드리지 않음
  if (url.pathname.includes('auth') || url.pathname.includes('sign-')) return;

  // _next/data/*, _next/image/* → bypass (RSC/이미지 처리)
  if (url.pathname.startsWith('/_next/data/') || url.pathname.startsWith('/_next/image')) return;

  // _next/static/* — cache-first (hash 파일명이라 immutable)
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }

  // 아이콘 / manifest / 공용 정적 자산
  if (
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.json' ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.woff') ||
    url.pathname.endsWith('.woff2')
  ) {
    event.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }

  // GET /api/* — network-first 또는 stale-while-revalidate
  if (url.pathname.startsWith('/api/') && req.method === 'GET') {
    const networkFirstable = NETWORK_FIRST_API_PREFIXES.some((p) => url.pathname.startsWith(p));
    if (networkFirstable) {
      event.respondWith(networkFirst(req, API_CACHE));
      return;
    }
    const cacheable = CACHEABLE_API_PREFIXES.some((p) => url.pathname.startsWith(p));
    if (cacheable) {
      event.respondWith(staleWhileRevalidate(req, API_CACHE));
      return;
    }
    return;
  }

  // non-GET /api/* → bypass (offline-queue.ts가 처리)
  if (url.pathname.startsWith('/api/')) return;

  // Navigation → network-first + /offline fallback (페이지 캐싱 금지 유지)
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() =>
        caches.match(OFFLINE_URL).then(
          (cached) =>
            cached ||
            new Response(
              '<html><body><h1>오프라인</h1><p>네트워크 연결을 확인해주세요.</p></body></html>',
              { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
            )
        )
      )
    );
    return;
  }

  // 기타 — 브라우저 기본 처리
});

function cacheFirst(req, cacheName) {
  return caches.match(req).then((cached) => {
    if (cached) return cached;
    return fetch(req).then((res) => {
      if (res && res.ok) {
        const clone = res.clone();
        caches.open(cacheName).then((cache) => cache.put(req, clone)).catch(() => {});
      }
      return res;
    });
  });
}

function staleWhileRevalidate(req, cacheName) {
  return caches.open(cacheName).then((cache) =>
    cache.match(req).then((cached) => {
      const fetchPromise = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
          return res;
        })
        .catch(() => {
          if (cached) return cached;
          return new Response(
            JSON.stringify({ error: 'offline', offline: true }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
          );
        });
      return cached || fetchPromise;
    })
  );
}

// network-first: 항상 fresh fetch 우선, 네트워크 실패 시 cache fallback.
// 자주 변하는 데이터(captures 등)에 사용 — cross-device stale 방지하면서 오프라인 지원도 유지.
function networkFirst(req, cacheName) {
  return caches.open(cacheName).then(async (cache) => {
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) cache.put(req, fresh.clone()).catch(() => {});
      return fresh;
    } catch {
      const cached = await cache.match(req);
      if (cached) return cached;
      return new Response(
        JSON.stringify({ error: 'offline', offline: true }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }
  });
}
