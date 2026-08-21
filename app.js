import {
  buildSession, coverage, gate, policyStats, itemStats, SESSION_SIZE,
} from './engine.js';
import { signIn, signUp, signOut, signedIn, currentEmail, rpc, signedFileUrl } from './supa.js';
import { syncAll } from './sync.js';

/* The local copy is the working copy: every answer is recorded here first, so a session
   in a basement with no signal behaves exactly like one on wifi. Sync then reconciles
   with the server, which is the truth once it has been reached. */

const KEY = 'policy-prep-v1';
const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove('hide');
const hide = (id) => $(id).classList.add('hide');
const screens = ['auth', 'home', 'quiz', 'result', 'stats', 'read'];
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

/** A three-colour bar: mastered, seen but not solid, never asked. */
function masteryBar(st) {
  if (!st.itemsTotal) return '';
  const pct = (n) => `${(n / st.itemsTotal) * 100}%`;
  const shaky = st.itemsSeen - st.itemsMastered;
  return `<div class="track">
    <i class="seg-ok" style="width:${pct(st.itemsMastered)}"></i>
    <i class="seg-part" style="width:${pct(shaky)}"></i>
    <i class="seg-none" style="width:${pct(st.itemsTotal - st.itemsSeen)}"></i>
  </div>
  <div class="mini" style="margin-top:6px">
    ${st.itemsMastered} solid &middot; ${shaky} shaky &middot; ${st.itemsTotal - st.itemsSeen} untouched
  </div>`;
}

function renderHome() {
  const list = store.index.policies;
  $('whoami').textContent = currentEmail() ? `Signed in as ${currentEmail()}` : '';
  $('homesub').textContent = list.length
    ? 'One policy at a time. 90 percent and no repeat misses to move on.'
    : 'No policies published yet.';

  // Overall band across every policy, so the top of the screen answers "how am I doing"
  // before any per-policy detail.
  const allAnswers = store.progress.answers;
  const allRight = allAnswers.filter((a) => a.correct).length;
  const passed = list.filter((p) => p.passed).length;
  $('overall').innerHTML = list.length ? `<div class="card">
    <div class="grid3">
      <div><div class="num">${passed}/${list.length}</div><div class="mini">passed</div></div>
      <div><div class="num">${allAnswers.length ? Math.round((allRight / allAnswers.length) * 100) : '--'}%</div>
           <div class="mini">accuracy</div></div>
      <div><div class="num">${store.progress.sessions.length}</div><div class="mini">sessions</div></div>
    </div></div>` : '';

  // The policy in focus is simply the first one not yet passed. Everything after it is
  // locked, and the card says so rather than silently offering no way in.
  const focusId = list.find((p) => !p.passed)?.id ?? null;

  $('policies').innerHTML = list.length ? list.map((p) => {
    const bank = store.banks[p.id];
    const c = coverage(store.items[p.id], bank);
    const g = gate(p.id, store.items[p.id], store.progress, bank);
    const st = policyStats(p.id, store.items[p.id], bank, store.progress);
    const state = p.passed ? 'passed' : p.id === focusId ? 'in focus' : 'locked';
    const status = p.passed ? 'Cleared. Still appears in review.'
      : p.id === focusId ? g.reason
      : 'Locked until the policy above is passed.';
    const leech = g.leeches.length
      ? `<div class="keylist">${g.leeches.slice(0, 4).map((l) =>
          `<div><span>${esc(l.label)}</span><span class="bad">missed ${l.wrong}x</span></div>`).join('')}
         ${g.leeches.length > 4 ? `<div><span>and ${g.leeches.length - 4} more</span><span></span></div>` : ''}
        </div>` : '';
    return `<div class="card">
      <div class="row" style="justify-content:space-between">
        <b${state === 'locked' ? ' style="color:#6b7480"' : ''}>${esc(p.title)}</b>
        <span class="pill ${state === 'passed' ? 'ok' : state === 'in focus' ? 'warn' : ''}">${state}</span>
      </div>
      ${state === 'locked' ? '' : masteryBar(st)}
      <div class="row" style="margin-top:10px">
        <span class="pill ${c.complete ? 'ok' : 'warn'}">coverage ${c.covered}/${c.total}</span>
        <span class="pill">${bank?.questions?.length ?? 0} questions</span>
        ${state === 'locked' ? '' : `
        <span class="pill">${g.bestPct === null ? 'no score yet' : 'best ' + g.bestPct + '%'}</span>
        <span class="pill">${st.accuracy === null ? 'unstudied' : st.accuracy + '% overall'}</span>`}
      </div>
      <div class="meta" style="margin-top:9px">${esc(status)}</div>${leech}
      ${state === 'locked' ? '' : `<div class="twoup">
        <button class="ghost" data-read="${esc(p.id)}"${p.text ? '' : ' disabled'}>Read the policy</button>
        <button data-test="${esc(p.id)}">${p.passed ? 'Revise this one' : 'Test this section'}</button>
      </div>`}
    </div>`;
  }).join('') : `<div class="card"><b>Nothing to study yet.</b>
      <div class="meta" style="margin-top:6px">New policies appear here on their own.</div></div>`;

  // Read sits beside test on purpose: the card itself says read this, then test on this.
  document.querySelectorAll('[data-read]').forEach((b) => {
    b.onclick = () => openReading(b.dataset.read);
  });
  document.querySelectorAll('[data-test]').forEach((b) => {
    b.onclick = () => startSection(b.dataset.test);
  });

  $('start').disabled = !list.length;
}

/* --------------------------------------------------------------- reading */

let reading = null;

/** The policy on its own screen, in the department's own words. */
function openReading(id) {
  const p = store.index.policies.find((x) => x.id === id);
  if (!p || !p.text) return;
  reading = id;
  $('readtitle').textContent = p.title;
  $('readsource').textContent = p.source || '';
  $('readbody').textContent = p.text;
  $('readtest').textContent = p.passed ? 'Revise this one' : 'Take the test on this';
  $('pdfmsg').textContent = '';
  go('read');
}

/** The department's own document, laid out the way they laid it out. The link
    is signed on the spot rather than stored, so it cannot be shared around
    after the fact, and it needs a live connection: the text above works
    offline, the PDF does not. */
async function openPdf() {
  if (!reading) return;
  const btn = $('readpdf');
  btn.disabled = true;
  $('pdfmsg').textContent = 'Fetching...';
  try {
    const url = await signedFileUrl('policy-pdfs', `${reading}.pdf`);
    $('pdfmsg').textContent = '';
    window.open(url, '_blank');
  } catch (e) {
    $('pdfmsg').textContent = navigator.onLine
      ? e.message
      : 'The PDF needs a connection. The text above works offline.';
  }
  btn.disabled = false;
}

/** Starting a section from its own card. The policy in focus keeps the normal
    mix (mostly current, some review); a policy already passed is a straight
    drill on that one. */
function startSection(id) {
  const focusId = store.index.policies.find((p) => !p.passed)?.id ?? null;
  start(id === focusId ? null : id);
}

/* ----------------------------------------------------------------- stats */

function renderStats() {
  const list = store.index.policies;
  if (!list.length) { $('statsbody').innerHTML = '<div class="card">Nothing to report yet.</div>'; return; }

  $('statsbody').innerHTML = list.map((p) => {
    const items = store.items[p.id];
    const st = policyStats(p.id, items, store.banks[p.id], store.progress);
    const sessions = store.progress.sessions.filter((s) => s.currentId === p.id);
    const recent = sessions.slice(-5).map((s) => `${s.pct}%`).join(', ') || 'none yet';

    // Weakest first: an item you have got wrong most, and have not since fixed.
    const weak = (items?.items ?? [])
      .map((i) => ({ i, s: itemStats(store.progress, i.id) }))
      .filter((r) => r.s.wrong > 0)
      .sort((a, b) => b.s.wrong - a.s.wrong || Number(a.s.resolved) - Number(b.s.resolved))
      .slice(0, 6);

    return `<div class="card">
      <b>${esc(p.title)}</b>
      ${masteryBar(st)}
      <div class="grid3" style="margin-top:12px">
        <div><div class="num">${st.accuracy === null ? '--' : st.accuracy + '%'}</div><div class="mini">accuracy</div></div>
        <div><div class="num">${st.answered}</div><div class="mini">answered</div></div>
        <div><div class="num">${st.sessions}</div><div class="mini">sessions</div></div>
      </div>
      <div class="meta" style="margin-top:12px">Recent scores: ${recent}</div>
      ${weak.length ? `<div class="mini" style="margin-top:12px">Weakest items</div>
        <div class="keylist">${weak.map((w) =>
          `<div><span>${esc(w.i.label)}</span>
           <span class="${w.s.resolved ? 'good' : 'bad'}">${w.s.wrong} wrong${w.s.resolved ? ', now right' : ', still wrong'}</span></div>`).join('')}
        </div>` : '<div class="meta" style="margin-top:12px">No misses recorded.</div>'}
    </div>`;
  }).join('');
}

/* ------------------------------------------------------------------ quiz */

function start(focusId = null) {
  const built = buildSession(store, Date.now(), SESSION_SIZE, focusId);
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

  const g = gate(S.currentId, store.items[S.currentId], store.progress, store.banks[S.currentId]);
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

/* ---------------------------------------------------------------- master */

/* Selling access from the phone. Everything here is a call to a database function
   that checks for itself whether the caller is a master, so hiding the card is a
   courtesy to everyone else, not the security. */

let isMaster = false;

/** Said out loud down a phone line, so no l/1 and no O/0 to argue about. */
function rollPassword() {
  const letters = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let out = '';
  for (let i = 0; i < 10; i++) {
    const pool = i === 4 || i === 9 ? digits : letters;
    out += pool[bytes[i] % pool.length];
  }
  return out[0].toUpperCase() + out.slice(1);
}

async function checkMaster() {
  try { isMaster = await rpc('is_master') === true; } catch { isMaster = false; }
  $('master').classList.toggle('hide', !isMaster);
}

function masterForm(open) {
  $('mform').classList.toggle('hide', !open);
  $('mnew').classList.toggle('hide', open);
  $('mlistbtn').classList.toggle('hide', open);
  if (open) {
    $('memail').value = '';
    $('mnote').value = '';
    $('mdays').value = '';
    $('mpass').value = rollPassword();
    $('handout').classList.add('hide');
    $('mastermsg').textContent = 'Their account is made the moment you tap create.';
    $('memail').focus();
  }
}

async function createCustomer() {
  const email = $('memail').value.trim().toLowerCase();
  const password = $('mpass').value.trim();
  const days = $('mdays').value ? Number($('mdays').value) : null;
  const note = $('mnote').value.trim();
  if (!email || password.length < 8) {
    $('mastermsg').textContent = 'Email, and a password of at least 8 characters.';
    return;
  }
  $('mcreate').disabled = true;
  $('mastermsg').textContent = 'Creating...';
  try {
    const r = await rpc('master_add_customer', {
      p_email: email, p_password: password, p_days: days, p_note: note || null,
    });
    masterForm(false);
    // The one thing they need is on screen in a block they can read out or copy.
    $('handout').innerHTML = `<b>${r.created ? 'Account created' : 'Existing account, password reset'}</b>
      ${esc(r.email)}<br>${esc(r.password)}<br>
      <span class="meta">${r.expires_at ? 'expires ' + String(r.expires_at).slice(0, 10) : 'does not expire'}</span>`;
    $('handout').classList.remove('hide');
    $('mastermsg').textContent = 'Read those two lines to them. Tap them to copy.';
    $('handout').onclick = () => {
      navigator.clipboard?.writeText(`${r.email}\n${r.password}`)
        .then(() => { $('mastermsg').textContent = 'Copied.'; })
        .catch(() => {});
    };
    await loadCustomers();
  } catch (e) {
    $('mastermsg').textContent = e.message;
  }
  $('mcreate').disabled = false;
}

async function loadCustomers() {
  try {
    const rows = await rpc('master_list_customers') || [];
    $('mlist').innerHTML = rows.length ? rows.map((r) => `<div class="cust">
        <span>${esc(r.email)}<br><span class="mini">${r.live
          ? (r.expires_at ? 'until ' + String(r.expires_at).slice(0, 10) : 'no expiry')
          : 'expired'}${r.note ? ' &middot; ' + esc(r.note) : ''}</span></span>
        <button class="small ghost" data-revoke="${esc(r.email)}">Revoke</button>
      </div>`).join('') : '<div class="meta">Nobody has been given access yet.</div>';
    document.querySelectorAll('[data-revoke]').forEach((b) => {
      b.onclick = async () => {
        if (b.dataset.armed !== '1') {
          b.dataset.armed = '1'; b.textContent = 'Sure?';
          setTimeout(() => { b.dataset.armed = ''; b.textContent = 'Revoke'; }, 4000);
          return;
        }
        try {
          await rpc('master_revoke', { p_email: b.dataset.revoke });
          $('mastermsg').textContent = `${b.dataset.revoke} can no longer see the policies.`;
          await loadCustomers();
        } catch (e) { $('mastermsg').textContent = e.message; }
      };
    });
  } catch (e) { $('mlist').innerHTML = `<div class="meta">${esc(e.message)}</div>`; }
}

/* ------------------------------------------------------------------ auth */

async function doAuth(fn, label) {
  // Lowercased because Supabase stores emails lowercase, and a phone keyboard that
  // capitalises the first letter would otherwise produce a baffling "wrong credentials".
  const email = $('email').value.trim().toLowerCase();
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
  checkMaster();
  await sync(false);
}

/* ---------------------------------------------------------------- wiring */

$('signin').onclick = () => doAuth(signIn, 'Signing in');
$('signup').onclick = () => doAuth(signUp, 'Creating account');
$('signout').onclick = () => {
  signOut();
  localStorage.removeItem(KEY);   // a shared phone must not leave one user's history behind
  store = blank();
  isMaster = false;
  $('master').classList.add('hide');
  masterForm(false);
  go('auth');
};
$('mnew').onclick = () => masterForm(true);
$('mcancel').onclick = () => { masterForm(false); $('mastermsg').textContent = 'Add a paying person from wherever you are.'; };
$('mroll').onclick = () => { $('mpass').value = rollPassword(); };
$('mcreate').onclick = () => createCustomer();
$('mlistbtn').onclick = () => loadCustomers();
$('resync').onclick = () => sync(false);
$('tostats').onclick = () => { renderStats(); go('stats'); };
$('statsback').onclick = () => { renderHome(); go('home'); };
$('readback').onclick = () => { renderHome(); go('home'); };
$('readtest').onclick = () => startSection(reading);
$('readpdf').onclick = () => openPdf();
$('start').onclick = () => start();
// Deliberately follows the normal sequence rather than repeating the last focus: after
// passing, "another session" should move you on, not park you on finished material.
$('again').onclick = () => start();
$('next').onclick = () => { S.i++; S.i >= S.questions.length ? finish() : renderQ(); };
$('quit').onclick = () => (S.answered ? finish() : go('home'));
$('home2').onclick = () => { renderHome(); go('home'); };

if (signedIn()) { renderHome(); go('home'); checkMaster(); sync(true); } else { go('auth'); }
window.addEventListener('online', () => sync(true));

/* Updates.
   An iPhone home-screen app resumes rather than reloads, so a fixed version can sit on
   the server for days while the phone keeps running the old one. This forces the issue:
   check for a new worker on every launch and on return to the foreground, and reload
   once the new one takes control. The guard stops a reload loop. */
export const APP_VERSION = 'v9';

if ('serviceWorker' in navigator) {
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });

  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch(() => {});
}

// Shown on the home screen so there is never an argument about which build is running.
const vtag = document.getElementById('version');
if (vtag) vtag.textContent = `build ${APP_VERSION}`;
