/**
 * sw.js — DentalCAD Service Worker
 * Strategy: Cache-First for static assets, Network-First for Three.js CDN.
 * Version bump the CACHE_NAME to force a full refresh on update.
 */

const CACHE_NAME    = 'dentalcad-v3';
const CDN_CACHE     = 'dentalcad-cdn-v3';
const OFFLINE_PAGE  = './index.html';

// Core app shell — always cached on install
const SHELL_ASSETS = [
  './index.html',
  './css/style.css',
  './js/stl-parser.js',
  './js/project-io.js',
  './js/undo-redo.js',
  './js/logger.js',
  './js/analysis.js',
  './js/manufacturing.js',
  './js/tools.js',
  './js/viewport.js',
  './js/dental-chart.js',
  './js/wizard.js',
  './js/app.js',
  './manifest.json',
];

// CDN assets — cached separately so a version bump doesn't evict them
const CDN_ASSETS = [
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap',
];

// ── Install: pre-cache shell ──────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    Promise.all([
      caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_ASSETS)),
      caches.open(CDN_CACHE).then(cache =>
        Promise.allSettled(CDN_ASSETS.map(url =>
          cache.add(url).catch(() => {/* CDN may be unavailable — non-fatal */})
        ))
      ),
    ]).then(() => self.skipWaiting())
  );
});

// ── Activate: remove old caches ───────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== CDN_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: strategy by URL ────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET, browser-extension, and chrome-extension requests
  if (request.method !== 'GET') return;
  if (!url.protocol.startsWith('http')) return;

  // CDN: Cache-First (these rarely change)
  if (CDN_ASSETS.some(u => request.url.startsWith(u.split('?')[0]))) {
    event.respondWith(_cacheFirst(request, CDN_CACHE));
    return;
  }

  // Google Fonts CSS: Cache-First
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(_cacheFirst(request, CDN_CACHE));
    return;
  }

  // App shell & local assets: Cache-First with network fallback
  if (url.origin === self.location.origin) {
    event.respondWith(_cacheFirstWithFallback(request));
    return;
  }

  // Everything else: Network-First
  event.respondWith(_networkFirst(request));
});

// ── Strategy helpers ──────────────────────────────────────

async function _cacheFirst(request, cacheName = CACHE_NAME) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
  }
}

async function _cacheFirstWithFallback(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Return cached offline page for navigation requests
    if (request.mode === 'navigate') {
      return caches.match(OFFLINE_PAGE);
    }
    return new Response('Offline', { status: 503 });
  }
}

async function _networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('Offline', { status: 503 });
  }
}

// ── Message handler (skipWaiting from UI) ─────────────────
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
