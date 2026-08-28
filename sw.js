/* Offline shell. Caches only the app itself, never policy content, because policy
   content never travels over the network in the first place: it is loaded on the
   device and lives in localStorage. Bump CACHE to force an update. */
const CACHE = 'policy-prep-b38';
const SHELL = ['./', 'index.html', 'app.js', 'engine.js', 'supa.js', 'sync.js', 'config.js',
  'content-store.js', 'manifest.webmanifest', 'icon-180.png', 'icon-512.png'];

/* HALF A BUILD IS WORSE THAN AN OLD ONE.
   The host serves these files with max-age=600, and app.js, sync.js and supa.js
   are fetched as separate module requests. Ten minutes is long enough for one
   of them to come back new while another comes back stale, which on 21 Aug 2026
   left a phone reporting build v20 while still running the v19 sync that could
   only see the first thousand questions. Every module is fetched with the HTTP
   cache bypassed so the set can never be mixed. */
const RELOAD = (req) => fetch(req, { cache: 'reload' });

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(SHELL.map((u) => RELOAD(new Request(u, { cache: 'reload' }))
        .then((res) => (res.ok ? c.put(u, res) : null)))))
      .then(() => self.skipWaiting()),
  );
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
  // session on a dead signal still works. The HTTP cache is bypassed for the same
  // reason as install: a stale module served beside a fresh one is a build that
  // was never tested and never shipped.
  e.respondWith(
    RELOAD(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))),
  );
});
