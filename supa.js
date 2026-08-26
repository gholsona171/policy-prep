import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

/* A deliberately tiny Supabase client: sign in, refresh, and read/write tables.
   Hand-written rather than pulling in supabase-js so the offline cache stays small and
   the app has no CDN dependency to fail on a bad signal. */

const SESSION_KEY = 'policy-prep-session';
const DEVICE_KEY = 'policy-prep-device';

/* This phone's identity, minted once on first run. The server compares it to
   the registered slot on every content read: an account is locked to the first
   device that signed in, and only the master can release it. The id proves
   nothing by itself - it is the comparison server-side that carries the weight,
   which is why a copied id in a different browser profile still needs the slot. */
export function deviceId() {
  let id = null;
  try { id = localStorage.getItem(DEVICE_KEY); } catch { /* fall through */ }
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);
    try { localStorage.setItem(DEVICE_KEY, id); } catch { /* memory-only session */ }
  }
  return id;
}

/** A short human name for this device, shown to the master when a customer
    calls about a locked slot. Best effort; "a phone" is an honest fallback. */
export function deviceLabel() {
  const ua = navigator.userAgent || '';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows browser';
  if (/Macintosh/.test(ua)) return 'Mac browser';
  return 'a device';
}

export function session() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null; } catch { return null; }
}
function setSession(s) {
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else localStorage.removeItem(SESSION_KEY);
}
export function signedIn() { return !!session()?.access_token; }
export function currentUserId() { return session()?.user?.id ?? null; }
export function currentEmail() { return session()?.user?.email ?? null; }

async function authCall(path, body) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.msg || data.message || `sign-in failed (${res.status})`);
  return data;
}

export async function signIn(email, password) {
  const d = await authCall('token?grant_type=password', { email, password });
  setSession({ ...d, expires_at: Date.now() + (d.expires_in ?? 3600) * 1000 });
  return d;
}

export async function signUp(email, password) {
  const d = await authCall('signup', { email, password });
  // With email confirmation on, signup returns no tokens: the account exists but is not
  // usable until confirmed. Say so rather than silently appearing to work.
  if (d.access_token) setSession({ ...d, expires_at: Date.now() + (d.expires_in ?? 3600) * 1000 });
  return d;
}

export function signOut() { setSession(null); }

/** Changes the signed-in account's own password. Nobody else's: the token is
    the account, so this cannot be aimed at another user. */
export async function changePassword(newPassword) {
  const token = await fresh();
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    method: 'PUT',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ password: newPassword }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.msg || data.error_description || data.message || 'that password was refused');
  return true;
}

/** Keeps the token alive so the app does not log itself out mid-week. */
async function fresh() {
  const s = session();
  if (!s) throw new Error('not signed in');
  if (s.expires_at && Date.now() < s.expires_at - 60000) return s.access_token;
  const d = await authCall('token?grant_type=refresh_token', { refresh_token: s.refresh_token });
  setSession({ ...s, ...d, expires_at: Date.now() + (d.expires_in ?? 3600) * 1000 });
  return d.access_token;
}

/** Calls a database function. The master tools live behind these rather than in the
    app, because the app runs on a phone and anything it holds is readable. */
export async function rpc(name, args = {}) {
  const token = await fresh();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-device-id': deviceId(),
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not json */ }
  // Postgres raises are the useful message; show that, not "400".
  if (!res.ok) throw new Error(data?.message || data?.hint || text || `${name} failed`);
  return data;
}

/** The original PDF, fetched fresh every time.

    This used to mint a signed storage link. That was wrong: a signed link is a
    stateless signature, the caller chose its lifetime, and Storage never asks
    the database again when the link is used. An audit minted ten year links to
    every document, cancelled the account, and the links still worked. Now the
    file comes back through a database function that checks live access on every
    single request, so cancelling somebody closes the documents in the same
    instant. Nothing durable is handed out. */
export async function policyPdfUrl(policyId) {
  const base64 = await rpc('get_policy_pdf', { p_policy_id: policyId });
  if (typeof base64 !== 'string' || !base64) throw new Error('that policy has no PDF on file');
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
}

/** REST helper. `path` is everything after /rest/v1/, e.g. "questions?select=*". */
export async function db(path, { method = 'GET', body, prefer, range } = {}) {
  const token = await fresh();
  const headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'x-device-id': deviceId(),
  };
  if (prefer) headers.Prefer = prefer;
  if (range) headers.Range = range;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

/* THE API HANDS BACK 1000 ROWS AND SAYS NOTHING ABOUT THE REST.
   Measured on 21 Aug 2026: 6603 questions in the database, exactly 1000 returned
   for an unbounded select, no error and no warning. Everything past that cut
   arrived with no questions attached, so roughly seven policies in eight showed
   on the phone as "reading only" while their banks sat complete on the server.

   A single request can therefore never be trusted for a table that grows. This
   walks the pages until a short one comes back, which is the only honest end of
   a list. PAGE stays under the server's cap on purpose: asking for more than it
   will give just gets silently trimmed again. */
const PAGE = 1000;
export async function dbAll(path, { pageSize = PAGE, maxPages = 500 } = {}) {
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const from = page * pageSize;
    const rows = await db(path, { range: `${from}-${from + pageSize - 1}` });
    if (!Array.isArray(rows)) return page === 0 ? rows : out;
    out.push(...rows);
    if (rows.length < pageSize) return out;
  }
  // Hitting this means half a million rows in one table. Better a loud throw
  // than quietly handing back a truncated list, which is the bug this fixes.
  throw new Error(`${path}: more than ${maxPages * pageSize} rows, refusing to guess`);
}
