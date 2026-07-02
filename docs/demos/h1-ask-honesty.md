# Phase H1 demo — ask-surface honesty — 2026-07-02

> HARDENING-PLAN Phase H1 DoD: `npm run check` green (264 tests) + this demo:
> before/after of the discarded-proposal probe (A1) and the rank-6-FAILING
> probe (A8). Also lands in this phase: the project-wide `VIOLATED → FAILING`
> rename (a friendlier verdict word for the portfolio audience).

## What H1 fixed

Two honesty defects the critical review confirmed in `cart ask`:

- **A1 — discarded proposals resurfaced.** `QueryApi.searchBehaviors`
  (`src/query.ts`) scored *all* behaviors, including ones a human explicitly
  discarded in the interview (status `retired`). `ask` then rendered them as
  `[unconfirmed proposal — confirm via interview]` — inviting you to confirm
  the very thing you just rejected, undermining the interview's authority (I3).
- **A8 — a FAILING behavior could hide below the row cut.** `assembleAsk`
  (`src/ask.ts`) sliced the matches to `MAX_ROWS = 5` *before* computing
  verdicts and applying the "FAILING leads, always" sort. A failing behavior
  ranked 6th by token overlap was silently dropped — the opposite of the
  headline guarantee.

## The rename: VIOLATED → FAILING

`VIOLATED` was the harshest of the five verdict states and reads badly to a
non-author looking at the tool. Renamed project-wide to **FAILING** — standard
testing vocabulary that pairs cleanly with `VERIFIED`. It is a *computed*
runtime state, never persisted to any schema or example JSON, so there was no
data migration: a pure code + docs rename across 25 files, `npm run check`
green with zero behavioral change.

```
VERIFIED  — evidence confirms it
FAILING   — newest evidence shows it broken   (was VIOLATED)
STALE     — evidence too old to trust
ASSERTED  — claimed, no evidence yet
UNKNOWN   — not covered
```

## A1 — before / after (discarded proposal)

Seed carries `BHV-0003 "Coupon codes are case-insensitive"` as an unconfirmed
proposal, then discard it in the interview:

```
applyInterview(ledger, 'ana', [{ behaviorId: 'BHV-0003',
  decision: { kind: 'discard', reason: 'not a real rule' } }])
```

**Before H1** — `cart ask "are coupon codes case-insensitive?"`:

```
BHV-0003 "Coupon codes are case-insensitive" [unconfirmed proposal — confirm via interview before it counts]
```

The proposal you discarded is back, asking to be confirmed.

**After H1** — same question: `BHV-0003` appears in neither `rows`, nor
`unconfirmedMatches`, nor the rendered output. Retired records are filtered out
of `searchBehaviors` at the source, so every read surface inherits the fix.

Regression: `H1.1: a discarded proposal never resurfaces in search or ask (I3)`
in `src/test/integration/ask.test.ts` — asserts absence from search, rows,
unconfirmed matches, and rendered text.

## A8 — before / after (FAILING below the cut)

Seed: 7 confirmed behaviors all matching the token `coupon` (so all tie at
score 1.0, broken by id order); only `BHV-0007` — which sorts *last*, at
rank 7, past the 5-row cut — carries violating evidence.

**Before H1** (slice-before-sort), the regression test fails because the
FAILING row was cut before the sort could promote it:

```
not ok 1 - H1.2: a FAILING behavior below the row cut still leads (sort precedes cut)
# pass 0
# fail 1
```

**After H1** (sort-before-slice), `BHV-0007` leads:

```
ok 1 - H1.2: a FAILING behavior below the row cut still leads (sort precedes cut)
```

`result.rows[0].behavior.id === 'BHV-0007'`, `verdict.state === 'FAILING'`,
and `rows.length <= 5` (the cap is preserved — we now cut *after* the sort).
This before/after was produced by temporarily restoring the old
`.slice(0, MAX_ROWS)` on the search call and re-running the test, confirming
the regression has teeth.

## The changes

- `src/query.ts` — `searchBehaviors` filters to `status === 'active'` before
  scoring.
- `src/ask.ts` — `assembleAsk` builds rows for every confirmed match, sorts
  (FAILING-first, then relevance), *then* slices to `MAX_ROWS`;
  `unconfirmedMatches` capped separately.
- `src/test/integration/ask.test.ts` — `H1.1` and `H1.2` regressions
  (+ the file's existing FAILING references updated by the rename).
- 25 files: `VIOLATED → FAILING`.

## DoD

`npm run check` green: typecheck + lint + **264 tests** (117 unit / 135
integration / 12 e2e) + schema validation. No test weakened; two added; the
A8 test verified to fail against the pre-fix code.
