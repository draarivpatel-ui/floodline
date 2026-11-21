const SCOPE = new URL(self.registration.scope);
const PREFIX = `floodline-shell:${SCOPE.pathname}:`;
const VERSION = `${PREFIX}v2`;
const SHELL = [
  'index.html',
  'styles.css',
  'sw.js',
  'favicon.svg',
  'src/app.js',
  'src/viz.js',
  'src/exports.js',
  'src/card.js',
  'src/controls.js',
  'src/hydrology.js',
  'src/routing.js',
  'src/presets.js',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(SHELL.map(name => new URL(name, SCOPE).href));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(PREFIX) && key !== VERSION) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

// One version serves both the document and its modules atomically; nothing else is intercepted.
self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(SCOPE.pathname)) return;
  const rel = url.pathname.slice(SCOPE.pathname.length);
  const asset = request.mode === 'navigate'
    ? (rel === '' || rel === 'index.html' ? 'index.html' : null)
    : (SHELL.includes(rel) ? rel : null);
  if (!asset) return;
  const key = new URL(asset, SCOPE).href;
  event.respondWith(
    caches.open(VERSION)
      .then(cache => cache.match(key))
      .then(hit => hit ?? fetch(request)),
  );
});
