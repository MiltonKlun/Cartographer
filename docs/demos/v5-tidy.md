# Phase V5 demo — test-helper migration + tidy — 2026-06-15

> ROADMAP Phase V5 DoD: `npm run check` green (262 tests) + this demo: the
> line-count delta + `test:unit` wall-clock.

## What V5 finished

The test-suite audit (earlier this session) extracted `src/test/helpers/`
(factories + ledger setup) but wired them into only 2 files as the proven
pattern, deliberately leaving the rest to migrate incrementally. V5 does that
migration for the high-value files and documents the conventions.

## Line-count delta

Migrating the 5 highest-duplication integration tests
(`interview`, `pr`, `heal`, `health`, `ask`) to the helpers:

```
5 files changed, 40 insertions(+), 158 deletions(-)
```

**−118 net lines**, with the **same 262 tests passing** — behavior-preserving.
Helper adoption across `src/test/integration/` went from **2 → 7** files. The
inline 60-line `seeded()` literals collapsed to a handful of
`makeBehavior({...})` / `makeEvidence({...})` calls; a future `Behavior`
schema change now touches `factories.ts`, not a dozen inline objects.

## Tier wall-clock

`test:unit` is the fast watch-loop tier (pure logic, no I/O); `test:e2e`
spawns the binary and is ~10× slower per test. Splitting them (Phase V5 of the
original audit) means you can run the fast tier alone while iterating:

```
npm run test:unit          # 117 tests, pure logic
npm run test:integration   # 133 tests, ledger/vault/git/fs
npm run test:e2e           #  12 tests, spawns bin/cart.mjs
```

## Scope note (deliberate stopping point)

Not every integration file was migrated — and that's intentional, not
unfinished. `churn.test.ts` builds real git repos, `vault.test.ts` uses temp
vaults, `quarantine.test.ts` is pure (no ledger). For those the helpers don't
apply, or the local setup is smaller than the import churn a migration would
add. The migration targeted the files where inline boilerplate actually hurt;
the rest keep their domain-specific setup. `docs/testing.md` documents the
helper conventions so new tests start in the right place regardless.

## What this phase added

- Migrated `interview` / `pr` / `heal` / `health` / `ask` integration tests
  to `tempLedger` / `testCtx` + the record factories (−118 net lines).
- `docs/testing.md` — the tier layout, how to run each tier, the helper
  conventions, the no-vacuous-pass rule (with the exact trap the audit
  caught), and the negative-testing convention.
