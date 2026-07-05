# Phase H6 demo — the live interview loop — 2026-07-04

> HARDENING-PLAN Phase H6 DoD: `npm run check` green (293 tests) + this demo:
> a real transcript confirming a got-fixture bootstrap batch, with the summary
> line.

## What H6 fixed (review C1 — the biggest adoption gap)

Cold start hinges on a human confirming ~50 bootstrap proposals "in one
sitting" (SPEC §7.5). But before H6 the only ways to do that were:

- `cart interview answer <Q> --person … --confirm …` — a **full CLI invocation
  per proposal** (retype everything, 50 times), or
- `cart interview --apply answers.json` — **hand-author JSON** for every
  decision.

Every prior demo scripted around this — the tell that the UX contradicted its
own importance. H6 adds `cart interview --live`: one command, one keystroke per
proposal.

## The loop

```
cart interview --live --as <you>
```

For each pending proposal it prints a card (id, criticality, statement, area,
originating test, who drafted it) and reads one key:

```
[y]es confirm · [e]dit · [m]erge into · [d]iscard · [s]kip · [q]uit
```

- **y** — confirm as-is (the confirmation is the approval, I3)
- **e** — type a corrected statement (empty = keep), then confirm
- **m** — give a survivor `BHV-id`; an invalid/unconfirmed target is refused
  and the proposal skipped (never a bad merge)
- **d** — optional reason, then discard (retire, nothing deleted — I11)
- **s** / empty — skip (stays pending)
- **q** — stop

**Every decision is applied immediately** via `applyInterview` with a
single-item list, so quitting mid-way loses nothing already answered — the
confirm is durable the moment it's made.

## Real transcript (got fixtures, y / e+edit / d+reason / q)

```
$ cart bootstrap import testdata/real --apply --actor you    # → 55 proposals
$ cart interview --live --as you
55 proposal(s) awaiting your judgment. For each: [y]es confirm · [e]dit · [m]erge into · [d]iscard · [s]kip · [q]uit

BHV-0001  [normal]  Non-cacheable responses are not cached
      area: cache · from: test/cache.ts::non-cacheable responses are not cached · drafted by: import
  … > y      ✓ BHV-0001 confirmed

BHV-0002  [normal]  Cacheable responses are cached
      area: cache · from: test/cache.ts::cacheable responses are cached · drafted by: import
  … > e   new statement > Cacheable GET responses are cached      ✓ BHV-0002 confirmed

BHV-0003  [normal]  Cacheable responses to POST requests are cached
      area: cache · …
  … > d   reason > not a real behavior      ✗ BHV-0003 discarded

BHV-0004  [normal]  Non-cacheable responses to POST requests are not cached
  … > q

interview session by you: 2 confirmed, 0 merged, 1 discarded, 0 skipped · 52 still pending
```

Two confirmed (one edited), one discarded, quit before the rest — and the 52
untouched proposals are still pending for the next session.

## A note on the stdin plumbing

`node:readline/promises`' `question()` leaves later prompts unresolved after a
piped stdin reaches EOF (the loop would hang). The CLI instead drives off the
readline `line` event with a small queue that hands back a **quit sentinel on
close** — so a short script (`y\nq`) or a truncated pipe ends cleanly, and a
real TTY still prompts interactively. The loop logic itself
(`runInterviewLoop`) is IO-agnostic: it takes an injected
`{ ask, say }` and is unit-tested with scripted answers.

## The changes

- `src/interview-live.ts` — `runInterviewLoop(ledger, io, actor, clock)`,
  injected `InterviewIO`, immediate per-decision apply, `LiveSummary`.
- `src/cli.ts` — `cart interview --live --as <you>` (EOF-safe stdin queue);
  `--batch` output now points at `--live`; USAGE updated.
- `README.md` — quickstart confirm step is now `cart interview --live`.
- Tests: `interview-live.test.ts` (8 integration — every branch + durable
  quit + invalid merge), `cli.test.ts` +2 e2e (real piped stdin; `--as`
  required).

## DoD

`npm run check` green: typecheck + lint + **293 tests** (128 unit / 151
integration / 14 e2e) + schemas. The loop is proven both at the unit level
(scripted IO, every branch) and end-to-end against the spawned `bin/cart.mjs`
over real piped stdin. No test weakened.
