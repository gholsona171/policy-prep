import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

/* A deliberately tiny Supabase client: sign in, refresh, and read/write tables.
   Hand-written rather than pulling in supabase-js so the offline cache stays small and
   the app has no CDN dependency to fail on a bad signal. */

const SESSION_KEY = 'policy-prep-session';

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

/** A short-lived link to a file in a private bucket.

    The PDFs are not public and never should be: they are the product, and they
    are the department's documents. The bucket's rule only lets a signed-in user
    with live access sign a link, and the link dies after an hour. */
export async function signedFileUrl(bucket, file, seconds = 3600) {
  const token = await fresh();
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${bucket}/${file}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: seconds }),
  });
  if (!res.ok) throw new Error('that file is not available on this account');
  const { signedURL } = await res.json();
  return `${SUPABASE_URL}/storage/v1${signedURL}`;
}

/** REST helper. `path` is everything after /rest/v1/, e.g. "questions?select=*". */
export async function db(path, { method = 'GET', body, prefer } = {}) {
  const token = await fresh();
  const headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}
