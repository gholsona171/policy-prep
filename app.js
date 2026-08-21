import {
  buildSession, coverage, gate, policyStats, itemStats, CONFIG, setConfig,
} from './engine.js';
import {
  signIn, signUp, signOut, signedIn, currentEmail, rpc, policyPdfUrl, db, changePassword,
} from './supa.js';
import { syncAll } from './sync.js';

/* The local copy is the working copy: every answer is recorded here first, so a session
   in a basement with no signal behaves exactly like one on wifi. Sync then reconciles
   with the server, which is the truth once it has been reached. */

const KEY = 'policy-prep-v1';
const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove('hide');
const hide = (id) => $(id).classList.add('hide');
const screens = ['auth', 'home', 'quiz', 'result', 'stats', 'read', 'settings'];
const go = (name) => { screens.forEach(hide); show(name); window.scrollTo(0, 0); };

const blank = () => ({
  index: { policies: [] }, items: {}, banks: {},
  progress: { answers: [], sessions: [] },
  open: null,   // a session started and not yet finished
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
    applySettings();
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

  // An unfinished session is the first thing on the screen, because it is the
  // thing most likely to be why the app was opened.
  const open = store.open;
  $('resume').classList.toggle('hide', !open);
  if (open) {
    const title = list.find((p) => p.id === open.currentId)?.title ?? 'a policy';
    const when = new Date(open.savedAt || Date.now());
    $('resumeline').textContent =
      `${open.answered} of ${open.questions.length} answered on ${title}, `
      + `left off ${when.toLocaleDateString()} at ${when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
  }
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
  const hasQuestions = (p) => (store.banks[p.id]?.questions?.length ?? 0) > 0;
  const focusId = list.find((p) => !p.passed && hasQuestions(p))?.id ?? null;

  $('policies').innerHTML = list.length ? list.map((p) => {
    const bank = store.banks[p.id];
    const c = coverage(store.items[p.id], bank);
    const g = gate(p.id, store.items[p.id], store.progress, bank);
    const st = policyStats(p.id, store.items[p.id], bank, store.progress);
    const state = !hasQuestions(p) ? 'reading only'
      : p.passed ? 'passed'
      : p.id === focusId ? 'in focus'
      : unlockedAll() ? 'open' : 'locked';
    const status = state === 'reading only'
        ? 'The policy is here to read. Its questions are still being written.'
      : p.passed ? 'Cleared. Still appears in review.'
      : p.id === focusId || state === 'open' ? g.reason
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
        <span class="pill ${g.coverage?.complete ? 'ok' : ''}">answered ${g.coverage?.done ?? 0} of ${g.coverage?.total ?? 0}</span>
        ${state === 'locked' ? '' : `
        <span class="pill">${g.bestPct === null ? 'no score yet' : 'best ' + g.bestPct + '%'}</span>
        <span class="pill">${st.accuracy === null ? 'unstudied' : st.accuracy + '% overall'}</span>`}
      </div>
      <div class="meta" style="margin-top:9px">${esc(status)}</div>${leech}
      ${state === 'locked' ? '' : state === 'reading only'
        ? `<div style="margin-top:12px">
            <button class="ghost" data-read="${esc(p.id)}"${p.text ? '' : ' disabled'}>Read the policy</button>
          </div>`
        : `<div class="twoup">
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
  markRead(id);
  go('read');
}

/** The department's own document, laid out the way they laid it out. Fetched
    on demand and turned into a file locally, so nothing durable is handed out
    and cancelling an account closes it immediately. Needs a live connection:
    the text above works offline, the PDF does not. */
async function openPdf() {
  if (!reading) return;
  const btn = $('readpdf');
  btn.disabled = true;
  $('pdfmsg').textContent = 'Fetching...';
  try {
    const url = await policyPdfUrl(reading);
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
  // With the personal unlock on, any section can be taken directly.
  if (unlockedAll()) {
    if (settings().require_read_first && !hasRead(id)) {
      const p = store.index.policies.find((x) => x.id === id);
      alert(`Read ${p ? p.title : 'the policy'} first, then take the test on it.`);
      return openReading(id);
    }
    return start(id, true);
  }
  // If the owner has switched it on, the policy has to have been opened once
  // before its test will start. Read locally, because who has read what is a
  // nudge, not a record worth syncing.
  if (settings().require_read_first && !hasRead(id)) {
    const p = store.index.policies.find((x) => x.id === id);
    alert(`Read ${p ? p.title : 'the policy'} first, then take the test on it.`);
    return openReading(id);
  }
  const focusId = store.index.policies.find((p) => !p.passed)?.id ?? null;
  start(id === focusId ? null : id);
}

const READ_KEY = 'policy-prep-read';
const readSet = () => { try { return JSON.parse(localStorage.getItem(READ_KEY)) || []; } catch { return []; } };
const hasRead = (id) => readSet().includes(id);
function markRead(id) {
  const seen = readSet();
  if (!seen.includes(id)) localStorage.setItem(READ_KEY, JSON.stringify(seen.concat(id)));
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

function start(focusId = null, allowUnpassed = false) {
  const built = buildSession(store, Date.now(), CONFIG.SESSION_SIZE, focusId, { allowUnpassed });
  if (!built.questions.length) return alert('No questions available.');
  S = { ...built, i: 0, right: 0, answered: 0 };
  keepSession();
  go('quiz');
  renderQ();
}

/* An unfinished session survives backing out, closing the app, or the phone
   deciding to kill it. Forty questions is a real sitting, and losing it because
   a call came in is the kind of thing that makes someone stop using the app. */
function keepSession() {
  store.open = S ? { ...S, savedAt: Date.now() } : null;
  save();
}

function resume() {
  if (!store.open) return;
  S = { ...store.open };
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
  speak(`${q.stem}. ${q.choices.map((c, n) => `${String.fromCharCode(65 + n)}. ${c}`).join('. ')}`);
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
  speak(`${correct ? 'Correct.' : 'Not this time.'} ${q.why || ''}`);
  show('next');
  keepSession();   // saved on every answer, not just at the end
}

function finish() {
  /* Score the policy being gated, on the questions actually answered.
     Two faults lived here and both let a policy be cleared without earning it.
     currentCount used to be the number of current-policy questions the session
     PLANNED to ask, so ending after one correct answer recorded a 40 question,
     100 percent session. And pct used to be the whole session including the
     review drawn from policies already passed, so easy review questions could
     lift a failing score on the current policy over the line. */
  const answered = S.questions.slice(0, S.i + (S.answered > S.i ? 1 : 0));
  const currentAnswered = answered.filter((q) => q.policyId === S.currentId);
  const currentRight = currentAnswered.filter((q) => {
    const a = store.progress.answers;
    for (let n = a.length - 1; n >= 0; n--) if (a[n].questionId === q.id) return a[n].correct;
    return false;
  }).length;
  const pct = currentAnswered.length
    ? Math.round((currentRight / currentAnswered.length) * 100) : 0;

  store.open = null;   // it is finished; there is nothing left to resume
  store.progress.sessions.push({
    id: `s${Date.now()}-${Math.floor(performance.now())}`, at: Date.now(),
    currentId: S.currentId, currentCount: currentAnswered.length,
    asked: S.answered, right: currentRight, pct, synced: false,
  });

  const g = gate(S.currentId, store.items[S.currentId], store.progress, store.banks[S.currentId]);
  if (g.passed) {
    const p = store.index.policies.find((x) => x.id === S.currentId);
    if (p && !p.passed) { p.passed = true; p.passedAt = Date.now(); }
  }
  save();

  // The headline score is the one the gate uses, so the screen cannot say 93%
  // while the rule is judging 89%.
  $('score').textContent = `${pct}%`;
  $('scoreline').textContent = `${currentRight} of ${currentAnswered.length} on this policy`
    + (S.answered > currentAnswered.length
      ? `, plus ${S.answered - currentAnswered.length} review` : '');
  $('gatebox').innerHTML = g.passed
    ? '<span class="pill ok">policy passed, next one unlocked</span>'
    : `<span class="pill warn">not yet</span>
       <div class="meta" style="margin-top:8px">${esc(g.reason)}</div>`
      + (g.leeches.length
        ? `<ul>${g.leeches.map((l) => `<li>${esc(l.label)} (missed ${l.wrong}x)</li>`).join('')}</ul>` : '');
  go('result');
  sync(true);   // push the session quietly; failure here costs nothing
}

/* -------------------------------------------------------------- settings */

/* One row in the database, read by every phone, writable only by a master.
   Applied here in one place so there is never a screen obeying an old value. */

/* Reading aloud is deliberately NOT here: it is a personal preference, owned by
   whoever is using the app, and having it in both places meant two switches
   that could disagree about the same thing. */
const SWITCHES = {
  setSignup: 'allow_self_signup',
  setPdf: 'show_pdf',
  setRead: 'require_read_first',
};

function settings() {
  return store.settings || {};
}

/* Personal preferences. These live on the phone, not the server, because they
   are about how one person wants to use the app and nobody else is affected by
   them. The master's switches remain the default; these override for this
   account on this device. */
const PREFS_KEY = 'policy-prep-prefs';
function prefs() {
  try { return { speak: null, unlockAll: false, ...JSON.parse(localStorage.getItem(PREFS_KEY)) }; }
  catch { return { speak: null, unlockAll: false }; }
}
function setPref(key, value) {
  const p = prefs();
  p[key] = value;
  localStorage.setItem(PREFS_KEY, JSON.stringify(p));
}
/** Reading aloud: the person's own choice if they have made one, else whatever
    the master set. */
const speakOn = () => (prefs().speak === null ? settings().speak_answers === true : prefs().speak === true);
const unlockedAll = () => prefs().unlockAll === true;

/** Pushes saved settings into the engine and into the parts of the screen that
    a switch is supposed to control. */
function applySettings() {
  const s = settings();
  setConfig(s);
  // A stranger creating an account gets nothing without an entitlement, but if
  // the owner would rather they could not, the button goes.
  $('signup').classList.toggle('hide', s.allow_self_signup === false);
  $('readpdf').classList.toggle('hide', s.show_pdf === false);
}

/** Reads a question or a verdict out loud, when that switch is on. Uses the
    voice already in the phone, so it costs nothing and works offline. */
function speak(text) {
  if (!speakOn() || !('speechSynthesis' in window)) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text));
    u.rate = 1;
    speechSynthesis.speak(u);
  } catch { /* a phone that will not speak is not a reason to stop the quiz */ }
}

function paintSettings() {
  // The master block is hidden for everyone else, and the database refuses
  // their writes regardless of what this screen shows.
  $('masteronly').classList.toggle('hide', !isMaster);
  $('prefSpeak').dataset.on = String(speakOn());
  $('prefUnlock').dataset.on = String(unlockedAll());
  $('pwNew').value = '';
  $('pwAgain').value = '';
  $('pwMsg').textContent = '';

  const s = settings();
  $('setSize').value = s.session_size ?? 40;
  $('setMix').value = s.mix_current ?? 80;
  $('setPass').value = s.pass_pct ?? 90;
  $('setGate').value = s.min_current_in_gate ?? 30;
  $('setLeech').value = s.leech_threshold ?? 2;
  Object.entries(SWITCHES).forEach(([id, col]) => {
    $(id).dataset.on = String(s[col] === true);
  });
  $('setmsg').textContent = '';
}

/** Wipes this account's study history, on the server and on this phone.
    Two taps, because it cannot be undone. */
async function resetProgress() {
  const btn = $('setreset');
  if (btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    btn.textContent = 'Really wipe everything? Tap again';
    setTimeout(() => { btn.dataset.armed = ''; btn.textContent = 'Start over from scratch'; }, 5000);
    return;
  }
  btn.dataset.armed = '';
  btn.textContent = 'Wiping...';
  btn.disabled = true;
  try {
    const r = await rpc('reset_my_progress');
    // Local first, so a phone that goes offline right now does not carry the
    // old history back up on the next sync.
    store.progress = { answers: [], sessions: [] };
    store.open = null;
    store.index.policies.forEach((p) => { p.passed = false; });
    localStorage.removeItem(READ_KEY);
    save();
    $('setmsg').textContent =
      `Wiped ${r?.answers ?? 0} answer(s) and ${r?.sessions ?? 0} session(s). You are back at the start.`;
    renderHome();
  } catch (e) {
    $('setmsg').textContent = e.message;
  }
  btn.textContent = 'Start over from scratch';
  btn.disabled = false;
}

async function changeMyPassword() {
  const a = $('pwNew').value;
  const b = $('pwAgain').value;
  if (a.length < 8) { $('pwMsg').textContent = 'At least 8 characters.'; return; }
  if (a !== b) { $('pwMsg').textContent = 'Those two do not match.'; return; }
  $('pwSave').disabled = true;
  $('pwMsg').textContent = 'Changing...';
  try {
    await changePassword(a);
    $('pwNew').value = '';
    $('pwAgain').value = '';
    $('pwMsg').textContent = 'Done. Use the new one next time you sign in.';
  } catch (e) { $('pwMsg').textContent = e.message; }
  $('pwSave').disabled = false;
}

async function saveSettings() {
  const body = {
    session_size: Number($('setSize').value),
    mix_current: Number($('setMix').value),
    pass_pct: Number($('setPass').value),
    min_current_in_gate: Number($('setGate').value),
    leech_threshold: Number($('setLeech').value),
    updated_at: new Date().toISOString(),
  };
  Object.entries(SWITCHES).forEach(([id, col]) => { body[col] = $(id).dataset.on === 'true'; });

  $('setsave').disabled = true;
  $('setmsg').textContent = 'Saving...';
  try {
    // The database checks the limits too, so a silly number is refused there
    // even if this screen were bypassed.
    const rows = await db('app_settings?id=eq.true', { method: 'PATCH', body, prefer: 'return=representation' });
    // A write that is not allowed comes back as success with nothing changed,
    // because the row is simply invisible to that account. Silence would look
    // like it saved, so treat an empty result as the refusal it is.
    if (!Array.isArray(rows) || !rows.length) throw new Error('Only the master account can change these.');
    store.settings = { ...settings(), ...rows[0] };
    save();
    applySettings();
    renderHome();
    $('setmsg').textContent = 'Saved. Every phone picks this up on its next sync.';
  } catch (e) {
    $('setmsg').textContent = e.message.includes('sane_') || e.message.includes('violates')
      ? 'One of those numbers is outside what the system will accept.'
      : e.message;
  }
  $('setsave').disabled = false;
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
// Pause keeps the session on the shelf. End scores what was answered and closes it.
$('pause').onclick = () => { keepSession(); renderHome(); go('home'); };
$('quit').onclick = () => (S.answered ? finish() : (store.open = null, save(), renderHome(), go('home')));
$('tosettings').onclick = () => { paintSettings(); go('settings'); };
$('setback').onclick = () => { renderHome(); go('home'); };
$('pwSave').onclick = () => changeMyPassword();
$('prefSpeak').onclick = function () {
  const on = this.dataset.on !== 'true';
  this.dataset.on = String(on);
  setPref('speak', on);
  if (!on && 'speechSynthesis' in window) speechSynthesis.cancel();
};
$('prefUnlock').onclick = function () {
  const on = this.dataset.on !== 'true';
  this.dataset.on = String(on);
  setPref('unlockAll', on);
  renderHome();
};
$('setsave').onclick = () => saveSettings();
$('setreset').onclick = () => resetProgress();
Object.keys(SWITCHES).forEach((id) => {
  $(id).onclick = function () { this.dataset.on = this.dataset.on === 'true' ? 'false' : 'true'; };
});
$('resumebtn').onclick = () => resume();
$('dropbtn').onclick = () => { store.open = null; save(); renderHome(); };
$('home2').onclick = () => { renderHome(); go('home'); };

/* Tells the recovery script in index.html that the modules loaded and ran. Set
   before anything that could throw, because the point is to prove the imports
   resolved, not that the whole app is happy. */
window.policyPrepBooted = true;
sessionStorage.removeItem('policy-prep-recovered');

if (signedIn()) { renderHome(); go('home'); checkMaster(); sync(true); } else { go('auth'); }
window.addEventListener('online', () => sync(true));

/* Updates.
   An iPhone home-screen app resumes rather than reloads, so a fixed version can sit on
   the server for days while the phone keeps running the old one. This forces the issue:
   check for a new worker on every launch and on return to the foreground, and reload
   once the new one takes control. The guard stops a reload loop. */
export const APP_VERSION = 'v17';

if ('serviceWorker' in navigator) {
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });

  // updateViaCache 'none' so the worker script itself is never served from the
  // browser's own HTTP cache; otherwise a phone can sit on a stale worker for
  // hours and keep handing out last week's files.
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch(() => {});
}

// Shown on the home screen so there is never an argument about which build is running.
const vtag = document.getElementById('version');
if (vtag) vtag.textContent = `build ${APP_VERSION}`;
