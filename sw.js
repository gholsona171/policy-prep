/* Offline shell: caches the app itself. Policy text and questions live in
   IndexedDB (content-store.js); downloaded narration lives in AUDIO_CACHE and is
   streamed from here (see listen below). Bump CACHE to force an update. */
const CACHE = 'policy-prep-b48';
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

/* Only old copies of the app shell are cleared. This used to delete every
   cache but its own, which threw away every downloaded narration on every
   single deploy and made each listen after an update a fresh download. */
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => k.startsWith('policy-prep-b') && k !== CACHE)
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/* Narration, streamed from the device. The app downloads a policy's audio
   (with the customer's own token) into AUDIO_CACHE under its listen/ address;
   the player then asks for that address and is answered here in byte ranges,
   like any audio on the web. Apple's player needs ranges: given the whole file
   as a blob, an iPad sat at "playing" with its clock frozen at 0:00. */
const AUDIO_CACHE = 'policy-prep-audio-v2';
let held = { url: null, buf: null };   // the file being played, kept between range requests

async function listen(req) {
  if (held.url !== req.url) {
    const hit = await (await caches.open(AUDIO_CACHE)).match(req.url);
    if (!hit) return new Response('', { status: 404 });
    held = { url: req.url, buf: await hit.arrayBuffer() };
  }
  const { buf } = held;
  const size = buf.byteLength;
  const base = { 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') || '');
  if (!m) return new Response(buf, { status: 200, headers: { ...base, 'Content-Length': String(size) } });
  let start;
  let end;
  if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; }   // last N bytes
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (start >= size || start > end) {
    return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
  });
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin === self.location.origin && url.pathname.includes('/listen/')) {
    e.respondWith(listen(e.request));
    return;
  }
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
