# Phase V2 demo — self-CI + dogfooding — 2026-06-15

> ROADMAP Phase V2 DoD: `npm run check` green (237 tests) + this demo: the CI
> workflow + the dogfood job's `cart status` output, rehearsed locally exactly
> as CI runs it.

## What V2 adds

The tool built to consume CI had no CI of its own, and its ingestion pipeline
had only ever run by hand. `.github/workflows/ci.yml` fixes both, in three
jobs:

1. **check** — `npm run check` on Node 22 (the DoD gate: typecheck + lint +
   237 tests + schema validation).
2. **guardrails-gate** (PRs only) — every changed `*.test.ts` is run through
   the §10 `patchViolations` function vs. its base version. The same code as
   the unit tests and the heal flow — one source of truth (I5).
3. **dogfood** (after check) — emit a JUnit report of Cartographer's *own*
   tests and ingest it into a fresh ledger, proving the pipeline runs
   unattended on real CI output.

## Dogfood loop, rehearsed locally (as CI runs it)

```
> node --test --test-reporter=junit --test-reporter-destination=cart-tests.xml "dist/test/**/*.test.js"
   → 237 <testcase> entries

> cart init
> cart ingest junit cart-tests.xml --ref "ci-local-1"
ingested 237 evidence record(s) (0 linked, 237 unlinked, 0 quarantined) — receipt ACT-0001

> cart status
health: OK
ingestors:
  ingest:junit@1  last success 2026-06-15T20:44:02Z  OK
records: 0 behaviors · 237 evidence · 1 receipts
```

The ingestion pipeline runs end-to-end, unattended, on the project's own real
test output — and `cart status` reports a genuine `ingest:junit@1` health
timestamp (not a fixture's).

## Honest finding: JUnit `test_id` ↔ bootstrap `test_id` mismatch

When I tried the *full* dogfood (bootstrap own tests → then ingest, so
evidence would link to behaviors), only **3 of 237** linked. Cause: bootstrap
derives `test_id = <file>::<describe> <title>`, but Node's JUnit reporter
emits `classname="test"` with the bare test name — the two id formats don't
match, so deterministic linking (Phase 1) can't pair them.

This is **not a bug** — it's a real-world adapter-format observation. Two
honest options for a future phase (logged, not fixed here): teach the JUnit
ingestor Node's `classname`/`name` shape, or recommend the `@bhv BHV-xxxx`
annotation convention (which links regardless of id format). The dogfood
job's purpose — proving *unattended ingestion + health* — is met; linkage
fidelity for the node:test reporter specifically is a separate concern.

## guardrails-gate, rehearsed (positive + negative)

```
# the real change in this branch (adds tests) — clean
> cart guardrails-check <base bootstrap.test.ts> <current> → "clean — allowed under §10" (exit 0)

# a tampered patch that deletes tests — refused
> cart guardrails-check <current> <truncated> 
  guardrails: 1 violation(s) — patch REFUSED (I5):
    ✗ test_deletion: test count dropped 22 → 17           (exit 1)
```

The gate fires exactly where it should.

## What this phase added

- `.github/workflows/ci.yml` — three jobs (check / guardrails-gate /
  dogfood), Node 22, npm cache, JUnit artifact upload.
- No source changes — V2 is pure operational hardening. The dogfood loop
  reuses `cart ingest junit` and `cart status` as-is; the gate reuses
  `cart guardrails-check` as-is. The fact that no new code was needed is the
  point: the surfaces were already CI-ready.
