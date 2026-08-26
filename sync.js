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
    'policies?select=id,title,sort_order,version,body_text,source_ref&order=sort_order');
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
      })),
    });
  }
}

export async function pullProgress(store) {
  // Also paged: someone working through 6603 questions passes a thousand answers
  // in their first serious week, and a truncated history quietly rewrites their
  // accuracy and can un-pass a policy they cleared.
  const answers = await dbAll('answers?select=policy_id,item_id,question_id,choice,correct,at&order=at');
  const sessions = await dbAll('sessions?select=id,policy_id,current_count,asked,correct,pct,at&order=at');
  const states = await dbAll('policy_state?select=policy_id,passed,passed_at,pass_pct,pass_mark&order=policy_id');
  if (!answers || !sessions) return;

  store.progress.answers = answers.map((a) => ({
    at: Date.parse(a.at), policyId: a.policy_id, itemId: a.item_id,
    questionId: a.question_id, choice: a.choice, correct: a.correct, synced: true,
  }));
  store.progress.sessions = sessions.map((s) => ({
    id: s.id, at: Date.parse(s.at), currentId: s.policy_id,
    currentCount: s.current_count, asked: s.asked, right: s.correct, pct: s.pct, synced: true,
  }));

  // Both directions. Setting passed only when the server says so meant a policy
  // could never become un-passed, so wiping your history left every policy
  // still unlocked and the app claiming work you no longer had a record of.
  const byId = new Map((states ?? []).filter((s) => s.passed).map((s) => [s.policy_id, s]));
  store.index.policies.forEach((p) => {
    const st = byId.get(p.id);
    p.passed = !!st;
    p.passedPct = st?.pass_pct ?? p.passedPct ?? null;
    p.passedMark = st?.pass_mark ?? p.passedMark ?? null;
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
