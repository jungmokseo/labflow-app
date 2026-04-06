const CACHE_NAME = 'researchflow-v3';

// Install — skip waiting for immediate activation
self.addEventListener('install', () => {
  self.skipWaiting();
});

// Activate — clean ALL old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — network-only for everything (Next.js handles its own caching)
// Only use cache as offline fallback for navigation requests
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API calls, auth, _next assets — always network, no interception
  if (url.pathname.startsWith('/api') || url.pathname.includes('auth') ||
      url.pathname.startsWith('/_next') || url.pathname.includes('sign-')) {
    return;
  }

  // Navigation requests only — network-first with offline fallback
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response('<html><body><h1>오프라인</h1><p>네트워크 연결을 확인해주세요.</p></body></html>',
          { headers: { 'Content-Type': 'text/html' } })
      )
    );
    return;
  }

  // All other requests — don't intercept (let browser handle normally)
});
