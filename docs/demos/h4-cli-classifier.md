# Phase H4 demo — cart pr ref handling + criticality boundaries — 2026-07-02

> HARDENING-PLAN Phase H4 DoD: `npm run check` green (283 tests) + this demo:
> the `git diff 412` failure vs the new message; the classifier before/after
> cases; the got-fixture re-measure.

## What H4 fixed

- **A5 — `cart pr <ref>` was broken for the documented use case.**
  `cart pr 412 --repo .` ran `git diff 412` → `fatal: ambiguous argument
  '412': unknown revision`, and the inline comment even claimed base-diffing
  the code didn't do. Every demo quietly used `--diff <file>` to avoid it.
- **A7 — the criticality guesser prefix-matched short tokens.** "payload" →
  red (via `pay`), "Taxi" → red (via `tax`), "author" → red (via `auth`),
  "Cartesian" → high (via `cart`).

## A5 — `cart pr` ref resolution

Ref handling is now a pure `resolvePrRef` (in `src/diff.ts`, unit-tested):

| input | resolves to |
|---|---|
| `main...HEAD` (a range) | passed through unchanged |
| `main` / a SHA (a base) | `main...HEAD` (merge-base: what the PR changed) |
| `412` (a PR number) | **error** — git cannot diff a number |

**Before** (what the old code did on a bare number):

```
$ git diff 412
fatal: ambiguous argument '412': unknown revision or path not in the working tree.
```

**After** — driven against a real throwaway repo (`git init`, commit on the
base branch, branch, change a file):

```
$ cart pr 412 --repo ./repo            # exit 1
cart: "412" looks like a PR number — git cannot diff a number. Pass a base
branch/SHA (e.g. main), a range (main...HEAD), or --diff <file> (capture one
with: gh pr diff 412 > pr.diff).

$ cart pr master --repo ./repo         # a real base ref works
Cartographer — risk note for PR master (+1/−1 in src/records/**)
UNKNOWN: PR master touches no code covered by a confirmed behavior, and adds
no uncovered source files
```

The base ref resolved to `master...HEAD` and diffed the branch's one changed
file — a real risk note, not a git error. (UNKNOWN because the temp ledger has
no confirmed behavior covering it, which is the honest answer.)

## A7 — criticality word boundaries

`DOMAIN_RULES` is rebuilt from a `rule(words, stems)` helper: **words** get
both boundaries (`\bpay\b`); **deliberate stems** keep leading-boundary prefix
matching and are listed explicitly (invoic, subscri, authoriz, authentic,
privileg, complian, encrypt, sanitiz, vulnerab, corrupt, bulk).

| statement | before | after |
|---|---|---|
| Parses the response **payload** correctly | red (`pay`) | **normal** |
| **Taxi** fare screen renders | red (`tax`) | **normal** |
| The **author** byline renders | red (`auth`) | **normal** |
| **Cartesian** grid renders | high (`cart`) | **normal** |
| **Tax** is applied at checkout | red | **red** ✓ |
| **Payment** succeeds with a saved card | red | **red** ✓ |
| **authorization** header is validated | red | **red** ✓ |
| **invoice** total is correct (stem) | red | **red** ✓ |

All 10 original red/high/normal cases still pass — the real detections are
untouched; only the false positives are removed.

## H4.4 — re-measure on the got fixtures (honest finding)

Re-running `cart bootstrap import testdata/real` (the vendored got
`cache.ts` + `cookies.ts`, 55 proposals) under both the old and new regex:

```
criticality guesses: normal 54 · high 1     (identical old vs new)
red count: 0  (both)
```

**Delta on got: zero.** These particular test files contain no
"payload"/"Taxi"/"author"-shaped leading tokens, so there were no false
positives to remove here. The fix is validated by the targeted unit cases
above, not by this corpus — recording it honestly rather than claiming a delta
the data doesn't show.

## The changes

- `src/diff.ts` — new `resolvePrRef(ref)` (pure, unit-testable).
- `src/cli.ts` — `cmdPr` calls `resolvePrRef`, `fail()`s on error; misleading
  comment removed.
- `src/criticality.ts` — `rule(words, stems)` helper; boundaries per token.
- Tests: `diff.test.ts` +H4.1 (3 cases), `criticality.test.ts` +H4.3
  (7 cases).

## DoD

`npm run check` green: typecheck + lint + **283 tests** (128 unit / 143
integration / 12 e2e) + schema validation. `cart pr` bare-number-refused
(exit 1) and base-ref (real risk note) paths driven end-to-end against a real
git repo; scratchpad cleaned. No test weakened.
