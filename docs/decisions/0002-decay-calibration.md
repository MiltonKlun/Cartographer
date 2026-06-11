# 0002 — decay calibration procedure (constants unchanged at v0.1)

- **Date:** 2026-06-11
- **Status:** accepted
- **Scope:** `config/decay.json` governance + the calibration procedure
  (BUILD-PLAN CG-10.2). No constant is changed by this note.

## Context

`config/decay.json` ships with the SPEC §4 defaults: `τ_time` = {red 7,
high 14, normal 30, low 90} days, `τ_churn` = 400 lines, weights {high 1.0,
medium 0.85, low 0.5}, thresholds {VERIFIED ≥ 0.50, STALE ≥ 0.15}. These are
*priors*, not measurements. The Constitution (§5) requires a decision note to
change any of them — this note establishes the procedure and records that, at
v0.1, **we have no real data and therefore change nothing.**

## The calibration procedure (run after ~2 weeks of real ingestion)

1. **Collect.** Export the ledger daily (`cart export`, already wired —
   CG-10.3). After two weeks you have ~14 JSONL snapshots.
2. **Measure agreement.** For each behavior that a human re-confirmed or that
   an incident later contradicted, compare the verdict Cartographer showed the
   day before against the human's ground truth:
   - A behavior shown `VERIFIED` that an incident then violated within τ_time
     ⇒ τ_time too long (decay too slow) for that criticality.
   - A behavior shown `STALE`/`UNKNOWN` that a human re-confirmed unchanged
     with no new evidence ⇒ τ_time too short (decay too fast).
3. **Tune one axis at a time**, in this order, re-running the eval harness
   (`cart eval --golden …`) after each change so the golden set still passes:
   - `τ_time` per criticality (the dominant term).
   - `τ_churn` only if churn-heavy areas decay too fast/slow independent of time.
   - thresholds last (they reshape the VERIFIED/STALE/UNKNOWN split globally).
4. **Record.** Any change ships as `docs/decisions/000N-…` (context, the
   measured miss rate that justified it, before/after constants) **and** updates
   `config/decay.json` in the same PR (Constitution §5). Never tune constants
   to make a single behavior look better — tune to the aggregate miss rate.

## Decision

Keep the v0.1 priors. Re-open this procedure once a real adopter has two weeks
of ingested data; the calibration is data-driven, and inventing data to
justify a tune would violate the same honesty the tool is built on.

## Consequences

- `config/decay.json` carries a pointer to this procedure in its `$comment`.
- The eval harness (CG-10.1) is the regression guard for any future tune: a
  calibration that breaks the golden set is rejected.
