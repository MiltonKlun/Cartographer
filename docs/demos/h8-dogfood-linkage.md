# Phase H8 demo — dogfood linkage (JUnit classname ↔ test_id) — 2026-07-06

> HARDENING-PLAN Phase H8 DoD: `npm run check` green (307 tests) + this demo:
> the mapping rule, the linkage rate before/after, and (H8.4) a CI run proving
> it unattended.

## What H8 fixed (review C4b / the V2 finding)

Cartographer's own CI dogfood job ingests a JUnit report of its own tests. But
**node:test's JUnit reporter carries no file or class identity** — every case
is `classname="test"` with no `file` attribute; the only signal is the test
`name` (its title):

```xml
<testcase name="parses numstat lines into added/deleted/path" classname="test"/>
```

The junit ingestor builds `testId = "${classname}::${name}"` → `test::<title>`,
but bootstrap test_ids are `<file>::<title>` (e.g.
`diff.test.ts::parses numstat lines into added/deleted/path`). Exact matching
compares `test::…` against `diff.test.ts::…` → **almost never matches**. The V2
finding measured ~2% self-linkage.

## The mapping rule (written before it was coded, H8.1)

Both id formats end with `::<title>`, and node:test's `name` *is* that title.
So: **a JUnit case links to a behavior whose `verified_by` test_id shares the
same title-half**. Observed shapes, side by side:

| node:test JUnit `name` | bootstrap `test_id` | shared title-half |
|---|---|---|
| `parses numstat lines into added/deleted/path` | `diff.test.ts::parses numstat lines into added/deleted/path` | ✓ matches |
| `mapped area: cited rows with verdicts; FAILING leads` | `ask.test.ts::mapped area: …FAILING leads` | ✓ matches |
| `red domain: "${statement}"` | (template literal — not extractable) | ✗ can't link |

Captured sample: `testdata/self/junit-sample.xml`.

## Implementation (H8.2)

A new linking tier in `src/linking.ts`, **between** exact test_id and path
overlap:

```
1. @bhv annotation            → high
2. exact test_id              → high
3. title-suffix (derived, H8) → medium   ← new
4. path overlap               → medium
5. none                       → low
```

`titleOf(testId)` takes the half after the last `::`. A ref links by
title-suffix only when the match is **unique** — an ambiguous title (same name
in two files) is skipped rather than mislinked (I3: never a guessed link). It
links at **medium**, never high, because it's an inference.

## Linkage rate — before / after (real, on Cartographer's own suite)

Bootstrapping this repo's `src/test` tree, then ingesting its own full
node:test JUnit report (306 evidence rows):

```
before (exact/annotation only):    3 / 306   ≈  1%   (the V2 finding)
after  (with title-suffix):      260 / 306   = 85%
  by confidence: medium 257 · high 3
```

**~1% → 85%.** The remaining ~15% unlinked are parameterized/template-literal
titles (`red domain: "${statement}"` and friends) that bootstrap can't resolve
to a literal — an inherent limitation, honestly left unlinked rather than
guessed.

## Tests (H8.3)

- `linking.test.ts` (+4): a node:test-shaped ref links by title suffix at
  medium; exact test_id still wins over suffix; an ambiguous title is NOT
  mislinked (→ none); path overlap still wins when the suffix is ambiguous.
- `dogfood-linkage.test.ts` (+2): bootstrap this repo's own `src/test`, ingest
  `junit-sample.xml`, assert linkage > 0 and rate ≥ 50% (guards vacuous pass),
  and all derived links are medium; a named title links to exactly its
  behavior.

## H8.4 — proven in CI

The V2 dogfood job ingested JUnit into a *fresh empty* ledger, so it never had
behaviors to link against — it only proved ingestion ran. H8 fixes that too:
the dogfood job now **bootstraps this repo's own `src/test` first**, then
ingests, then prints the self-linkage rate:

```yaml
- run: |
    node bin/cart.mjs bootstrap import src/test --apply --actor ci
    node bin/cart.mjs ingest junit cart-tests.xml --ref "ci-${{ github.run_number }}"
    node bin/cart.mjs status
    # → "dogfood self-linkage: 260/306 (85%)"
```

Verified locally with the exact CI command sequence: `260/306 (85%)`. The
Ubuntu runner runs the same path unattended and prints the rate in the job log.

## DoD

`npm run check` green: typecheck + lint + **307 tests** (138 unit / 155
integration / 14 e2e) + schemas. Real end-to-end rate measured at 85% (from
~1%); the linker change is unit-proven including the anti-mislink guard. No
test weakened.
