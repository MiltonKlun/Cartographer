# Phase 4 demo — 2026-06-11

> BUILD-PLAN Phase 4 DoD: `npm run check` green (typecheck + lint + 126
> tests + validate:schemas) + this demo: cold-start a real repo to ≥50
> confirmed behaviors in one sitting.

The "real repo" here is Cartographer's own test suite — the most honest
target available (and it exercises the red-domain guesser on permission /
data-integrity test titles).

## Transcript

```
> cart bootstrap import .
scanned 16 test file(s) → 119 behavior proposal(s) (all unconfirmed)
criticality guesses: normal 93 · red 22 · high 4
  BHV-0001  [normal] Mapped area: cited rows with verdicts; FAILING leads  (ask)
  …and 107 more
preview only — re-run with --apply …

> cart bootstrap import . --apply --actor erick
wrote 119 unconfirmed proposal(s). Next: cart interview --batch 20

> cart interview --batch 5
5 proposal(s) awaiting your judgment (why: each was drafted from a test, unconfirmed):
  BHV-0001  [normal] Mapped area: cited rows with verdicts; FAILING leads
        area: ask · from: src/ask.test.ts::mapped area: …
  …

# decisions written to answers.json (50 confirm, 1 confirm+edit, 1 merge, 1 discard)
> cart interview --apply answers.json --person erick
interview applied by erick: 50 confirmed, 1 merged, 1 discarded
  ✓ BHV-0001 confirmed
  ⇒ BHV-0002 merged into BHV-0001
  ✗ BHV-0005 discarded

> cart status
records: 119 behaviors (50 confirmed) · 0 evidence · 0 open questions · 0 receipts
verdicts: VERIFIED 0 · STALE 0 · ASSERTED 50 · UNKNOWN 67 · FAILING 0
```

**≥50 confirmed in one sitting: met (exactly 50).** The histogram is the
honest cold-start picture: 50 confirmed-but-unevidenced behaviors are
`ASSERTED` (intent recorded, no evidence yet); the 67 still-unconfirmed
proposals stay `UNKNOWN`. Wiring `ingest:playwright-json` into CI (SPEC §11
step 3) is what turns ASSERTED into VERIFIED.

`cart ask` flips from honest UNKNOWN to an ASSERTED answer the moment the
covering behavior is confirmed — the map became usable in one sitting.

## What this phase added

- `src/criticality.ts` (CG-4.3) — red-domain keyword guesser: red reserved
  for money / permissions / security / compliance / data-integrity; high
  for checkout/order/export-class flows; normal otherwise. Guess names the
  matched keyword for human review. **Proposal only** — the interview decides.
- `src/bootstrap.ts` (CG-4.1) — discover test files (`globSync`, excludes
  node_modules/dist), extract `it()/test()` titles with `describe` context,
  draft one **unconfirmed** behavior per test (title→statement, path→area,
  guessed criticality, `verified_by` test_id linked, `created_by: import`).
  Reads the repo, writes nothing until `--apply`.
- `src/interview.ts` (CG-4.2) — deterministic batch decision engine:
  `confirm` (writes `confirmed_by`, the approval — I3; optional inline edit),
  `merge` (folds `verified_by`, retires the dup — I11), `discard` (retires
  with reason — nothing deleted). The whole batch is one transaction: a bad
  decision rolls back the lot.
- CLI: `cart bootstrap import <repo> [--apply]`, `cart interview --batch N`,
  `cart interview --apply <answers.json> --person P`.
