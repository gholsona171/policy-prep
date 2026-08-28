import { db, dbAll, currentUserId } from './supa.js';

/* Sync is one-way for content and two-way for progress.

   Content: the server is the only writer, so the phone just mirrors it.
   Progress: the phone records answers immediately whether online or not, queues them,
             and pushes on the next connection. The server is then treated as the truth
             and pulled back, so a second device or a reinstalled phone sees the same
             history. Nothing depends on being online at the moment you answer. */

/** The master's switches. Everyone reads them, only a master can change them,
    and the engine falls back to its own defaults if this ever comes back empty. */
export async function pullSettings(store) {
  const rows = await db('app_settings?select=*&limit=1');
  if (Array.isArray(rows) && rows[0]) store.settings = rows[0];
  return store.settings;
}

export async function pullContent(store) {
  // Every one of these is paged: see dbAll. Questions and items are both well
  // past the server's per-request cap, and a truncated pull is indistinguishable
  // from a policy whose bank was never written.
  const policies = await dbAll(
    'policies?select=id,title,sort_order,version,body_text,source_ref,track&order=sort_order');
  if (!policies) return false;

  const items = await dbAll('policy_items?select=policy_id,item_id,label,type,quote&order=policy_id,item_id');
  const questions = await dbAll('questions?select=id,policy_id,item_id,stem,choices,answer,why,cite,format,min_tier,accept,is_key,chain_id,chain_part&order=policy_id,id');

  // Passed flags are personal, so keep whatever we already knew and let pullProgress
  // correct it. Losing them here would silently re-lock a policy already cleared.
  const wasPassed = new Map(store.index.policies.map((p) => [p.id, p.passed]));
  /* body_text rides along with the policy list so the reading screen works with
     no signal, the same way the questions do. */
  store.index.policies = policies.map((p) => ({
    id: p.id, title: p.title, version: p.version, passed: wasPassed.get(p.id) ?? false,
    text: p.body_text ?? null, source: p.source_ref ?? null,
    track: p.track ?? 'po',
  }));

  store.items = {};
  store.banks = {};
  store.practice = {};
  const shape = (q) => ({
    id: q.id, itemId: q.item_id, policyId: q.policy_id, stem: q.stem,
    choices: q.choices, answer: q.answer, why: q.why, cite: q.cite,
    format: q.format ?? 'choice', minTier: q.min_tier ?? 1, accept: q.accept ?? null,
    key: q.is_key === true,
    chain: q.chain_id ?? null, part: q.chain_part ?? null,
  });
  for (const p of policies) {
    store.items[p.id] = {
      policyId: p.id,
      items: items.filter((i) => i.policy_id === p.id)
        .map((i) => ({ id: i.item_id, label: i.label, type: i.type, quote: i.quote })),
    };
    const mine = questions.filter((q) => q.policy_id === p.id);
    /* THE SPLIT IS THE RULE, NOT A CONVENIENCE. store.banks is what the study
       engine sees, and the engine is what decides a pass. Practice questions
       (min_tier 2 and up) go in their own drawer so the completion gate can
       never start demanding them and a session can never contain them. What a
       tier-1 phone receives is already filtered by the server; this filter is
       about keeping paid extras out of everyone's PASS RULES, not out of view. */
    store.banks[p.id] = {
      policyId: p.id,
      questions: mine.filter((q) => (q.min_tier ?? 1) <= 1).map(shape),
    };
    const extra = mine.filter((q) => (q.min_tier ?? 1) > 1).map(shape);
    if (extra.length) store.practice[p.id] = { policyId: p.id, questions: extra };
  }
  return true;
}

export async function pushProgress(store) {
  const uid = currentUserId();
  if (!uid) return;

  const pendingA = store.progress.answers.filter((a) => !a.synced);
  if (pendingA.length) {
    await db('answers', {
      method: 'POST',
      prefer: 'return=minimal',
      body: pendingA.map((a) => ({
        user_id: uid, policy_id: a.policyId, item_id: a.itemId,
        question_id: a.questionId, choice: a.choice, correct: a.correct,
        at: new Date(a.at).toISOString(),
      })),
    });
    pendingA.forEach((a) => { a.synced = true; });
  }

  const pendingS = store.progress.sessions.filter((s) => !s.synced);
  if (pendingS.length) {
    await db('sessions', {
      method: 'POST',
      prefer: 'return=minimal,resolution=merge-duplicates',
      body: pendingS.map((s) => ({
        id: s.id, user_id: uid, policy_id: s.currentId,
        current_count: s.currentCount, asked: s.asked, correct: s.right, pct: s.pct,
        at: new Date(s.at).toISOString(),
      })),
    });
    pendingS.forEach((s) => { s.synced = true; });
  }

  const passed = store.index.policies.filter((p) => p.passed);
  if (passed.length) {
    await db('policy_state', {
      method: 'POST',
      prefer: 'return=minimal,resolution=merge-duplicates',
      body: passed.map((p) => ({
        user_id: uid, policy_id: p.id, passed: true,
        passed_at: new Date(p.passedAt ?? Date.now()).toISOString(),
        pass_pct: p.passedPct ?? null, pass_mark: p.passedMark ?? null,
        pass_simple: p.passedSimple === true,
      })),
    });
  }
}

/* Progress pulls are DELTA with two safety devices, replacing the old model
   that re-downloaded the whole history (a megabyte and growing) on every open.

   One cheap sync_state() call returns the user's EPOCH and row COUNTS.
   - The epoch moves when reset_my_progress runs, so a wiped history can never
     leave ghost answers on a phone that raced past the reset.
   - The counts are the tripwire: after the delta lands, local totals must
     equal the server's. Any disagreement - an evicted localStorage, a write
     the phone missed, a bug of ours - triggers one old-style full pull and
     the phone heals on the spot. Likely rare; guaranteed cheap.

   The device lock is what makes deltas safe at all: one device holds the
   slot, so there is exactly one writer, and a NEW device starts empty and
   full-pulls naturally. */

const mapAnswers = (rows) => rows.map((a) => ({
  at: Date.parse(a.at), policyId: a.policy_id, itemId: a.item_id,
  questionId: a.question_id, choice: a.choice, correct: a.correct, synced: true,
}));
const mapSessions = (rows) => rows.map((s) => ({
  id: s.id, at: Date.parse(s.at), currentId: s.policy_id,
  currentCount: s.current_count, asked: s.asked, right: s.correct, pct: s.pct, synced: true,
}));

async function fullProgressPull(store) {
  const answers = await dbAll('answers?select=policy_id,item_id,question_id,choice,correct,at&order=at');
  const sessions = await dbAll('sessions?select=id,policy_id,current_count,asked,correct,pct,at&order=at');
  if (!answers || !sessions) return false;
  store.progress.answers = mapAnswers(answers);
  store.progress.sessions = mapSessions(sessions);
  return true;
}

export async function pullProgress(store) {
  let state = null;
  try {
    const { rpc } = await import('./supa.js');
    state = await rpc('sync_state');
  } catch { /* an old server or a blip: fall through to the full pull */ }

  const epochMoved = state && state.epoch !== (store.progressEpoch ?? 0);
  let pulled = false;

  if (!state || epochMoved || !store.progress.answers.length) {
    pulled = await fullProgressPull(store);
  } else {
    // Delta: only rows newer than the newest thing this phone has. The phone's
    // own pushes come back too; the composite key keeps them from doubling.
    const newest = Math.max(0, ...store.progress.answers.map((a) => a.at),
      ...store.progress.sessions.map((x) => x.at));
    const since = new Date(newest).toISOString();
    const answers = await dbAll(`answers?select=policy_id,item_id,question_id,choice,correct,at&at=gt.${since}&order=at`);
    const sessions = await dbAll(`sessions?select=id,policy_id,current_count,asked,correct,pct,at&at=gt.${since}&order=at`);
    if (Array.isArray(answers) && Array.isArray(sessions)) {
      const haveA = new Set(store.progress.answers.map((a) => `${a.questionId}|${a.at}`));
      for (const a of mapAnswers(answers)) {
        if (!haveA.has(`${a.questionId}|${a.at}`)) store.progress.answers.push(a);
      }
      const haveS = new Set(store.progress.sessions.map((x) => x.id));
      for (const x of mapSessions(sessions)) if (!haveS.has(x.id)) store.progress.sessions.push(x);
      pulled = true;
    }
  }

  // The tripwire. Counting local rows costs nothing; disagreeing with the
  // server means something was missed somewhere, and the cure is the old
  // brute-force pull, once, right now.
  if (state && pulled) {
    const okA = store.progress.answers.filter((a) => a.synced).length === state.answers;
    const okS = store.progress.sessions.filter((x) => x.synced).length === state.sessions;
    if (!okA || !okS) await fullProgressPull(store);
    store.progressEpoch = state.epoch;
  }

  const states = await dbAll('policy_state?select=policy_id,passed,passed_at,pass_pct,pass_mark,pass_simple&order=policy_id');

  // Both directions. Setting passed only when the server says so meant a policy
  // could never become un-passed, so wiping your history left every policy
  // still unlocked and the app claiming work you no longer had a record of.
  const byId = new Map((states ?? []).filter((s) => s.passed).map((s) => [s.policy_id, s]));
  store.index.policies.forEach((p) => {
    const st = byId.get(p.id);
    p.passed = !!st;
    p.passedPct = st?.pass_pct ?? p.passedPct ?? null;
    p.passedMark = st?.pass_mark ?? p.passedMark ?? null;
    p.passedSimple = st?.pass_simple ?? p.passedSimple ?? false;
  });
}

/** One round trip: send what is queued, then take the server's version of
    what has actually changed.

    Content is about 6.5 MB and used to be re-downloaded on every single sync,
    which at a handful of daily customers would have walked straight through
    the hosting bandwidth allowance. The settings row now carries content_rev,
    bumped by every publish, and content moves only when that number does.
    Settings and progress are small and stay always-synced. */
export async function syncAll(store) {
  await pushProgress(store);
  let rev = null;
  try {
    await pullSettings(store);
    rev = Number(store.settings?.content_rev) || null;
  } catch { /* keep whatever we had */ }
  const have = Number(store.contentRev) || 0;
  const empty = !store.index.policies.length;
  // No rev (old server, failed settings pull) means pull, because stale
  // content is worse than a large download. A matching rev means skip.
  if (empty || rev === null || rev !== have) {
    const ok = await pullContent(store);
    if (ok && rev !== null) store.contentRev = rev;
  }
  await pullProgress(store);
}
