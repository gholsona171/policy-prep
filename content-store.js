/* Policy content lives here, not in localStorage.

   WHY THIS FILE EXISTS.
   The whole store used to be one localStorage key. That worked while the app held
   five demo policies. On 21 Aug 2026 the eighty real policies finished their question
   banks and the serialised store reached 7.21 MB: 1.46 MB of policy text, 1.67 MB of
   items and 4.08 MB of questions. iOS gives an origin about 5 MB of localStorage and
   enforces it by throwing, so every save after that moment threw QuotaExceededError.

   Two things then went wrong at once, which is why the app looked haunted:

     - nothing was ever written again, so the phone kept re-reading the last snapshot
       that fit, which was the reading-only import from before the banks existed. That
       is why all eighty policies said "its questions are still being written" while
       the banks sat complete on the server.
     - the throw happened in sync() between the pull and the re-render, so the fresh,
       correct, fully populated store sat in memory and was never painted. Any later
       render from another screen used it and looked right, which is why backing out
       of a policy fixed the display until the next cold start threw it away.

   IndexedDB has no 5 MB cliff: it is measured against the device's storage budget,
   which is hundreds of megabytes. Content is a read-only mirror of the server, so
   losing it is never data loss; the next sync refills it. Progress stays in
   localStorage, where it is small, synchronous and written on every single answer. */

const DB_NAME = 'policy-prep';
const DB_VERSION = 1;
const STORE = 'content';
const RECORD = 'current';

function open() {
  return new Promise((resolve, reject) => {
    // A phone in private mode, or one that has blocked storage, has no IndexedDB.
    // That is survivable: the app still runs from the server on every launch.
    if (!('indexedDB' in window)) { reject(new Error('this browser has no IndexedDB')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('could not open IndexedDB'));
    req.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result ?? null);
    t.onerror = () => reject(t.error || new Error('IndexedDB write failed'));
    t.onabort = () => reject(t.error || new Error('IndexedDB transaction aborted'));
  });
}

/** The heavy half of the store: policy text, items and question banks. */
export async function readContent() {
  const db = await open();
  try { return await tx(db, 'readonly', (s) => s.get(RECORD)); }
  finally { db.close(); }
}

export async function writeContent(content) {
  const db = await open();
  try { return await tx(db, 'readwrite', (s) => s.put(content, RECORD)); }
  finally { db.close(); }
}

export async function clearContent() {
  const db = await open();
  try { return await tx(db, 'readwrite', (s) => s.delete(RECORD)); }
  finally { db.close(); }
}

/* Splitting and rejoining are here, beside the storage they exist for, so the two
   can never drift apart. `text` is pulled off the policy list because 1.46 MB of
   reading material is content, not progress, however convenient it was to carry it
   on the same object. */

export function heavyOf(store) {
  const texts = {};
  for (const p of store.index.policies) if (p.text) texts[p.id] = p.text;
  return { items: store.items, banks: store.banks, practice: store.practice ?? {}, texts };
}

export function lightOf(store) {
  return {
    index: {
      policies: store.index.policies.map((p) => ({
        id: p.id, title: p.title, version: p.version, passed: p.passed,
        passedAt: p.passedAt, passedPct: p.passedPct, passedMark: p.passedMark,
        source: p.source,
      })),
    },
    progress: store.progress,
    open: store.open,
    settings: store.settings,
    contentRev: store.contentRev,
  };
}

/** Puts the heavy half back onto a store loaded from localStorage. */
export function rejoin(store, heavy) {
  if (!heavy) return store;
  store.items = heavy.items ?? {};
  store.banks = heavy.banks ?? {};
  store.practice = heavy.practice ?? {};
  const texts = heavy.texts ?? {};
  store.index.policies.forEach((p) => { p.text = texts[p.id] ?? null; });
  return store;
}
