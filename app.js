import { buildSession, coverage, gate, SESSION_SIZE } from './engine.js';

/* Everything lives in this phone's localStorage. The hosted site ships the engine only,
   never any policy content: packs are loaded here by the owner. That is what makes it
   safe to host the app on a public URL while department material stays private. */

const KEY = 'policy-prep-v1';
const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove('hide');
const hide = (id) => $(id).classList.add('hide');
const screens = ['home', 'quiz', 'result', 'import'];
const go = (name) => { screens.forEach(hide); show(name); window.scrollTo(0, 0); };

const blank = () => ({
  index: { policies: [] },
  items: {},   // policyId -> items doc
  banks: {},   // policyId -> bank doc
  progress: { answers: [], sessions: [] },
});

let store = load();
let S = null;

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return blank();
    return { ...blank(), ...JSON.parse(raw) };
  } catch { return blank(); }
}
function save() { localStorage.setItem(KEY, JSON.stringify(store)); }

/* ------------------------------------------------------------------ home */

function renderHome() {
  const list = store.index.policies;
  $('homesub').textContent = list.length
    ? 'One policy at a time. 90 percent and no repeat misses to move on.'
    : 'Nothing loaded yet.';

  $('policies').innerHTML = list.length ? list.map((p) => {
    const items = store.items[p.id];
    const bank = store.banks[p.id];
    const c = coverage(items, bank);
    const g = gate(p.id, items, store.progress);
    const covClass = c.complete ? 'ok' : 'warn';
    const leech = g.leeches.length
      ? `<ul>${g.leeches.map((l) => `<li>${l.label} (missed ${l.wrong}x)</li>`).join('')}</ul>` : '';
    return `<div class="card">
      <div class="row" style="justify-content:space-between">
        <b>${esc(p.title)}</b>
        <span class="pill ${p.passed ? 'ok' : 'warn'}">${p.passed ? 'passed' : 'in focus'}</span>
      </div>
      <div class="row" style="margin-top:9px">
        <span class="pill ${covClass}">coverage ${c.covered}/${c.total}</span>
        <span class="pill">${bank?.questions?.length ?? 0} questions</span>
        <span class="pill">${g.bestPct === null ? 'no score yet' : 'best ' + g.bestPct + '%'}</span>
      </div>
      <div class="meta" style="margin-top:9px">${esc(g.reason)}</div>${leech}
    </div>`;
  }).join('') : `<div class="card"><b>No policies loaded.</b>
      <div class="meta" style="margin-top:6px">Tap below to load the pack Nomad sent you.</div></div>`;

  $('start').disabled = !list.length;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

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
    questionId: q.id, choice: n, correct,
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
    id: `s${Date.now()}`, at: Date.now(), currentId: S.currentId,
    currentCount: S.currentCount, asked: S.answered, right: S.right, pct,
  });

  const items = store.items[S.currentId];
  const g = gate(S.currentId, items, store.progress);
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
}

/* ---------------------------------------------------------------- import */

/** A pack is one file holding a policy, its items and its questions. Loading the same
    policy again replaces its content but never touches your answer history. */
function loadPack(text) {
  let pack;
  try { pack = JSON.parse(text); } catch { return msg('That is not valid JSON.'); }
  const { policy, items, bank } = pack;
  if (!policy?.id || !items?.items || !bank?.questions) {
    return msg('Pack is missing policy, items or bank.');
  }
  const existing = store.index.policies.find((p) => p.id === policy.id);
  if (existing) { existing.title = policy.title; }
  else { store.index.policies.push({ id: policy.id, title: policy.title, passed: false }); }

  store.items[policy.id] = items;
  store.banks[policy.id] = bank;
  save();
  renderHome();
  msg(`Loaded "${policy.title}": ${bank.questions.length} questions, ${items.items.length} items. Your scores were kept.`);
}

const msg = (t) => { $('importmsg').textContent = t; };

/* ----------------------------------------------------------------- wiring */

$('start').onclick = start;
$('again').onclick = start;
$('next').onclick = () => { S.i++; S.i >= S.questions.length ? finish() : renderQ(); };
$('quit').onclick = () => (S.answered ? finish() : go('home'));
$('home2').onclick = () => { renderHome(); go('home'); };
$('toimport').onclick = () => { msg(''); go('import'); };
$('backhome').onclick = () => { renderHome(); go('home'); };
$('loadpaste').onclick = () => loadPack($('paste').value);
$('file').onchange = (e) => {
  const f = e.target.files[0];
  if (!f) return;
  f.text().then(loadPack).catch(() => msg('Could not read that file.'));
};
$('wipe').onclick = () => {
  if (!confirm('Erase all policies and all your scores from this phone?')) return;
  localStorage.removeItem(KEY);
  store = blank();
  renderHome();
  msg('Erased.');
};

renderHome();
go('home');

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
