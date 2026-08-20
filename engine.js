/* Selection, scoring and the unlock gate. Same rules as the desktop server, rewritten
   for the browser so the phone app works with no server and no signal.

   Deliberately dependency free and deterministic: nothing here calls a model, so a
   session can never be steered by something decided in the moment. */

export const MIX_CURRENT = 0.8;
export const SESSION_SIZE = 40;
export const LEECH_THRESHOLD = 2;
export const PASS_PCT = 90;
export const MIN_CURRENT_IN_GATE = 30;

export function itemStats(progress, itemId) {
  const answers = progress.answers.filter((a) => a.itemId === itemId);
  if (!answers.length) return { seen: 0, wrong: 0, resolved: false, lastAt: 0, leech: false };
  const wrong = answers.filter((a) => !a.correct).length;
  const last = answers[answers.length - 1];
  return {
    seen: answers.length, wrong, resolved: last.correct, lastAt: last.at,
    leech: wrong >= LEECH_THRESHOLD && !last.correct,
  };
}

/** Unseen first, then repeat misses, then anything still wrong, then stale. */
function priority(s) {
  if (s.seen === 0) return 0;
  if (s.leech) return 1;
  if (!s.resolved) return 2;
  return 3;
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
  return shuffle(questions, seed)
    .map((q) => ({ q, s: itemStats(progress, q.itemId) }))
    .sort((x, y) => priority(x.s) - priority(y.s) || x.s.lastAt - y.s.lastAt)
    .map((r) => r.q);
}

export function buildSession(store, seed = Date.now(), size = SESSION_SIZE) {
  const policies = store.index.policies;
  const current = policies.find((p) => !p.passed) ?? policies[policies.length - 1];
  if (!current) return { questions: [], currentId: null, currentCount: 0 };

  const passedIds = policies.filter((p) => p.passed && p.id !== current.id).map((p) => p.id);
  const currentPool = rank(store.banks[current.id]?.questions ?? [], store.progress, seed);
  const reviewPool = rank(passedIds.flatMap((id) => store.banks[id]?.questions ?? []), store.progress, seed + 1);

  const wantReview = passedIds.length ? Math.round(size * (1 - MIX_CURRENT)) : 0;
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

/** Two conditions on purpose: a percentage alone can be cleared while still carrying a
    handful of facts you reliably get wrong, and those are what cost exam points. */
export function gate(policyId, items, progress) {
  const best = progress.sessions
    .filter((s) => s.currentId === policyId && s.currentCount >= MIN_CURRENT_IN_GATE)
    .reduce((b, s) => (!b || s.pct > b.pct ? s : b), null);

  const outstanding = leeches(items, progress);
  const scoreOk = !!best && best.pct >= PASS_PCT;

  return {
    passed: scoreOk && outstanding.length === 0,
    bestPct: best ? best.pct : null,
    scoreOk,
    leeches: outstanding,
    reason: !best
      ? `No qualifying session yet (needs ${MIN_CURRENT_IN_GATE}+ questions from this policy).`
      : !scoreOk ? `Best qualifying session is ${best.pct}%, needs ${PASS_PCT}%.`
      : outstanding.length ? `${outstanding.length} item(s) still wrong after ${LEECH_THRESHOLD}+ misses.`
      : 'Passed.',
  };
}
