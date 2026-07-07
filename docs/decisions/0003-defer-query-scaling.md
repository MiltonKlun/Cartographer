# 0003 — defer query-layer scaling (full-table reads kept at v0.x)

- **Date:** 2026-07-07
- **Status:** accepted
- **Scope:** the read path — `Ledger.allRecords` and its ~31 call sites. No
  code changes; this records the posture and the trigger to revisit.

## Context

Every read verb loads and `JSON.parse`s an entire table:

```ts
allRecords(table): SELECT json FROM <table> ORDER BY id  →  rows.map(JSON.parse)
```

`cart ask`, `cart pr`, `cart brief`, `cart status`, verdict computation, health,
and the rim projection all read `allRecords('behaviors')` and
`allRecords('evidence')` in full, then filter in JS. There are **~31 such call
sites**. At the current scale (hundreds of behaviors, low thousands of evidence
rows) this is imperceptible — a command is dominated by process startup, not
the query.

## The wall (when this stops being fine)

Evidence is the table that grows without bound: one row per test per CI run. A
single team running daily CI for a year is on the order of 10^4–10^5 evidence
rows. At that point every `cart ask` pays a full-table parse it doesn't need —
it only wants the handful of evidence rows citing the matched behaviors.

## Decision

**Keep the full-table reads until real data demands otherwise.** This is
consistent with SPEC §15 (no speculative scaling) and decision 0002 (no tuning
without measurements). Concretely:

- **Revisit when** any of these is true, on a real adopter's ledger:
  - `cart ask` / `cart brief` wall-clock exceeds ~500 ms on warm disk, **or**
  - the evidence table exceeds ~50k rows, **or**
  - export/backup time becomes a daily annoyance.
- **The known fix (do not build yet):** push filtering into SQL behind the
  existing `Ledger` API — e.g. `evidenceForBehaviors(ids)` doing a
  `WHERE json_extract(json,'$.behavior_ids') …` or a proper join table, and a
  `behaviorsByStatus('active')` — so the callers change import, not shape. The
  append-only + JSONL-export invariants (I11) are unaffected: this is a read
  optimization only.
- **Do not** add an ORM, a cache layer, an index service, or a second store.
  The one-file SQLite ledger is a deliberate anti-goal guard (SPEC §2); scaling
  the read path means better SQL against the same file, nothing more.

## Consequences

- The measurement is the gate: a PR that adds SQL-side filtering must show the
  before/after wall-clock on a ledger at or past the trigger size, and keep the
  full test suite green (the surfaces are behavior-tested, so a read
  optimization that changes an answer fails loudly).
- Until then, `allRecords` stays — simple, obviously correct, and fast enough.
