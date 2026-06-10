# Phase 1 demo — 2026-06-10

> BUILD-PLAN Phase 1 DoD: `npm run check` green (typecheck + lint + 66 tests
> + validate:schemas) + this demo: ingest a real Playwright report twice —
> EV records linked once, no dupes, secrets scrubbed.

## Transcript

```
> cart ingest playwright testdata/playwright-report.json --ref "run 8841"
ingested 4 evidence record(s) (1 linked, 3 unlinked, 1 quarantined),
0 duplicate(s) skipped — receipt ACT-0002
  + EV-0001   (@bhv BHV-0001 annotation → linked, high confidence)
  + EV-0002   (coupon failure — password scrubbed before vaulting)
  + EV-0003   (AWS key in error → QUARANTINED, metadata-only, no blob — I10)
  + EV-0004   (new test, no behavior matches → unlinked, never guessed — I3)

> cart ingest playwright testdata/playwright-report.json --ref "run 8841"
ingested 0 evidence record(s) ..., 4 duplicate(s) skipped — receipt ACT-0003

> cart ingest junit testdata/junit-report.xml --ref "api-run 17"
ingested 3 evidence record(s) ... — receipt ACT-0004   (bearer token scrubbed)

> type vault/sha256/c4/c44e…   (EV-0002's blob)
  "message": "expected total 9.00 but got 10.00 (request sent with
              [REDACTED:password-assignment] in body)"

> cart vault gc
vault gc: no orphan blobs   (--apply deletes orphans via ACT receipt)

> grep export/ledger.jsonl for hunter2secret9|AKIAIOSFODNN7EXAMPLE
0 matches — secrets never entered the ledger or the vault
```

## What this phase added

- `src/vault.ts` — content-addressed blobs (`vault/sha256/<2>/<hash>`),
  identical content is a no-op, deletion only via receipt-gated `vault gc`.
- `src/redaction.ts` — non-optional ingestion stage: scrub rules rewrite,
  quarantine rules drop the blob (binary artifacts quarantine on any hit).
- `src/linking.ts` — deterministic order: `@bhv` annotation (high) →
  exact `test_id` (high) → `implemented_in` path overlap (medium) →
  unlinked (I3: no guessed links).
- `src/ingest.ts` + `ingest-playwright.ts` / `ingest-junit.ts` — parse →
  redact → validate → link → write, one gateway ACT per run, receipt in the
  same transaction; dedupe key = source ref + test id + artifact hash.
- Ledger migration 3: internal `dedupe_key` unique index; nested-transaction
  support so batch ingests share the receipt's transaction.
