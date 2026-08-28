import {
  buildSession, coverage, gate, policyStats, itemStats,
} from './engine.js';
import {
  signIn, signUp, signOut, signedIn, currentEmail, currentUserId, rpc, policyPdfUrl, db,
  changePassword, deviceId, deviceLabel,
} from './supa.js';
import { syncAll } from './sync.js';
import {
  readContent, writeContent, clearContent, heavyOf, lightOf, rejoin,
} from './content-store.js';

/* The local copy is the working copy: every answer is recorded here first, so a session
   in a basement with no signal behaves exactly like one on wifi. Sync then reconciles
   with the server, which is the truth once it has been reached. */

const KEY = 'policy-prep-v1';
const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove('hide');
const hide = (id) => $(id).classList.add('hide');
const screens = ['auth', 'home', 'quiz', 'result', 'stats', 'read', 'settings', 'practice', 'extras', 'suggest'];
// The screen Settings was opened from, so its Back button can undo the trip.
let cameFrom = 'home';
const go = (name) => {
  if (name === 'settings') cameFrom = screens.find((s) => !$(s).classList.contains('hide')) || 'home';
  screens.forEach(hide); show(name); window.scrollTo(0, 0);
  // The corner controls are for people using the app, not for the sign-in screen.
  paintMic(name !== 'auth');
  // No gear on Settings itself: a button that opens the screen you are already
  // looking at reads as broken, and Back is right there instead.
  $('gear').classList.toggle('hide', name === 'auth');
  $('menudrop').classList.add('hide');
};

const blank = () => ({
  index: { policies: [] }, items: {}, banks: {},
  practice: {},  // paid formats; the study engine never sees this drawer
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

/* Progress goes to localStorage, content goes to IndexedDB. See content-store.js for
   why: the two together are 7.21 MB and iOS throws past about 5 MB, which silently
   froze this app on the last snapshot that happened to fit.

   save() must never throw. It used to be the single unguarded statement between the
   sync and the re-render, so one storage failure both lost the write AND left the
   correct freshly pulled data unpainted. Storage is a cache of the server here;
   failing to write it is worth reporting, never worth aborting a render for. */
let storageWarning = null;

/* save() is progress, and it runs on every single answer, so it stays small and
   synchronous. */
const save = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(lightOf(store)));
    storageWarning = null;
  } catch (e) {
    storageWarning = `this phone refused to save your progress (${e.name || 'storage error'})`;
  }
};

/* saveContent() is the eighty policies, and only a sync changes them. Keeping it out
   of save() matters: the content is about 6.5 MB and rewriting that on every answer
   would drain the battery to store bytes that did not change. */
const saveContent = () => writeContent(heavyOf(store)).catch((e) => {
  storageWarning = `this phone could not store the policy content (${e.name || e.message})`;
});

/** Boot-time read of the heavy half. Separate from load() because IndexedDB is async
    and the home screen should paint from what we already have rather than wait. */
async function loadContent() {
  try { rejoin(store, await readContent()); } catch { /* next sync refills it */ }
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ------------------------------------------------------------------ sync */

async function sync(quiet) {
  if (!signedIn()) return;
  if (!quiet) $('syncmsg').textContent = 'Checking...';
  try {
    await syncAll(store);
    applySettings();
    obeyMinBuild();
    if (leaderboardOn()) {
      try { store.leaderboard = await rpc('leaderboard'); } catch { /* board is a nicety */ }
    }
    save();
    await saveContent();
    renderHome();
    // Says what actually arrived, not just that something did. "Up to date" while
    // sixty five policies had no questions was a true sentence hiding a broken
    // pull, and there is no way to inspect a phone from here.
    const banks = Object.values(store.banks);
    const qTotal = banks.reduce((n, b) => n + (b.questions?.length ?? 0), 0);
    const noQ = store.index.policies.filter((p) => !(store.banks[p.id]?.questions?.length)).length;
    $('syncmsg').textContent =
      `Up to date on ${APP_VERSION}. ${store.index.policies.length} policies, ${qTotal} questions`
      + (noQ ? `, ${noQ} still reading only.` : '.')
      // A failed write means this all has to be pulled again next launch. Say so:
      // silence here is what let a full store sit unsaved for a day.
      + (storageWarning ? ` Warning: ${storageWarning}.` : '');
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

/** The best pass anyone holds on one section, full and simple kept apart:
    ten key questions and the whole bank are different mountains. */
function sectionBest(policyId) {
  if (!leaderboardOn()) return '';
  const rows = (store.leaderboard?.sections ?? []).filter((x) => x.policy_id === policyId);
  if (!rows.length) return '';
  const bit = (x) => `${x.simple ? 'simple' : 'best'} ${x.best}% ${esc(x.name)}`;
  const full = rows.find((x) => !x.simple);
  const simple = rows.find((x) => x.simple);
  return `<span class="mini">${[full, simple].filter(Boolean).map(bit).join(' &middot; ')}</span>`;
}

function renderHome() {
  const list = store.index.policies;

  // An unfinished session is the first thing on the screen, because it is the
  // thing most likely to be why the app was opened.
  const open = store.open;
  $('resume').classList.toggle('hide', !open);
  if (open) {
    const title = open.drill ? `the ${open.drill}`
      : list.find((p) => p.id === open.currentId)?.title ?? 'a policy';
    const when = new Date(open.savedAt || Date.now());
    $('resumeline').textContent =
      `${open.answered} of ${open.questions.length} answered on ${title}, `
      + `left off ${when.toLocaleDateString()} at ${when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
  }
  $('whoami').textContent = currentEmail() ? `Signed in as ${currentEmail()}` : '';
  $('homesub').textContent = list.length
    ? 'One policy at a time. 90 percent and no repeat misses to move on.'
    : 'No policies published yet.';

  // The leaderboard, at the very top, when it is on and has anything to say.
  const lb = store.leaderboard;
  $('leaderboard').innerHTML = (leaderboardOn() && lb?.overall?.length) ? `<div class="card stack">
    <div class="mini">Leaderboard</div>
    ${lb.overall.slice(0, 5).map((r, i) => `<div class="row" style="justify-content:space-between${r.me ? ';font-weight:700' : ''}">
      <span>${i + 1}. ${esc(r.name)}${r.me ? ' (you)' : ''}</span>
      <span class="mini">${r.full_passed} full &middot; ${r.simple_passed} simple${r.avg_pct != null ? ` &middot; avg ${r.avg_pct}%` : ''}</span>
    </div>`).join('')}
  </div>` : '';

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
    const g = gate(p.id, store.items[p.id], store.progress, bank, simpleOn(), passMark());
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
        ${sectionBest(p.id)}
        <span class="pill ${state === 'passed' ? 'ok' : state === 'in focus' ? 'warn' : ''}">${state}${
          state === 'passed' && p.passedPct != null
            ? ` · ${p.passedPct}%${p.passedMark != null && p.passedMark !== 90 ? ` (mark ${p.passedMark})` : ''}` : ''}</span>
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
  renderPracticeCard();
  renderTestingCard();
}

/* -------------------------------------------------------------- practice */

/* The card exists only when the pull actually delivered practice questions.
   The server already decided that by tier, so absence IS the gate: a tier-1
   phone has an empty drawer and simply never grows the card. Nothing here
   checks a tier, because nothing here needs to know one exists. */
const FORMAT_NAMES = {
  match: 'Match word to definition',
  term: 'Key terms',
  blank: 'Fill in the blank',
  scenario: 'Scenarios',
  caselaw: 'Case law',
};

function practicePool() {
  const byFormat = {};
  for (const pack of Object.values(store.practice ?? {})) {
    for (const q of pack.questions ?? []) {
      (byFormat[q.format] = byFormat[q.format] ?? []).push(q);
    }
  }
  return byFormat;
}

function renderPracticeCard() {
  const el = $('practicecard');
  if (!el) return;
  const pool = practicePool();
  const formats = Object.keys(pool).filter(formatOn);
  const anyAtAll = Object.keys(pool).length > 0;
  if (!formats.length) {
    el.classList.toggle('hide', !anyAtAll);
    // Every format switched off is not the same as having none: say where the
    // switches are rather than presenting an empty card or a vanished feature.
    el.innerHTML = anyAtAll
      ? '<b>Practice</b><div class="meta">All practice formats are switched off in Settings.</div>'
      : '';
    return;
  }
  el.classList.remove('hide');
  el.innerHTML = `<b>Practice</b>
    <div class="meta">Extra ways to drill what you are studying. Not scored, and never
      part of clearing a policy.</div>
    ${formats.map((f) => `<button class="ghost" data-practice="${f}">
      ${FORMAT_NAMES[f] ?? f} (${pool[f].length})</button>`).join('')}`;
  el.querySelectorAll('[data-practice]').forEach((b) => {
    b.onclick = () => startPractice(b.dataset.practice);
  });
}

/* ---------------------------------------------------------------- drills
   Three testing areas, tier 2, added 26 Aug 2026 at Anton's instruction.
   They reuse the quiz screen, so every answer lands in the same history as a
   real sitting - his ruling: "they affect your overall score". What they never
   do is record a SESSION, so no drill can produce the qualifying sitting the
   gate demands, and the one-policy-at-a-time course is untouched.

   All three draw core questions only (the four-option material the exam is
   made of; typed-answer practice has its own screen), through the same
   simple-mode lens as everything else. */

/* Tier-2 content arrives only for a tier-2 account, and it arrives into the
   practice drawer - so the drawer having anything in it IS the tier check,
   the same one the Practice card already relies on. */
const tier2Here = () => Object.keys(practicePool()).length > 0;

const drillPool = (ids = null) => {
  const out = [];
  for (const p of store.index.policies) {
    if (ids && !ids.includes(p.id)) continue;
    for (const q of lensed(store.banks[p.id])) {
      if ((q.minTier ?? 1) <= 1 && Array.isArray(q.choices) && q.choices.length === 4) out.push(q);
    }
  }
  return out;
};

const lensed = (bank) => {
  const qs = bank?.questions ?? [];
  if (!simpleOn()) return qs;
  const key = qs.filter((q) => q.key === true);
  return key.length ? key : qs;
};

/** Questions this person has answered wrong two or more times, lifetime. */
function weakQuestions() {
  const wrongs = new Map();
  for (const a of store.progress.answers) {
    if (!a.correct) wrongs.set(a.questionId, (wrongs.get(a.questionId) ?? 0) + 1);
  }
  return drillPool().filter((q) => (wrongs.get(q.id) ?? 0) >= 2);
}

function startDrill(questions, label) {
  if (!questions.length) return;
  const shuffledQ = questions.slice();
  for (let i = shuffledQ.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffledQ[i], shuffledQ[j]] = [shuffledQ[j], shuffledQ[i]];
  }
  S = { questions: shuffledQ, currentId: null, currentCount: 0, i: 0, right: 0, answered: 0,
        drill: label };
  keepSession();
  go('quiz');
  renderQ();
}

function renderTestingCard() {
  const el = $('testingcard');
  if (!el) return;
  if (!tier2Here()) { el.classList.add('hide'); el.innerHTML = ''; return; }
  el.classList.remove('hide');
  const weak = weakQuestions();
  const weakReady = weak.length >= 10;
  el.innerHTML = `<b>Testing area</b>
    <div class="meta">Real questions, recorded like any other answer. No test here can
      clear a section: that still takes a full sitting.</div>
    <button class="ghost" id="drillmock">Practice exam: 100 at random</button>
    <button class="ghost" id="drillweak" ${weakReady ? '' : 'disabled'}>
      Weak spots (${weak.length})</button>
    ${weakReady ? '' : `<div class="mini">Opens at 10 questions missed twice; you have ${weak.length}.</div>`}
    <button class="ghost" id="drillpick">Build your own test</button>
    <div id="drillpicker" class="hide stack"></div>`;
  $('drillmock').onclick = () => {
    const pool = drillPool();
    startDrill(pool.slice(0, 100).length === pool.length ? pool : shufflePick(pool, 100), 'practice exam');
  };
  $('drillweak').onclick = () => { if (weakReady) startDrill(weak, 'weak spots'); };
  $('drillpick').onclick = () => renderDrillPicker();
}

/** A fresh random 100, drawn again on every open. */
function shufflePick(pool, n) {
  const a = pool.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

function renderDrillPicker() {
  const el = $('drillpicker');
  el.classList.toggle('hide');
  if (el.classList.contains('hide')) { el.innerHTML = ''; return; }
  // Locked policies appear only for someone who has switched on the personal
  // any-order setting: pooling locked material is exactly what that switch is for.
  const jump = unlockedAll();
  const firstUnpassed = store.index.policies.find((p) => !p.passed)?.id;
  const offerable = store.index.policies.filter((p) => {
    if (!lensed(store.banks[p.id]).length) return false;
    if (jump) return true;
    return p.passed || p.id === firstUnpassed;
  });
  el.innerHTML = `<div class="mini" style="margin-top:8px">Pick the sections to pool</div>`
    + (jump ? '' : `<div class="mini">Locked sections appear here once "study any section,
        in any order" is switched on in Settings.</div>`)
    + offerable.map((p) => `<button class="toggle ghost" data-pool="${p.id}" data-on="false">
        ${esc(p.title)}</button>`).join('')
    + `<button id="drillgo" disabled>Start the test</button>`;
  const chosen = new Set();
  el.querySelectorAll('[data-pool]').forEach((b) => {
    b.onclick = () => {
      const on = b.dataset.on !== 'true';
      b.dataset.on = String(on);
      on ? chosen.add(b.dataset.pool) : chosen.delete(b.dataset.pool);
      $('drillgo').disabled = !chosen.size;
    };
  });
  $('drillgo').onclick = () => {
    if (chosen.size) startDrill(drillPool([...chosen]), 'your own test');
  };
}

/** One switch per practice format this person's tier actually delivers.
    Lives under YOURS in Settings because it is a personal preference on this
    phone, exactly like reading aloud: no master setting is consulted and no
    other account is affected. */
function renderFormatToggles() {
  const el = $('prefFormats');
  if (!el) return;
  const formats = Object.keys(practicePool());
  if (!formats.length) { el.classList.add('hide'); el.innerHTML = ''; return; }
  el.classList.remove('hide');
  el.innerHTML = `<div class="mini" style="margin-top:10px">Practice formats</div>`
    + formats.map((f) => `<button class="toggle ghost" data-fmt="${f}"
        data-on="${formatOn(f)}">${FORMAT_NAMES[f] ?? f}</button>`).join('');
  el.querySelectorAll('[data-fmt]').forEach((b) => {
    b.onclick = () => {
      const now = b.dataset.on !== 'true';
      b.dataset.on = String(now);
      setFormatPref(b.dataset.fmt, now);
      renderPracticeCard();
    };
  });
}

/* Typed answers are forgiving on purpose: "48", "48 hours" and "forty-eight"
   are the same knowledge. Being marked wrong while right is how a study app
   loses somebody, so grading strips case, punctuation and spacing, and the
   bank lists every honest rendering. */
/* Order matters and got it wrong once: trimming FIRST leaves the space that
   removing a trailing "." exposes, so "2 ." failed against "2". Strip, then
   collapse, then trim, so nothing stripped can leave whitespace behind. */
const normalizeBlank = (t) => String(t ?? '').toLowerCase()
  .replace(/[.,;:!?"'’$()[\]]/g, '').replace(/\s+/g, ' ').trim();
const blankRight = (typed, accept) =>
  (accept ?? []).some((a) => normalizeBlank(a) === normalizeBlank(typed));

let P = null; // the running practice set; deliberately never persisted

function startPractice(format) {
  const pool = practicePool()[format] ?? [];
  if (!pool.length) return;
  P = { questions: shufflePractice(pool), i: 0, right: 0, tried: 0 };
  go('practice');
  renderP();
}

/* A chained scenario is one incident told across two or three questions, and
   the parts only make sense in order: part 2 begins where part 1's answer left
   you. So chains ride the shuffle as one block - the ORDER OF STORIES is
   random, the order INSIDE a story never is. Everything unchained shuffles
   exactly as before. */
function shufflePractice(arr) {
  const groups = [];
  const byChain = new Map();
  for (const q of arr) {
    if (q.chain) {
      if (!byChain.has(q.chain)) { byChain.set(q.chain, []); groups.push(byChain.get(q.chain)); }
      byChain.get(q.chain).push(q);
    } else {
      groups.push([q]);
    }
  }
  byChain.forEach((g) => g.sort((a, b) => (a.part ?? 0) - (b.part ?? 0)));
  for (let i = groups.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [groups[i], groups[j]] = [groups[j], groups[i]];
  }
  return groups.flat();
}

function policyTitle(id) {
  return store.index.policies.find((p) => p.id === id)?.title ?? id;
}

function renderP() {
  const q = P.questions[P.i];
  $('pcounter').textContent = `Question ${P.i + 1} of ${P.questions.length}`;
  $('ptally').textContent = P.tried ? `${P.right} of ${P.tried} right` : '';
  // Which policy this question tests, named at the top, so an answer is
  // always read against the right document; and its place in the story when
  // it is part of a chained scenario.
  const chainLen = q.chain ? P.questions.filter((x) => x.chain === q.chain).length : 0;
  $('ppolicy').textContent = `Policy: ${policyTitle(q.policyId)}`
    + (q.chain ? ` — Part ${q.part} of ${chainLen}` : '');
  $('pstem').textContent = q.stem;
  $('pfeedback').classList.add('hide');
  $('pnext').classList.add('hide');
  const isBlank = q.format === 'blank';
  $('pblankrow').classList.toggle('hide', !isBlank);
  $('pchoices').innerHTML = '';
  if (isBlank) {
    $('pblank').value = '';
    $('pblank').disabled = false;
    $('pcheck').disabled = false;
    $('pblank').focus();
  } else {
    q.choices.forEach((c, idx) => {
      const b = document.createElement('button');
      b.className = 'choice';
      b.textContent = c;
      b.onclick = () => settleP(idx === q.answer,
        `The answer: ${q.choices[q.answer]}`, q);
      $('pchoices').appendChild(b);
    });
  }
}

function settleP(right, answerLine, q) {
  P.tried++;
  if (right) P.right++;
  $('ptally').textContent = `${P.right} of ${P.tried} right`;
  const fb = $('pfeedback');
  fb.classList.remove('hide');
  fb.innerHTML = `<b>${right ? 'Right.' : 'Not quite.'}</b> ${esc(answerLine)}
    ${q.why ? `<br>${esc(q.why)}` : ''}
    ${q.cite ? `<br><span class="mini">"${esc(q.cite)}"</span>` : ''}`;
  speak(right ? 'Right.' : 'Not quite.');
  document.querySelectorAll('#pchoices .choice').forEach((b) => { b.disabled = true; });
  $('pblank').disabled = true;
  $('pcheck').disabled = true;
  $('pnext').classList.remove('hide');
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
  // No size argument any more: a session is the whole policy, and the engine reads
  // that off the bank the import produced.
  const built = buildSession(store, Date.now(), focusId, { allowUnpassed, simple: simpleOn() });
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
  // The policy this question belongs to, named at the top. A session mixes
  // review from passed policies underneath the current one, and an answer
  // should always be read against the right document.
  $('qpolicy').textContent = `Policy: ${policyTitle(q.policyId)}`;
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
  /* A drill ends with a score and nothing else: no session row, no gate, no
     popup. The answers were already recorded one by one, which is all "affect
     your overall score" requires; a session row is what the gate reads, and no
     drill may ever produce one. */
  if (S.drill) {
    const pct = S.answered ? Math.round((S.right / S.answered) * 100) : 0;
    store.open = null;
    save();
    $('score').textContent = `${pct}%`;
    $('scoreline').textContent = `${S.right} of ${S.answered} on the ${S.drill}`;
    $('gatebox').innerHTML = '<span class="pill">testing only - sections clear in a full sitting</span>';
    go('result');
    renderHome();
    return;
  }
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

  const g = gate(S.currentId, store.items[S.currentId], store.progress, store.banks[S.currentId], simpleOn(), passMark());
  if (g.passed) {
    const p = store.index.policies.find((x) => x.id === S.currentId);
    if (p && !p.passed) {
      p.passed = true;
      p.passedAt = Date.now();
      // What it was cleared WITH, kept forever: the score and the mark in
      // force at the time. A dashboard that says "passed" without saying at
      // what standard is a dashboard that can lie to you later.
      p.passedPct = g.bestPct;
      p.passedMark = g.mark;
      p.passedSimple = simpleOn();
    }
  }
  save();
  // Rule 3 as a plain sentence, at the exact moment it is the only blocker.
  // Coverage done, score made, and still not through: without this popup that
  // reads as a broken app rather than as the leech rule doing its job.
  if (g.blockedOnlyByLeeches) {
    const nl = String.fromCharCode(10);
    const names = g.leeches.slice(0, 5).map((l) => '- ' + l.label).join(nl);
    alert('Your score cleared the bar, but the section stays locked because of '
      + g.leeches.length + ' repeat miss' + (g.leeches.length > 1 ? 'es' : '')
      + ' - things answered wrong twice and not yet fixed:' + nl + nl + names
      + (g.leeches.length > 5 ? nl + '...' : '')
      + nl + nl + 'Get each one right once and the section clears. '
      + 'They will keep appearing until you do.');
  }

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
  setAwake: 'keepalive',
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
  try { return { speak: null, unlockAll: false, formats: {}, ...JSON.parse(localStorage.getItem(PREFS_KEY)) }; }
  catch { return { speak: null, unlockAll: false, formats: {} }; }
}
function setPref(key, value) {
  const p = prefs();
  p[key] = value;
  localStorage.setItem(PREFS_KEY, JSON.stringify(p));
}
/** Reading aloud: the person's own choice if they have made one, else whatever
    the master set. */
/* Off unless this person has deliberately switched it on. It used to fall back to
   the master's speak_answers switch, which meant one setting could make everyone
   else's phone start talking. Reading aloud belongs to whoever is holding the
   phone, and silence is the safe default in a room full of people. */
const speakOn = () => prefs().speak === true;
const unlockedAll = () => prefs().unlockAll === true;
/* A format is ON unless this person switched it off. The switch controls what
   THEIR practice card offers on THIS phone; the tier decides what arrives at
   all, and no toggle can conjure content the server never sent. */
const formatOn = (f) => prefs().formats?.[f] !== false;
/* Simple mode: sessions are the key questions only and the section clears on
   them. His call, made knowing it reverses the 20 Aug whole-bank rule for
   this mode. Personal, per phone, like reading aloud. */
const simpleOn = () => prefs().simple === true;
// ON unless deliberately switched off - Anton's default for the leaderboard.
const leaderboardOn = () => prefs().leaderboard !== false;
/* The pass mark: this person's own, default 90. Clamped 50-100, so a typo can
   neither make sections free nor make them impossible. */
const passMark = () => {
  const n = Number(prefs().passMark);
  return Number.isFinite(n) && n >= 50 && n <= 100 ? n : 90;
};
function setFormatPref(f, on) {
  const p = prefs();
  p.formats = { ...(p.formats ?? {}), [f]: on };
  localStorage.setItem(PREFS_KEY, JSON.stringify(p));
}

/* The master's update push. min_build rides the settings row every phone pulls
   on every sync; a phone below the floor reloads itself into the newest build
   right now, instead of waiting for the close-and-reopen-twice ritual. The
   worker fetches network-first with the HTTP cache bypassed, so one reload IS
   the newest build. The sessionStorage guard stops a loop if a phone somehow
   cannot get above the floor: it reloads once per app-open, not forever. */
function obeyMinBuild() {
  const floor = Number(store.settings?.min_build) || 0;
  if (floor <= BUILD || !navigator.onLine) return;
  try {
    if (sessionStorage.getItem('policy-prep-forced') === String(floor)) return;
    sessionStorage.setItem('policy-prep-forced', String(floor));
  } catch { return; }
  navigator.serviceWorker?.getRegistration?.().then((r) => r?.update()).catch(() => {});
  location.reload();
}

/** Applies the switches to the parts of the screen they control. Nothing here
    reaches the engine any more: the rules that decide a pass are fixed in code. */
function applySettings() {
  const s = settings();
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

/** The address to hand out, read off the browser rather than written down here,
    so it stays right if the app is ever moved to another host. */
function appLink() {
  return (location.origin + location.pathname).replace(/index\.html$/, '');
}

/** The corner switch. `visible` false leaves it hidden without touching the
    preference, so signing out does not silently turn reading aloud back on. */
function paintMic(visible) {
  const el = $('micToggle');
  if (!el) return;
  el.classList.toggle('hide', !visible);
  document.body.classList.toggle('hasmic', !!visible);
  const on = speakOn();
  el.dataset.on = String(on);
  el.setAttribute('aria-pressed', String(on));
  el.textContent = on ? 'Aloud: on' : 'Aloud: off';
}

/** One switch, two places on screen. Whichever is tapped, both must agree. */
function setSpeak(on) {
  setPref('speak', on);
  if (!on && 'speechSynthesis' in window) speechSynthesis.cancel();
  paintMic(!$('micToggle').classList.contains('hide'));
  const pref = $('prefSpeak');
  if (pref) pref.dataset.on = String(on);
}

function paintSettings() {
  // The master block is hidden for everyone else, and the database refuses
  // their writes regardless of what this screen shows.
  $('masteronly').classList.toggle('hide', !isMaster);
  $('prefSpeak').dataset.on = String(speakOn());
  $('applink').textContent = appLink();
  $('copymsg').textContent = 'Send them this, then create their account above.';
  $('prefUnlock').dataset.on = String(unlockedAll());
  $('prefSimple').dataset.on = String(simpleOn());
  $('prefPass').value = passMark();
  $('prefBoard').dataset.on = String(leaderboardOn());
  renderFormatToggles();
  $('pwNew').value = '';
  $('pwAgain').value = '';
  $('pwMsg').textContent = '';

  const s = settings();
  Object.entries(SWITCHES).forEach(([id, col]) => {
    $(id).dataset.on = String(s[col] === true);
  });
  $('setmsg').textContent = '';
  if (isMaster) fillTierPicker();
}

/* The tier list comes from the database so renaming a tier there renames it
   here without a deploy. Cached per app run; two rows do not need more. */
let tiersCache = null;
async function tierList() {
  if (!tiersCache) {
    try { tiersCache = await db('tiers?select=tier,name,blurb&order=tier') || []; }
    catch { tiersCache = []; }
  }
  return tiersCache;
}
const tierName = (t) => (tiersCache ?? []).find((r) => r.tier === t)?.name ?? `tier ${t}`;

async function fillTierPicker() {
  const rows = await tierList();
  $('mtier').innerHTML = rows.length
    ? rows.map((r) => `<option value="${r.tier}">${esc(r.name)}</option>`).join('')
    : '<option value="1">Foundations</option>';
  $('mtier').value = '1'; // new people start at the bottom unless said otherwise
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
    // old history back up on the next sync. The epoch marker is dropped too,
    // so the next sync full-pulls the (now empty) truth instead of deltaing.
    store.progressEpoch = null;
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
  /* Switches only. The five numbers that used to live here decided how a pass was
     earned, and they are now fixed in engine.js where nobody can nudge them. The
     columns are left alone rather than written with defaults: this screen no longer
     has an opinion about them. */
  const body = { updated_at: new Date().toISOString() };
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
      p_tier: Number($('mtier').value) || 1,
    });
    masterForm(false);
    // The one thing they need is on screen in a block they can read out or copy.
    $('handout').innerHTML = `<b>${r.created ? 'Account created' : 'Existing account, password reset'}</b>
      ${esc(r.email)}<br>${esc(r.password)}<br>
      <span class="meta">${tierName(r.tier ?? 1)} &middot; ${r.expires_at ? 'expires ' + String(r.expires_at).slice(0, 10) : 'does not expire'}</span>`;
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
    await tierList();
    const tiers = tiersCache ?? [];
    const topTier = tiers.length ? Math.max(...tiers.map((t) => t.tier)) : 1;
    // Promotion is one tap: they paid, and a misfire loses nothing. Demotion
    // takes something away, so it arms first, exactly like Revoke.
    const moveBtn = (r) => {
      const t = r.tier ?? 1;
      if (t < topTier) {
        return `<button class="small ghost" data-tier="${t + 1}" data-temail="${esc(r.email)}">
          Move to ${esc(tierName(t + 1))}</button>`;
      }
      if (t > 1) {
        return `<button class="small ghost" data-tier="${t - 1}" data-temail="${esc(r.email)}" data-arm="1">
          Back to ${esc(tierName(t - 1))}</button>`;
      }
      return '';
    };
    $('mlist').innerHTML = rows.length ? rows.map((r) => `<div class="cust">
        <span>${esc(r.email)}<br><span class="mini">${esc(tierName(r.tier ?? 1))} &middot; ${r.live
          ? (r.expires_at ? 'until ' + String(r.expires_at).slice(0, 10) : 'no expiry')
          : 'expired'}${r.note ? ' &middot; ' + esc(r.note) : ''}${r.device_label
          ? ` &middot; on ${esc(r.device_label)} since ${String(r.device_claimed).slice(0, 10)}`
          : ' &middot; no device yet'}</span></span>
        <span class="row">${moveBtn(r)}${r.device_label
          ? `<button class="small ghost" data-release="${esc(r.email)}">Release device</button>` : ''}
        <button class="small ghost" data-revoke="${esc(r.email)}">Revoke</button></span>
      </div>`).join('') : '<div class="meta">Nobody has been given access yet.</div>';
    document.querySelectorAll('[data-temail]').forEach((b) => {
      b.onclick = async () => {
        if (b.dataset.arm === '1' && b.dataset.armed !== '1') {
          b.dataset.armed = '1'; b.textContent = 'Sure?';
          setTimeout(() => { b.dataset.armed = ''; b.textContent = `Back to ${tierName(Number(b.dataset.tier))}`; }, 4000);
          return;
        }
        try {
          const r = await rpc('master_set_tier', { p_email: b.dataset.temail, p_tier: Number(b.dataset.tier) });
          $('mastermsg').textContent = `${r.email} is now on ${tierName(r.tier)}. Their phone picks it up on its next sync.`;
          await loadCustomers();
        } catch (e) { $('mastermsg').textContent = e.message; }
      };
    });
    document.querySelectorAll('[data-release]').forEach((b) => {
      b.onclick = async () => {
        if (b.dataset.armed !== '1') {
          b.dataset.armed = '1'; b.textContent = 'Sure?';
          setTimeout(() => { b.dataset.armed = ''; b.textContent = 'Release device'; }, 4000);
          return;
        }
        try {
          await rpc('master_release_device', { p_email: b.dataset.release });
          $('mastermsg').textContent = `${b.dataset.release} can now sign in on a new device. The first one in takes the slot.`;
          await loadCustomers();
        } catch (e) { $('mastermsg').textContent = e.message; }
      };
    });
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
    if (!(await claimThisDevice())) return;
    await afterSignIn();
  } catch (e) { $('authmsg').textContent = e.message; }
}

/* The device lock, client side. The server refuses content to any device but
   the registered one regardless of what this code does - this function exists
   to say WHY the screen would otherwise just be empty. First device claims;
   a different device is signed straight back out with a plain sentence. */
async function claimThisDevice() {
  try {
    const r = await rpc('claim_device', { p_device_id: deviceId(), p_label: deviceLabel() });
    if (r?.ok) return true;
    signOut();
    localStorage.removeItem(KEY);
    clearContent().catch(() => {});
    store = blank();
    go('auth');
    $('authmsg').textContent = 'This account is locked to '
      + (r?.holder ? `another device (${r.holder})` : 'another device')
      + '. Ask the person who sold you access to release it, then sign in again.';
    return false;
  } catch {
    // Offline at boot: the server will still refuse content if this device
    // lost the slot, so failing open here costs nothing.
    return true;
  }
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
  menuOpen(false);
  signOut();
  localStorage.removeItem(KEY);   // a shared phone must not leave one user's history behind
  clearContent().catch(() => {}); // and must not leave the content behind either
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
/* The three-line menu. One corner, one tap, everything that used to live at
   the bottom of a long scroll: Settings first because it is why the menu
   exists, then the occasional actions, then the way out. */
const menuOpen = (on) => {
  if (on) $('menupractice').classList.toggle('hide', !tier2Here());
  $('menudrop').classList.toggle('hide', !on);
};
$('menuhome').onclick = () => { menuOpen(false); renderHome(); go('home'); };
$('menusettings').onclick = () => { menuOpen(false); paintSettings(); go('settings'); };
$('sugloadbtn').onclick = async () => {
  try {
    const rows = await rpc('master_list_suggestions') || [];
    $('suglist').innerHTML = rows.length ? rows.map((r) => `<div class="card stack">
        <div>${esc(r.body)}</div>
        <div class="mini">${esc(r.email)} &middot; ${String(r.created_at).slice(0, 10)} &middot; ${esc(r.status)}</div>
        <div class="row">
          <button class="small ghost" data-sug="${r.id}" data-set="planned">Planned</button>
          <button class="small ghost" data-sug="${r.id}" data-set="done">Done</button>
          <button class="small ghost" data-sug="${r.id}" data-set="declined">No</button>
          <button class="small ghost" data-sug="${r.id}" data-set="reply">Reply</button>
        </div>
      </div>`).join('') : '<div class="meta">The box is empty.</div>';
    $('suglist').querySelectorAll('[data-sug]').forEach((b) => {
      b.onclick = async () => {
        try {
          if (b.dataset.set === 'reply') {
            const text = prompt('Reply to the customer:');
            if (!text) return;
            await rpc('master_set_suggestion', { p_id: b.dataset.sug, p_status: 'planned', p_reply: text });
          } else {
            await rpc('master_set_suggestion', { p_id: b.dataset.sug, p_status: b.dataset.set });
          }
          $('sugloadbtn').onclick();
        } catch (e) { alert(e.message); }
      };
    });
  } catch (e) { $('suglist').innerHTML = `<div class="meta">${esc(e.message)}</div>`; }
};
$('pushbuild').onclick = async () => {
  $('pushbuild').disabled = true;
  $('pushmsg').textContent = 'Setting the floor...';
  try {
    // Same guarded write as the switches: a forbidden write comes back empty,
    // and empty is a refusal, not a success.
    const rows = await db('app_settings?id=eq.true', {
      method: 'PATCH', prefer: 'return=representation',
      body: { min_build: BUILD, updated_at: new Date().toISOString() },
    });
    if (!Array.isArray(rows) || !rows.length) throw new Error('Only the master account can push updates.');
    store.settings = { ...settings(), ...rows[0] };
    save();
    $('pushmsg').textContent = `Done. Every phone below build ${BUILD} reloads itself on its next open or sync.`;
  } catch (e) { $('pushmsg').textContent = e.message; }
  $('pushbuild').disabled = false;
};
$('menupractice').onclick = () => {
  menuOpen(false);
  renderPracticeCard();
  renderTestingCard();
  go('extras');
};
$('menustats').onclick = () => { menuOpen(false); renderStats(); go('stats'); };
$('menusuggest').onclick = () => { menuOpen(false); renderSuggestions(); go('suggest'); };
$('suggestback').onclick = () => { renderHome(); go('home'); };
$('suggestsend').onclick = async () => {
  const body = $('suggesttext').value.trim();
  if (body.length < 3) return ($('suggestmsg').textContent = 'Say a little more than that.');
  $('suggestsend').disabled = true;
  $('suggestmsg').textContent = 'Sending...';
  try {
    await db('suggestions', { method: 'POST', prefer: 'return=minimal',
      body: { user_id: currentUserId(), body } });
    $('suggesttext').value = '';
    $('suggestmsg').textContent = 'Sent. Answers show up on this screen.';
    renderSuggestions();
  } catch (e) {
    $('suggestmsg').textContent = navigator.onLine ? e.message
      : 'Needs a connection. Copy it and send again on signal.';
  }
  $('suggestsend').disabled = false;
};

const SUG_STATUS = { new: 'received', planned: 'planned', done: 'done', declined: 'not planned' };
async function renderSuggestions() {
  $('suggestmsg').textContent = '';
  try {
    const rows = await db('suggestions?select=body,created_at,status,reply&order=created_at.desc');
    $('suggestlist').innerHTML = (rows ?? []).map((r) => `<div class="card stack">
      <div>${esc(r.body)}</div>
      <div class="mini">${String(r.created_at).slice(0, 10)} &middot; ${esc(SUG_STATUS[r.status] ?? r.status)}</div>
      ${r.reply ? `<div class="meta">Reply: ${esc(r.reply)}</div>` : ''}
    </div>`).join('') || '<div class="meta">Nothing sent yet.</div>';
  } catch { $('suggestlist').innerHTML = ''; }
}
$('extrasback').onclick = () => { renderHome(); go('home'); };
$('menuresync').onclick = () => { menuOpen(false); sync(false); };
// A tap anywhere else closes it, the way small menus are expected to behave.
document.addEventListener('click', (e) => {
  if (!$('menudrop').classList.contains('hide')
      && !$('menudrop').contains(e.target) && e.target !== $('gear')) menuOpen(false);
});
$('statsback').onclick = () => { renderHome(); go('home'); };
$('readback').onclick = () => { renderHome(); go('home'); };
$('readtest').onclick = () => startSection(reading);
$('readpdf').onclick = () => openPdf();
$('start').onclick = () => start();
// Deliberately follows the normal sequence rather than repeating the last focus: after
// passing, "another session" should move you on, not park you on finished material.
$('again').onclick = () => start();
$('next').onclick = () => { S.i++; S.i >= S.questions.length ? finish() : renderQ(); };
// Practice controls. Done returns home with nothing recorded, which is the point.
$('pcheck').onclick = () => {
  const q = P.questions[P.i];
  settleP(blankRight($('pblank').value, q.accept),
    `Accepted: ${(q.accept ?? []).join(', ')}`, q);
};
$('pblank').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !$('pcheck').disabled) $('pcheck').onclick();
});
$('pnext').onclick = () => {
  P.i = (P.i + 1) % P.questions.length; // wraps: a drill has no natural end
  renderP();
};
$('pdone').onclick = () => { P = null; renderHome(); go('home'); };
// Pause keeps the session on the shelf. End scores what was answered and closes it.
$('pause').onclick = () => { keepSession(); renderHome(); go('home'); };
$('quit').onclick = () => (S.answered ? finish() : (store.open = null, save(), renderHome(), go('home')));
// The corner gear is reachable from every screen, so Back has to return to the
// one it was opened from. Sending someone back to the home screen mid-session
// would look exactly like their session had been thrown away.
$('gear').onclick = () => menuOpen($('menudrop').classList.contains('hide'));
$('setback').onclick = () => {
  const back = cameFrom === 'settings' ? 'home' : cameFrom;
  if (back === 'home') renderHome();
  go(back);
};
$('pwSave').onclick = () => changeMyPassword();
$('prefSpeak').onclick = function () { setSpeak(this.dataset.on !== 'true'); };
$('micToggle').onclick = function () { setSpeak(this.dataset.on !== 'true'); };
$('copylink').onclick = () => {
  const url = appLink();
  navigator.clipboard?.writeText(url)
    .then(() => { $('copymsg').textContent = 'Copied. Paste it to them.'; })
    .catch(() => { $('copymsg').textContent = 'Could not copy. The address is above.'; });
};
$('prefSimple').onclick = function () {
  const on = this.dataset.on !== 'true';
  this.dataset.on = String(on);
  setPref('simple', on);
  renderHome();
};
$('prefBoard').onclick = function () {
  const on = this.dataset.on !== 'true';
  this.dataset.on = String(on);
  setPref('leaderboard', on);
  renderHome();
};
$('prefNameSave').onclick = async () => {
  const name = $('prefName').value.trim();
  if (!name) return;
  try {
    const r = await rpc('set_display_name', { p_name: name });
    $('prefNameMsg').textContent = `You appear as ${r.name}.`;
    try { store.leaderboard = await rpc('leaderboard'); renderHome(); } catch { /* next sync */ }
  } catch (e) { $('prefNameMsg').textContent = e.message; }
};
$('prefPass').onchange = function () {
  const n = Math.min(100, Math.max(50, Number(this.value) || 90));
  this.value = n;
  setPref('passMark', n);
  renderHome();
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

/* The app tells on itself: an uncaught error becomes one row the master can
   read from the PC, so a broken build shows up in a table instead of an angry
   text. Hard-capped per session, and it must never be able to break anything
   itself, so every step is swallowed. */
let errorsSent = 0;
function reportError(message, stack) {
  try {
    if (errorsSent >= 3 || !signedIn() || !navigator.onLine) return;
    errorsSent++;
    db('client_errors', { method: 'POST', prefer: 'return=minimal',
      body: { user_id: currentUserId(), build: BUILD,
        message: String(message).slice(0, 500), stack: String(stack ?? '').slice(0, 2000),
        ua: navigator.userAgent.slice(0, 300) } }).catch(() => {});
  } catch { /* never let telemetry hurt the app */ }
}
window.addEventListener('error', (e) => reportError(e.message, e.error?.stack));
window.addEventListener('unhandledrejection', (e) => reportError(e.reason?.message ?? e.reason, e.reason?.stack));
sessionStorage.removeItem('policy-prep-recovered');

if (signedIn()) {
  claimThisDevice();   // no await: the server enforces regardless; this just explains
  go('home');
  // Paint once from whatever is already on the device, then again once the content
  // is back from IndexedDB, then the sync paints a third time with the server's copy.
  renderHome();
  loadContent().then(() => { applySettings(); renderHome(); });
  checkMaster();
  sync(true);
} else { go('auth'); }
window.addEventListener('online', () => sync(true));

/* Updates.
   An iPhone home-screen app resumes rather than reloads, so a fixed version can sit on
   the server for days while the phone keeps running the old one. This forces the issue:
   check for a new worker on every launch and on return to the foreground, and reload
   once the new one takes control. The guard stops a reload loop. */
/* Beta numbering until launch, at Anton's instruction: the number keeps
   climbing with every deploy (the update machinery needs each build to have a
   fresh name), but the customer-facing word is beta. Going live, this becomes
   'v1' and the beta counter retires. */
export const BUILD = 37;
export const APP_VERSION = `beta ${BUILD}`;

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
