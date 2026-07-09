# Testing — tiers, helpers, conventions

How the test suite is organized and the rules it holds itself to. The suite is
the enforcement layer for the invariants (CONSTITUTION.md) — a test that can't
fail is worse than no test, so the conventions below exist to keep that honest.

## Layout

```
src/                       production code (no *.test.ts)
src/test/
  helpers/                 shared setup — import these, don't re-roll
    factories.ts           makeBehavior / makeProposal / makeEvidence /
                           makeQuestion / makeSession / makeReceipt / daysBefore
    ledger.ts              tempLedger / tempDbPath / tempVaultPath / testCtx /
                           testClock / TEST_NOW
    fixtures.ts            paths to testdata/ + examples/ fixtures
  unit/                    pure logic, no I/O — fast
  integration/            touch ledger / vault / git / fs
  e2e/                     spawn the real bin/cart.mjs
```

Production code compiles `src/*.ts → dist/*.js`; tests compile to
`dist/test/**`. `bin/cart.mjs` imports `../dist/cli.js`, untouched by the test
tree.

## Running

```sh
npm test               # all tiers, in order (pretest builds first)
npm run test:unit      # pure logic only — the fast watch-loop tier
npm run test:integration
npm run test:e2e       # spawns the binary (~10× slower per test)
npm run check          # typecheck + lint + test + validate:schemas (the DoD gate)
```

Run one file directly after a build: `node --test "dist/test/unit/decay.test.js"`.
Filter by name: `node --test --test-name-pattern="FAILING" "dist/test/**/*.test.js"`.

## The three tiers

| Tier | Touches | Examples | Rule of thumb |
|---|---|---|---|
| **unit** | nothing (pure functions) | decay, guardrails, criticality, linking, renderer, query, decline, diff, export(fn), rim, doctor | computes expected values *independently* from the formula/spec — never echoes what the code produces |
| **integration** | ledger / vault / fs / git | db, ingest*, brief, heal, session, interview, pr, eval, health, quarantine, vault, churn, ask, bootstrap, autonomy, triage | uses `tempLedger` / `tempVaultPath`; one fresh temp dir per test |
| **e2e** | the real binary | cli | `spawnSync` `bin/cart.mjs` against a temp `CART_DB`; asserts exit codes + stdout/stderr |

Put a test in the lowest tier that can exercise the behavior. A pure function
gets a unit test even if a surface also covers it.

## Helper conventions

- **Build records with the factories**, not inline literals. `makeBehavior({ id, criticality })` — pass only the fields the test cares about; everything else is a valid default. A schema change then touches `factories.ts`, not a dozen files. (The factories return *valid* records — they pass `assertValid`.)
- **Get ledgers from `tempLedger(clock?)`**, not hand-rolled `new Ledger(mkdtempSync(...))`. Pass a `fixedClock(...)` when the test asserts on a specific timestamp; omit it for `testClock` (`TEST_NOW = 2026-06-11T12:00:00Z`).
- **Get a verdict context from `testCtx(clock?)`** (decay config + `NullChurnIndex` + clock).
- **Time is always injected** — `fixedClock`, never `Date.now()`. Tests never sleep.
- A test that needs git churn builds a real throwaway repo (see `churn.test.ts`); one that needs a vault uses `tempVaultPath()`.

## The no-vacuous-pass rule

A test must be able to **fail**. The trap that bit this suite once (caught in
the test-suite audit): asserting `passed === total` against a set that could be
empty — `0 === 0` passes while testing nothing. Guard the precondition first:

```ts
assert.ok(labels.length > 0, 'fixture must carry labels — empty would pass vacuously');
assert.equal(check.total > 0, true, 'check ran against zero inputs (vacuous)');
assert.equal(check.passed, check.total);
```

Related smells to avoid:
- `assert.ok(arr.find(...))` without asserting *which* element matched.
- A `?? []` / `|| []` fallback on a fixture that, if absent, silently empties the assertion.
- A test whose name promises more than its body proves (e.g. "no ledger access" while only inspecting a mock) — make the assertion match the claim, or rename it.

## Negative testing

For every guard/validator, prove rejection as well as acceptance: take a valid
input, mutate the one field under test, assert it's refused. The schema,
guardrails, autonomy-tier, and decline tests all follow this shape — a
validator with only happy-path tests is a wish.
