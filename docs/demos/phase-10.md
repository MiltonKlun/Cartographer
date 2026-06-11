# Phase 10 demo — 2026-06-11

> BUILD-PLAN Phase 10 DoD: `npm run check` green (typecheck + lint + 216
> tests + validate:schemas) + this demo: eval report + calibrated constants
> + a clean restore drill.

## Eval report (CG-10.1)

```
> cart eval --golden testdata/golden-set.json
Cartographer eval report

✓ claim-citation audit: 2/2
✓ ask golden-question set: 2/2
✓ triage precision vs. labels: 3/3
✓ decline-rule (I9): 4/4

RESULT: all checks pass
(exit 0)
```

Four checks, all CI-friendly (exit 1 on any failure):
- **claim-citation audit** — every behavior_id / evidence_basis / question
  link resolves to a real ledger record (I1/I11). A dangling citation fails
  the build.
- **ask golden set** — known questions return the expected behaviors; unmapped
  areas return UNKNOWN.
- **triage precision** — failures classify to the human label
  (product_bug / test_brittleness / environment).
- **decline rule (I9)** — one-off requests decline, regression-future requests
  use the ledger.

## Decline rule (I9)

```
> cart decline "write a one-off script to rename these files"
DECLINE — This is cheaper to just prompt for directly — no ledger needed.
You'd forfeit the evidence trail, which for a one-off is fine. Want me to just do it?

> cart decline "add a regression test for the coupon bug we ship Friday"
USE THE LEDGER — has a regression future — worth a behavior + evidence in the ledger
```

## Calibration (CG-10.2)

`config/decay.json` keeps the v0.1 SPEC §4 priors **unchanged** — see
`docs/decisions/0002-decay-calibration.md`. The honest outcome: with no real
two-week dataset, inventing data to justify a tune would violate the tool's
own honesty. The note records the data-driven procedure to run once a real
adopter has two weeks of ingestion, with the eval harness as the regression
guard for any future change.

## Restore drill (CG-10.3)

```
> cart export --out backups/ledger-backup.jsonl     # 13 records, receipt ACT-0002
> cp eval-demo.db backups/ledger-backup.db
# simulate corruption: overwrite the db with garbage
> cp backups/ledger-backup.db eval-demo.db          # restore
> cart status
health: OK
records: 1 behaviors (1 confirmed) · 4 evidence (1 quarantined) · 0 open questions · 2 receipts
> cart verdict BHV-0001
Coupon applies before tax  [red]  VIOLATED  F=0.78  (newest: EV-0002)  [BHV-0001, EV-0002]
```

DB clobbered, restored from the two-path backup, and every record + verdict is
intact. Backup = copy two paths; restore = copy them back (SPEC §12).

## What this phase added

- `src/decline.ts` (I9) — `shouldDecline(request)`: one-off / no-regression
  signals decline; keep-signals (regression/production/CI/ship) override.
- `src/eval.ts` (CG-10.1) — `runEval` over four checks; CI-friendly report.
- `testdata/golden-set.json` — the golden ask/triage/decline set.
- CLI: `cart eval [--golden <set.json>]`, `cart decline "<request>"`.
- Docs: `docs/decisions/0002` (calibration procedure + governance),
  `docs/operations.md` (backup/restore + daily export hook + redaction-review
  checklist), `docs/adoption.md` ("don't adopt Cartographer if…").

This is the final phase. All of BUILD-PLAN (Phases 0–10) is complete.
