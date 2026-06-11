# Phase 6 demo — 2026-06-11

> BUILD-PLAN Phase 6 DoD: `npm run check` green (typecheck + lint + 159
> tests + validate:schemas) + this demo: triage a red run into clusters with
> repro proposals; quarantine one flake with receipt + ticket.

## Triage (CG-6.1)

A run with 4 failures of three different natures:

```
> cart triage testdata/triage-report.json
cart triage — testdata/triage-report.json: 4 failure(s) in 3 cluster(s)
[1] PRODUCT BUG ×2 — AssertionError · assertion on a value/status — the product produced the wrong result  [BHV-0001]
inference: [2] TEST BRITTLENESS ×1 — TimeoutError @ getByRole('button', { name: 'Sign in' }) · locator/timeout signature …
inference: [3] ENVIRONMENT ×1 — Error · infrastructure/network error signature …
  cluster 1 tests: tests/checkout.spec.ts::coupon applies before tax, tests/checkout.spec.ts::tax rounds half-up
    affected behaviors: BHV-0001
    repro: reproduce … manually: the assertion "expected total 9.00 to equal 10.00" should hold but does not
  cluster 2 …
    repro: run … in isolation with --repeat-each=5; flakiness confirms brittleness — quarantine + file a ticket
    → quarantine candidate: cart quarantine add "tests/login.spec.ts::shows the dashboard after login" --ticket <KEY>
  cluster 3 …
    repro: re-run … on a healthy runner; if it passes, the failure was environmental, not a regression
```

- Two pricing assertion failures share a stack root → **one** `product_bug`
  cluster, linked to `BHV-0001` (cited).
- The login timeout → `test_brittleness`, with a ready-to-run quarantine
  suggestion.
- The `ECONNREFUSED` → `environment`.
- Heuristic classifications that aren't behavior-cited are **labeled
  `inference`** (I1) — never presented as settled fact. Conflicting/absent
  signals would yield an `UNCLASSIFIED` cluster, also labeled, deferred to
  the LLM rim.

## Quarantine (CG-6.2/6.3)

```
> cart quarantine add "tests/login.spec.ts::shows the dashboard after login" \
    --ticket FLAKE-101 --reason "race on Sign in button"
quarantined … until 2026-06-18T12:00:00Z (ticket FLAKE-101, receipt ACT-0001)
test source untouched — CI routes this test_id into the non-blocking lane (I5)
```

`quarantine.json` (stable key order, the lane CI consults):
```json
{ "version": 1, "entries": [
  { "test_id": "tests/login.spec.ts::shows the dashboard after login",
    "ticket": "FLAKE-101", "entered_at": "2026-06-11T12:00:00Z",
    "expires_at": "2026-06-18T12:00:00Z", "reason": "race on Sign in button" } ] }
```

The export shows the receipt with a real revert path:
```
flake_quarantine / revert: cart quarantine remove tests/login.spec.ts::shows the dashboard after login
```

Expiry escalation (CG-6.3), 10 days later:
```
> cart quarantine list --expired --now 2026-06-25T12:00:00Z
  tests/login.spec.ts::shows the dashboard after login  ticket FLAKE-101  expires 2026-06-18T12:00:00Z  ⚠ EXPIRED (escalate)
```

## What this phase added

- `src/triage.ts` (CG-6.1) — signature = error class + normalized locator +
  stack hash; clusters by signature; deterministic classifier
  (product_bug / test_brittleness / environment), with inconclusive cases
  left `inference` for the rim. Per cluster: affected behaviors (cited),
  repro proposal, action.
- `src/triage-parse.ts` — failure extraction from Playwright/JUnit reports.
- `src/quarantine.ts` (CG-6.2/6.3) — `quarantine.json` lane: build/upsert/
  remove entries, 7-day default expiry, `expiredEntries` for escalation,
  `isQuarantined` for CI. Never edits source (I5).
- CLI: `cart triage <report>`; `cart quarantine add|remove|list` (add is an
  ACT with receipt, revert = remove).
- `docs/quarantine-ci.md` — the two-lane CI consumption guide.
