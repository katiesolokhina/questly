// Questly service worker.
// - Pages (your habits, check-ins) are NEVER cached: always fetched live, so you never
//   see a stale "not done yet" for a dose you already logged. If offline, show offline.html.
// - CSS/JS/icons: network first (always fresh after a deploy), cache only as an offline backup.
// - POSTs (check-in, undo, saves) pass straight through. Nothing is queued offline, so a
//   dose can't be logged twice or silently lost.

const CACHE = 'questly-v2';
const PRECACHE = [
  '/offline.html',
  '/css/app.css',
  '/icons/icon-192.png',
  '/icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Google Fonts etc.: let the browser handle it

  // Pages: live only, offline page as fallback.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
    return;
  }

  // Static assets: network first, cached copy if offline.
  if (/^\/(css|js|icons)\//.test(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
  }
});
