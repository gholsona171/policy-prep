# Policy Prep

A small offline study app for promotion-exam policy work: one policy at a time,
90 percent and no repeat misses to move on.

**This repository contains the app only. It contains no policy content and never will.**
Policy content lives in a Supabase database behind sign-in and row-level security, and is
copied to the phone so it works with no signal.

Install it by opening the page on a phone and using Add to Home Screen.

## How it works

- **Accounts:** people sign in with email and password. An administrator ("master") manages
  accounts and devices; each account is tied to one phone, and a revoked phone is cleared.
- **Content** (policies, items, questions) syncs one way: the server is the only writer and the
  phone keeps a full copy in IndexedDB, so study works offline.
- **Progress** syncs both ways. Answers are saved on the phone first, queued, and pushed on the
  next connection; the server copy is then pulled back so a second device sees the same history.
- **Access** is decided by row-level security in the database. The key in `config.js` is the
  public anon key and grants nothing by itself.

## Why I built it this way

**The problem.** People studying for a promotion exam need to learn a large set of policies, often
on a phone and in short gaps, sometimes with no signal.

**Trade-offs I made:**

- **Offline first.** Everything needed to study is on the phone. The cost is sync logic: progress
  pulls are incremental, and two safety checks (a reset counter and a record-count check) force a
  full re-pull when the phone's copy can't be trusted, so it never quietly shows a partial bank.
- **No build step.** Plain JavaScript modules and a service worker, so updating is a push to
  GitHub Pages. Phones below the minimum version reload themselves.
- **Content stays out of the repo.** The code is public; the policy material is not. It is only
  served to signed-in accounts.

**What I'd change next:**

- Add automated tests for the study engine and the sync rules. Today they are checked by hand.
- Split `app.js` (about 1,750 lines) into smaller screens.
- Keep the database schema and access rules in this repo so they are reviewed with the code.

I build with AI coding tools; I review the code and check the behavior on a phone before
anything ships.
