/* Selection, scoring and the unlock gate. Same rules as the desktop server, rewritten
   for the browser so the phone app works with no server and no signal.

   Deliberately dependency free and deterministic: nothing here calls a model, so a
   session can never be steered by something decided in the moment. */

/* The numbers the master account can move, and what they were before anyone
   could move them. Held in one mutable object rather than as constants so the
   settings pulled from the server can replace them at startup without every
   function having to take five more arguments. */
export const CONFIG = {
  MIX_CURRENT: 0.8,          // share of a session spent on the policy in focus
  SESSION_SIZE: 40,
  LEECH_THRESHOLD: 2,        // misses before an item is treated as a leech
  PASS_PCT: 90,
  MIN_CURRENT_IN_GATE: 30,   // questions a session needs before it can count
};

/** Applies saved settings. Anything missing keeps the built-in default, so a
    half-filled row or an old app can never produce a nonsense session. */
export function setConfig(s) {
  if (!s) return CONFIG;
  const num = (v, lo, hi, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= lo && n <= hi ? n : fallback;
  };
  CONFIG.SESSION_SIZE = num(s.session_size, 5, 200, CONFIG.SESSION_SIZE);
  CONFIG.PASS_PCT = num(s.pass_pct, 50, 100, CONFIG.PASS_PCT);
  CONFIG.MIX_CURRENT = num(s.mix_current, 0, 100, CONFIG.MIX_CURRENT * 100) / 100;
  CONFIG.LEECH_THRESHOLD = num(s.leech_threshold, 1, 10, CONFIG.LEECH_THRESHOLD);
  CONFIG.MIN_CURRENT_IN_GATE = num(s.min_current_in_gate, 1, 200, CONFIG.MIN_CURRENT_IN_GATE);
  return CONFIG;
}

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

/**
 * @param focusId  optional: revisit a policy you have ALREADY PASSED.
 *
 * Deliberately refuses to focus a policy that has not been passed. The sequence is the
 * point of the system: you work one policy until it is cleared, and you cannot skip
 * ahead to a later one because it looks easier or more interesting. Revision of
 * finished material is allowed; jumping the queue is not.
 */
export function buildSession(store, seed = Date.now(), size = CONFIG.SESSION_SIZE, focusId = null) {
  const policies = store.index.policies;
  const requested = focusId ? policies.find((p) => p.id === focusId) : null;
  const current = (requested && requested.passed ? requested : null)
    ?? policies.find((p) => !p.passed)
    ?? policies[policies.length - 1];
  if (!current) return { questions: [], currentId: null, currentCount: 0 };

  const passedIds = policies.filter((p) => p.passed && p.id !== current.id).map((p) => p.id);
  const currentPool = rank(store.banks[current.id]?.questions ?? [], store.progress, seed);
  const reviewPool = rank(passedIds.flatMap((id) => store.banks[id]?.questions ?? []), store.progress, seed + 1);

  const wantReview = passedIds.length ? Math.round(size * (1 - CONFIG.MIX_CURRENT)) : 0;
  const review = reviewPool.slice(0, wantReview);
  const cur = currentPool.slice(0, size - review.length);

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
 * How many questions from a policy a session must contain before its score counts.
 *
 * A flat 30 would make any policy with a smaller bank impossible to pass, which is a
 * real case: some real policies are two pages. So the requirement scales down to 80% of
 * whatever bank exists, and 30 is only the ceiling.
 */
export function requiredForGate(bank) {
  const size = bank?.questions?.length ?? 0;
  return Math.min(CONFIG.MIN_CURRENT_IN_GATE, Math.max(1, Math.ceil(size * 0.8)));
}

/** How many of a policy's questions have been answered at least once. */
export function questionCoverage(policyId, progress, bank) {
  const all = bank?.questions ?? [];
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
export function gate(policyId, items, progress, bank) {
  const need = requiredForGate(bank);
  const best = progress.sessions
    .filter((s) => s.currentId === policyId && s.currentCount >= need)
    .reduce((b, s) => (!b || s.pct > b.pct ? s : b), null);

  const outstanding = leeches(items, progress);
  const cov = questionCoverage(policyId, progress, bank);
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
      ? `No qualifying session yet (needs ${need}+ questions from this policy).`
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
