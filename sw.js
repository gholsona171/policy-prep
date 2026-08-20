/* Offline shell. Caches only the app itself, never policy content, because policy
   content never travels over the network in the first place: it is loaded on the
   device and lives in localStorage. Bump CACHE to force an update. */
const CACHE = 'policy-prep-v2';
const SHELL = ['./', 'index.html', 'app.js', 'engine.js', 'supa.js', 'sync.js', 'config.js',
  'manifest.webmanifest', 'icon-180.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // Never touch Supabase traffic. Serving a cached API response would show stale scores
  // as if they were current, which is worse than an honest offline failure.
  if (new URL(e.request.url).origin !== self.location.origin) return;
  // Network first so a deployed fix reaches the phone, cache as the fallback so a
  // session on a dead signal still works.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))),
  );
});
