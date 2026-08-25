/* Selection, scoring and the unlock gate. Same rules as the desktop server, rewritten
   for the browser so the phone app works with no server and no signal.

   Deliberately dependency free and deterministic: nothing here calls a model, so a
   session can never be steered by something decided in the moment. */

/* THESE ARE NOT SETTINGS AND MUST NOT BECOME SETTINGS AGAIN.
   They were briefly adjustable from the master profile. That was a mistake and was
   removed on 21 Aug 2026 at Anton's instruction. A dial that changes how a pass is
   earned is not a preference: moved by accident, it silently rewrites what "cleared"
   means, and every session already recorded under the old number keeps counting as
   though nothing changed. There is no way to notice that from inside the app.

   The size of a session is not here either, because it is not a number anyone picks.
   A session is the whole policy: see sessionSize(). */
export const CONFIG = {
  MIX_CURRENT: 0.8,          // share of a session spent on the policy in focus
  LEECH_THRESHOLD: 2,        // misses before an item is treated as a leech
  PASS_PCT: 90,
};

export function itemStats(progress, itemId) {
  const answers = progress.answers.filter((a) => a.itemId === itemId);
  if (!answers.length) return { seen: 0, wrong: 0, resolved: false, lastAt: 0, leech: false };
  const wrong = answers.filter((a) => !a.correct).length;
  const last = answers[answers.length - 1];
  return {
    seen: answers.length, wrong, resolved: last.correct, lastAt: last.at,
    leech: wrong >= CONFIG.LEECH_THRESHOLD && !last.correct,
  };
}

/** A question you have never been asked comes first, because clearing a policy
    now requires answering every question in it. After that: repeat misses,
    then anything still wrong, then whatever is stalest. */
function priority(s, questionSeen) {
  if (!questionSeen) return s.seen === 0 ? 0 : 1;
  if (s.leech) return 2;
  if (!s.resolved) return 3;
  return 4;
}

function shuffle(arr, seed) {
  const a = arr.slice();
  let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function rank(questions, progress, seed) {
  const asked = new Set(progress.answers.map((a) => a.questionId));
  return shuffle(questions, seed)
    .map((q) => ({ q, s: itemStats(progress, q.itemId), seen: asked.has(q.id) }))
    .sort((x, y) => priority(x.s, x.seen) - priority(y.s, y.seen) || x.s.lastAt - y.s.lastAt)
    .map((r) => r.q);
}

/* Simple mode, added 25 Aug 2026 at Anton's explicit instruction, and he chose
   it knowing it reverses the 20 Aug whole-bank rule FOR THIS MODE ONLY: with
   simple on, a session is the section's key questions and the section can be
   cleared on them. The key set is data (is_key, chosen at import: numbers and
   time limits first), never a number anyone dials. With simple off, nothing
   below behaves any differently than before.

   A bank with no key questions falls back to the whole bank rather than to an
   empty session, so old content can never brick the course. */
export function lens(bank, simple) {
  const qs = bank?.questions ?? [];
  if (!simple) return qs;
  const key = qs.filter((q) => q.key === true);
  return key.length ? key : qs;
}

/** A session is every question in the policy (the key ones, in simple mode),
    so finishing one covers the section. Derived from the bank at build time,
    never configured. */
export function sessionSize(bank, simple = false) {
  return lens(bank, simple).length;
}

/**
 * @param focusId  optional: revisit a policy you have ALREADY PASSED.
 *
 * Deliberately refuses to focus a policy that has not been passed. The sequence is the
 * point of the system: you work one policy until it is cleared, and you cannot skip
 * ahead to a later one because it looks easier or more interesting. Revision of
 * finished material is allowed; jumping the queue is not.
 */
export function buildSession(store, seed = Date.now(), focusId = null,
  { allowUnpassed = false, simple = false } = {}) {
  const policies = store.index.policies;
  const requested = focusId ? policies.find((p) => p.id === focusId) : null;
  // allowUnpassed is the personal "let me pick any section" switch. The sequence
  // is still the default, because working one policy until it is clear is the
  // point of the system; but somebody revising one specific area for a specific
  // reason should not have to grind through everything before it.
  // A policy with no questions yet is readable but cannot be tested, so it must
  // never become the one in focus: if it did, it would block everything behind
  // it forever and the course would simply stop.
  const testable = (p) => lens(store.banks[p.id], simple).length > 0;
  const current = (requested && (requested.passed || allowUnpassed) ? requested : null)
    ?? policies.find((p) => !p.passed && testable(p))
    ?? policies.filter(testable).slice(-1)[0];
  if (!current) return { questions: [], currentId: null, currentCount: 0 };

  const passedIds = policies.filter((p) => p.passed && p.id !== current.id).map((p) => p.id);
  const currentPool = rank(lens(store.banks[current.id], simple), store.progress, seed);
  const reviewPool = rank(passedIds.flatMap((id) => lens(store.banks[id], simple)), store.progress, seed + 1);

  /* The whole current policy, then review on top in the same 80/20 proportion as
     before. Review rides on top rather than eating into the section, because taking
     its place would mean a session no longer covers the policy and the whole point
     of one sitting per section would be lost. */
  const cur = currentPool;
  const wantReview = passedIds.length
    ? Math.round((cur.length * (1 - CONFIG.MIX_CURRENT)) / CONFIG.MIX_CURRENT) : 0;
  const review = reviewPool.slice(0, wantReview);

  return {
    questions: shuffle(cur.concat(review), seed + 2),
    currentId: current.id,
    currentCount: cur.length,
  };
}

export function coverage(items, bank) {
  const covered = new Set((bank?.questions ?? []).map((q) => q.itemId));
  const list = items?.items ?? [];
  const hit = list.filter((i) => covered.has(i.id)).length;
  return { total: list.length, covered: hit, complete: list.length > 0 && hit === list.length };
}

export function leeches(items, progress) {
  return (items?.items ?? [])
    .map((i) => ({ item: i, s: itemStats(progress, i.id) }))
    .filter((r) => r.s.leech)
    .map((r) => ({ id: r.item.id, label: r.item.label, wrong: r.s.wrong }));
}

/**
 * How many questions from a policy a session must contain before its score counts:
 * all of them.
 *
 * This used to be a sample, thirty by default and adjustable. Both are gone. A score
 * on thirty of fifty seven questions says nothing about the twenty seven never asked,
 * and a sample size anyone can lower is a pass mark anyone can lower. Since a session
 * is now the whole policy, clearing one is a single honest sitting.
 */
export function requiredForGate(bank, simple = false) {
  return Math.max(1, sessionSize(bank, simple));
}

/** How many of a policy's questions have been answered at least once. */
export function questionCoverage(policyId, progress, bank, simple = false) {
  const all = lens(bank, simple);
  const seen = new Set(progress.answers.filter((a) => a.policyId === policyId).map((a) => a.questionId));
  const done = all.filter((q) => seen.has(q.id)).length;
  return { total: all.length, done, complete: all.length > 0 && done === all.length };
}

/** Three conditions, and the first one is not negotiable.
 *
 * The whole section has to be answered. Not a qualifying sample of it, all of
 * it: a score on thirty of fifty seven questions says nothing about the
 * twenty seven that were never asked, and those are exactly where an exam finds
 * you out. On top of that the best qualifying session must clear the pass mark,
 * and nothing may still be wrong after repeated misses, because a percentage
 * alone can be cleared while carrying a handful of facts you reliably get wrong.
 */
export function gate(policyId, items, progress, bank, simple = false) {
  const need = requiredForGate(bank, simple);
  const best = progress.sessions
    .filter((s) => s.currentId === policyId && s.currentCount >= need)
    .reduce((b, s) => (!b || s.pct > b.pct ? s : b), null);

  const outstanding = leeches(items, progress);
  const cov = questionCoverage(policyId, progress, bank, simple);
  const scoreOk = !!best && best.pct >= CONFIG.PASS_PCT;

  return {
    passed: cov.complete && scoreOk && outstanding.length === 0,
    bestPct: best ? best.pct : null,
    scoreOk,
    need,
    coverage: cov,
    leeches: outstanding,
    reason: !cov.complete
      ? `${cov.total - cov.done} of ${cov.total} questions in this policy still unanswered.`
      : !best
      ? `No complete sitting yet. A qualifying session is all ${need} questions in one go.`
      : !scoreOk ? `Best qualifying session is ${best.pct}%, needs ${CONFIG.PASS_PCT}%.`
      : outstanding.length ? `${outstanding.length} item(s) still wrong after ${CONFIG.LEECH_THRESHOLD}+ misses.`
      : 'Passed.',
  };
}

/** Everything the home screen and the stats screen want to show about one policy. */
export function policyStats(policyId, items, bank, progress) {
  const answers = progress.answers.filter((a) => a.policyId === policyId);
  const sessions = progress.sessions.filter((s) => s.currentId === policyId);
  const right = answers.filter((a) => a.correct).length;
  const list = items?.items ?? [];

  const seen = new Set(answers.map((a) => a.itemId));
  const mastered = list.filter((i) => {
    const s = itemStats(progress, i.id);
    return s.seen > 0 && s.resolved;
  }).length;

  return {
    answered: answers.length,
    right,
    accuracy: answers.length ? Math.round((right / answers.length) * 100) : null,
    sessions: sessions.length,
    lastPct: sessions.length ? sessions[sessions.length - 1].pct : null,
    itemsTotal: list.length,
    itemsSeen: list.filter((i) => seen.has(i.id)).length,
    itemsMastered: mastered,
  };
}
