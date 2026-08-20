import { buildSession, coverage, gate, SESSION_SIZE } from './engine.js';
import { signIn, signUp, signOut, signedIn, currentEmail } from './supa.js';
import { syncAll } from './sync.js';

/* The local copy is the working copy: every answer is recorded here first, so a session
   in a basement with no signal behaves exactly like one on wifi. Sync then reconciles
   with the server, which is the truth once it has been reached. */

const KEY = 'policy-prep-v1';
const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove('hide');
const hide = (id) => $(id).classList.add('hide');
const screens = ['auth', 'home', 'quiz', 'result'];
const go = (name) => { screens.forEach(hide); show(name); window.scrollTo(0, 0); };

const blank = () => ({
  index: { policies: [] }, items: {}, banks: {},
  progress: { answers: [], sessions: [] },
});

let store = load();
let S = null;

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...blank(), ...JSON.parse(raw) } : blank();
  } catch { return blank(); }
}
const save = () => localStorage.setItem(KEY, JSON.stringify(store));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ------------------------------------------------------------------ sync */

async function sync(quiet) {
  if (!signedIn()) return;
  if (!quiet) $('syncmsg').textContent = 'Checking...';
  try {
    await syncAll(store);
    save();
    renderHome();
    $('syncmsg').textContent = `Up to date. ${store.index.policies.length} policy(ies).`;
  } catch (e) {
    // Offline is normal, not an error worth alarming about: everything still works.
    $('syncmsg').textContent = navigator.onLine
      ? `Sync problem: ${e.message}` : 'Offline. Your answers are saved and will sync later.';
  }
}

/* ------------------------------------------------------------------ home */

function renderHome() {
  const list = store.index.policies;
  $('whoami').textContent = currentEmail() ? `Signed in as ${currentEmail()}` : '';
  $('homesub').textContent = list.length
    ? 'One policy at a time. 90 percent and no repeat misses to move on.'
    : 'No policies published yet.';

  $('policies').innerHTML = list.length ? list.map((p) => {
    const c = coverage(store.items[p.id], store.banks[p.id]);
    const g = gate(p.id, store.items[p.id], store.progress);
    const leech = g.leeches.length
      ? `<ul>${g.leeches.map((l) => `<li>${esc(l.label)} (missed ${l.wrong}x)</li>`).join('')}</ul>` : '';
    return `<div class="card">
      <div class="row" style="justify-content:space-between">
        <b>${esc(p.title)}</b>
        <span class="pill ${p.passed ? 'ok' : 'warn'}">${p.passed ? 'passed' : 'in focus'}</span>
      </div>
      <div class="row" style="margin-top:9px">
        <span class="pill ${c.complete ? 'ok' : 'warn'}">coverage ${c.covered}/${c.total}</span>
        <span class="pill">${store.banks[p.id]?.questions?.length ?? 0} questions</span>
        <span class="pill">${g.bestPct === null ? 'no score yet' : 'best ' + g.bestPct + '%'}</span>
      </div>
      <div class="meta" style="margin-top:9px">${esc(g.reason)}</div>${leech}
    </div>`;
  }).join('') : `<div class="card"><b>Nothing to study yet.</b>
      <div class="meta" style="margin-top:6px">New policies appear here on their own.</div></div>`;

  $('start').disabled = !list.length;
}

/* ------------------------------------------------------------------ quiz */

function start() {
  const built = buildSession(store, Date.now(), SESSION_SIZE);
  if (!built.questions.length) return alert('No questions available.');
  S = { ...built, i: 0, right: 0, answered: 0 };
  go('quiz');
  renderQ();
}

function renderQ() {
  const q = S.questions[S.i];
  $('counter').textContent = `Question ${S.i + 1} of ${S.questions.length}`;
  $('running').textContent = `${S.right} correct`;
  $('prog').style.width = `${(S.i / S.questions.length) * 100}%`;
  $('stem').textContent = q.stem;
  $('feedback').className = 'feedback hide';
  hide('next');
  $('choices').innerHTML = q.choices.map((c, n) =>
    `<button class="choice" data-n="${n}">${String.fromCharCode(65 + n)}. ${esc(c)}</button>`).join('');
  [...$('choices').children].forEach((b) => { b.onclick = () => pick(Number(b.dataset.n)); });
}

function pick(n) {
  const q = S.questions[S.i];
  const btns = [...$('choices').children];
  if (btns[0].disabled) return;
  btns.forEach((b) => { b.disabled = true; });

  const correct = n === q.answer;
  if (correct) S.right++;
  S.answered++;
  btns[n].classList.add(correct ? 'right' : 'wrong');
  if (!correct) btns[q.answer].classList.add('right');

  store.progress.answers.push({
    at: Date.now(), policyId: q.policyId, itemId: q.itemId,
    questionId: q.id, choice: n, correct, synced: false,
  });
  save();

  const fb = $('feedback');
  fb.className = 'feedback';
  fb.innerHTML = `<b>${correct ? 'Correct.' : 'Not this time.'}</b> ${esc(q.why || '')}`
    + (q.cite ? `<div class="cite">"${esc(q.cite)}"</div>` : '');
  $('running').textContent = `${S.right} correct`;
  show('next');
}

function finish() {
  const pct = S.answered ? Math.round((S.right / S.answered) * 100) : 0;
  store.progress.sessions.push({
    id: `s${Date.now()}-${Math.floor(performance.now())}`, at: Date.now(),
    currentId: S.currentId, currentCount: S.currentCount,
    asked: S.answered, right: S.right, pct, synced: false,
  });

  const g = gate(S.currentId, store.items[S.currentId], store.progress);
  if (g.passed) {
    const p = store.index.policies.find((x) => x.id === S.currentId);
    if (p && !p.passed) { p.passed = true; p.passedAt = Date.now(); }
  }
  save();

  $('score').textContent = `${pct}%`;
  $('scoreline').textContent = `${S.right} of ${S.answered} correct`;
  $('gatebox').innerHTML = g.passed
    ? '<span class="pill ok">policy passed, next one unlocked</span>'
    : `<span class="pill warn">not yet</span>
       <div class="meta" style="margin-top:8px">${esc(g.reason)}</div>`
      + (g.leeches.length
        ? `<ul>${g.leeches.map((l) => `<li>${esc(l.label)} (missed ${l.wrong}x)</li>`).join('')}</ul>` : '');
  go('result');
  sync(true);   // push the session quietly; failure here costs nothing
}

/* ------------------------------------------------------------------ auth */

async function doAuth(fn, label) {
  const email = $('email').value.trim();
  const password = $('password').value;
  if (!email || !password) return ($('authmsg').textContent = 'Email and password, please.');
  $('authmsg').textContent = `${label}...`;
  try {
    const d = await fn(email, password);
    if (!d.access_token) {
      $('authmsg').textContent = 'Account created. Check your email to confirm, then sign in.';
      return;
    }
    await afterSignIn();
  } catch (e) { $('authmsg').textContent = e.message; }
}

async function afterSignIn() {
  renderHome();
  go('home');
  await sync(false);
}

/* ---------------------------------------------------------------- wiring */

$('signin').onclick = () => doAuth(signIn, 'Signing in');
$('signup').onclick = () => doAuth(signUp, 'Creating account');
$('signout').onclick = () => {
  signOut();
  localStorage.removeItem(KEY);   // a shared phone must not leave one user's history behind
  store = blank();
  go('auth');
};
$('resync').onclick = () => sync(false);
$('start').onclick = start;
$('again').onclick = start;
$('next').onclick = () => { S.i++; S.i >= S.questions.length ? finish() : renderQ(); };
$('quit').onclick = () => (S.answered ? finish() : go('home'));
$('home2').onclick = () => { renderHome(); go('home'); };

if (signedIn()) { renderHome(); go('home'); sync(true); } else { go('auth'); }
window.addEventListener('online', () => sync(true));

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
