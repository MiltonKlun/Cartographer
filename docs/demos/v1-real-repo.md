# Phase V1 demo — real-repo validation — 2026-06-15

> ROADMAP Phase V1 DoD: `npm run check` green (237 tests) + this demo: a
> cold-start transcript, the findings log, and the fixes — on a repo we did
> NOT author (sindresorhus/got, test/cache.ts + test/cookies.ts).

## The point of this phase

Every prior demo ran on hand-authored fixtures. This one points the system at
a real, unfamiliar codebase. It surfaced **four defects in the first ten
minutes** — exactly what synthetic fixtures couldn't.

## Findings log (real defects, in order surfaced)

| # | Symptom on real data | Root cause | Severity |
|---|---|---|---|
| 1 | `bootstrap import` scanned **0 files** | default globs only matched `*.test.ts`/`*.spec.ts`; got uses `test/cache.ts` (un-suffixed, in a `test/` dir) | **high** — silent total cold-start failure |
| 2 | area came out as `timeout.ts` | extension stripper only knew `.spec`/`.test`; a bare `.ts` survived | medium — ugly areas |
| 3 | `--apply` reported success but ledger had **0 behaviors** | one title (`"blah"`, `"[2]"`) → statement < 8 chars → schema reject → **whole one-transaction batch rolled back** | **high** — one bad test name sinks the entire import |
| 4 | `ask "caching…"` missed `"…cached"` behaviors | tokenizer has no stemmer (`caching` vs `cached`) | low — known v1 limit (SPEC §15: embedding-assisted matching is future) |

## Fixes (this PR)

- **#1** — added test-directory globs (`test/**`, `tests/**`, `__tests__/**`,
  `.ts`/`.js`) plus a `NON_TEST` filter so helpers/fixtures under `test/`
  aren't drafted as behaviors.
- **#2** — `areaFromPath` now strips any source extension (`.tsx?/.jsx?/
  .mjs/.cjs`) after the optional `.spec`/`.test` suffix.
- **#3** — two layers: `statementFromTitle` qualifies a too-short statement
  with its area (`"blah"` → `"cookies behavior: Blah"`, valid + meaningful),
  AND `cart bootstrap import --apply` now inserts **per-record**, skipping and
  reporting any that still fail — one malformed draft can never abort the batch.
- **#4** — left as-is; it's the documented v1 stemming limitation, and the
  exact-term query works. Not a regression.

All three code fixes are pinned by regressions in `bootstrap.test.ts`
(`V1: …`), built from the real got titles.

## Transcript (after fixes)

```
> cart bootstrap import testdata/real
scanned 2 test file(s) → 55 behavior proposal(s) (all unconfirmed)
criticality guesses: normal 47 · red 8        ← cache/retry errors → red, correctly

> cart bootstrap import testdata/real --apply --actor eval
wrote 55 unconfirmed proposal(s). Next: cart interview --batch 20
  (had a short title been undraftable, it would read "…, skipped N un-draftable")

> cart status
records: 55 behaviors (0 confirmed) · …       ← all 55 persisted (was 0 before fix #3)

> cart interview --apply <12 confirms> --person eval
interview applied by eval: 12 confirmed, 0 merged, 0 discarded

> cart ask "are cacheable responses cached?"
BHV-0002 "Cacheable responses are cached"  ASSERTED  F=0.00  …  [BHV-0002]
BHV-0001 "Non-cacheable responses are not cached"  ASSERTED  …  [BHV-0001]
```

Cited answers from a real, third-party codebase, cold-started in one sitting —
the map met reality and (after four fixes) told the truth about it.

## Verdict

The deterministic core was sound; the **edges that only real data touches**
were not. V1 converted "passes its tests" into "survives an unfamiliar repo."
Two of the four defects were silent failures a synthetic suite would never
have caught.
