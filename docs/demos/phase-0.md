# Phase 0 demo — 2026-06-10

> BUILD-PLAN Phase 0 DoD: `npm run check` green (typecheck + lint + 44 tests
> + validate:schemas) + this demo. Node v22.19.0, `node:sqlite` built-in.

## Transcript

```
> cart init
created ledger at ...\ledger.db (migrations applied)

> cart behavior add --statement "A viewer-role user cannot bulk-delete records" \
    --area permissions/records --criticality red --actor erick
BHV-0001 created (unconfirmed proposal — confirm with: cart behavior confirm BHV-0001 --person <you>)

> cart behavior confirm BHV-0001 --person erick
BHV-0001 confirmed by erick at 2026-06-10T08:34:48Z

> cart behavior list
A viewer-role user cannot bulk-delete records  [red] (permissions/records)  [BHV-0001]

> cart export
exported 3 records to ...\export\ledger.jsonl (receipt ACT-0001)

> cart validate behavior examples/behavior.json
VALID behavior: examples/behavior.json

> cart claim --text "coupon stacking is covered"
cart: refusing citation-less claim (I1): "coupon stacking is covered" — cite record IDs
or label it 'inference'/'unknown'
(exit code 1)

> cart claim --text "viewer cannot bulk-delete records" --cite BHV-0001
viewer cannot bulk-delete records  [BHV-0001]

> cart claim --text "the flake is likely a race condition" --inference
inference: the flake is likely a race condition
```

## Export content (I11 — full attribution, stable key order)

The JSONL contains the behavior row plus both mutation rows (the insert and
the confirmation), each with actor, timestamp and old/new diff. The export's
own receipt (`ACT-0001`) is written in the same transaction as the file and
appears from the next export on.

## Invariants proven in code this phase

- I1/I2 — claims renderer refuses citation-less claims and incomplete
  verdicts (`src/renderer.ts`, 13 tests).
- I4/I5 — autonomy gateway: NEVER classes have no dispatch path and cannot be
  configured in; ACT writes the receipt in the action's transaction, rollback
  leaves no receipt; tiers only move toward caution (`src/autonomy.ts`).
- I7 — query API refuses every person-shaped groupBy (`src/query.ts`).
- I10 — schema-level: quarantined evidence cannot carry an artifact blob.
- I11 — append-only mutations log enforced by SQL triggers; evidence and
  receipts immutable; behaviors retire, never delete; deterministic export.
