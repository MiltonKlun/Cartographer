# Phase H7 demo — deep-link correctness — 2026-07-06

> HARDENING-PLAN Phase H7 DoD: `npm run check` green (301 tests) + this demo:
> the merged-behavior verdict before/after (driven via real `cart verdict`),
> and the verdict-upgrade probe from the review now discarded.

## What H7 fixed

- **A6 — merge didn't relink evidence.** Interview `merge` folded
  `verified_by` into the survivor but left the duplicate's *evidence*
  (`behavior_ids: ['BHV-dup']`) pointing at the retired record, so the survivor
  ignored weeks of green runs — it could read ASSERTED despite real history.
- **A4 — the rim guard had a verdict-upgrade blind spot.**
  `proseCitesOnlyKnownIds` checks ids only, so "BHV-0001 is fully verified"
  passed over a STALE row: every id known, the *state claim* a fabrication.

## A6 — merge now relinks, and every verdict surface agrees

The retired duplicate records `merged_into: <survivor>`; verdict computation
resolves that alias chain (transitively, cycle-guarded, ≤10 hops) so the
survivor's verdict counts the duplicate's evidence.

Driven against real `cart verdict` — a survivor with no evidence of its own,
and a duplicate carrying one supporting run:

```
BEFORE (survivor's own evidence only):
  Coupon applies before tax  [red]  ASSERTED  F=0.00  (newest: no evidence)  [BHV-0001]

$ cart interview --live --as ana        # m → BHV-0001 (merge the duplicate in)
  ⇒ BHV-0002 merged into BHV-0001

AFTER (survivor inherits the duplicate's run):
  Coupon applies before tax  [red]  VERIFIED  F=0.96  (newest: EV-0001)  [BHV-0001, EV-0001]
```

**Consistency catch:** the alias resolution first lived only in
`QueryApi.verdict`, so `cart ask` was fixed but `cart verdict` (which called
`computeVerdict` directly) still showed ASSERTED — caught by driving the real
binary, not the tests (which used QueryApi). Fixed by extracting a pure
`mergedAliasesOf(behaviors, id)` and routing **every** verdict surface through
it: `QueryApi.verdict`, `cart verdict` (now via QueryApi — the single accessor,
I2), and `cart brief`.

Tests: `H7.3` (survivor inherits the duplicate's newest evidence → VERIFIED,
newest_evidence_id = the duplicate's), a 2-hop chain A→B→C resolving to C, and
a hand-crafted cycle that terminates with a sane verdict.

## A4 — the rim's verdict-contradiction guard

`proseContradictsVerdicts(prose, rows)` maps state-claim words to the verdict
they assert; if the prose asserts a state no row carries, the prose is
discarded (rows stay the source of truth). Wired into `renderAskWithProse`
alongside the id guard.

| prose | rows | result |
|---|---|---|
| "BHV-0001 is fully verified and safe to ship." | STALE | **discarded** (the review probe) |
| "BHV-0001 is verified." | VERIFIED | kept |
| "This is failing." | VERIFIED only | discarded |
| "BHV-0001 is failing though BHV-0002 is verified." | FAILING + VERIFIED | kept |
| "Coupons are covered by one behavior." | any | kept (no state word) |
| "BHV-0001 is not verified." | STALE | **discarded** (conservative) |

The last row is a documented limitation: the guard is word-level with no
negation parsing, so a *true* "not verified" is also dropped. That is the safe
direction — the rows are always rendered, so at worst we lose an occasional
true prose rather than admit a false one. This matches the project's
regex-guard idiom (no NLI checker — SPEC §15 anti-overengineering).

## The changes

- `src/types.ts` + `schemas/behavior.schema.json` — optional `merged_into`
  (no migration; records are JSON blobs).
- `src/interview.ts` — merge sets `merged_into` on the retired duplicate.
- `src/query.ts` — pure `mergedAliasesOf`; `QueryApi.verdict` passes aliasIds.
- `src/decay.ts` — `computeVerdict(…, aliasIds?)`; `conclusiveEvidence` matches
  the behavior id or any alias.
- `src/cli.ts` (`cart verdict`) + `src/brief.ts` — route through the alias
  resolver so all surfaces agree.
- `src/rim.ts` — `proseContradictsVerdicts`; `src/ask.ts` — wired into
  `renderAskWithProse`.
- Tests: `interview.test.ts` +H7.3 (2), `rim.test.ts` +H7.4 (6).

## DoD

`npm run check` green: typecheck + lint + **301 tests** (134 unit / 153
integration / 14 e2e) + schemas (behavior schema validates the new field). The
merge-relink was driven end-to-end against real `cart verdict`; the rim guard
is unit-proven including the exact review probe. Live rim prose is validated in
H10 (needs an API key). No test weakened.
