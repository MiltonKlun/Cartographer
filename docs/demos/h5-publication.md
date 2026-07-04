# Phase H5 demo — publication + first real CI run — 2026-07-04

> HARDENING-PLAN Phase H5 DoD: `npm run check` green + a **green CI run on a
> real GitHub runner** (not just local). This demo links that run and records
> what publication took.

## What H5 did (review C2, C3)

Turned the repo into the public portfolio artifact it was always meant to be,
and executed the CI workflow that was written blind in V2 and had **never run
on a real runner** until now.

## LICENSE (C3)

- `LICENSE` — MIT, `Copyright (c) 2026 Milton Klun`.
- `package.json` — `"license": "MIT"` (kept `"private": true`; this is a CLI,
  not an npm package, and that flag blocks accidental publish).
- README **Credits** section attributes the vendored `got` fixtures
  (`testdata/real/`, MIT) alongside Cartographer's own MIT license.

## README truth pass (H5.2)

- Dropped the stale `design kit v0.1` title and the
  `Phases 0–2 complete / 216 tests` footer (all phases + the V-roadmap are
  done; the count is 283).
- Added the `heal: no interrupted heal` line to the `cart doctor` sample
  (H2 added that check).
- Made the quickstart `ask` example honest: until a proposal is confirmed,
  `ask` answers `UNKNOWN` and badges the matches unconfirmed (I3) — it does
  not show a verdict the cold map hasn't earned.
- Added the CI badge (activated in H5.5).

## Publication (H5.3)

- Renamed `master → main`.
- The remote already had a single `Initial commit` holding only a GitHub-
  generated `LICENSE` — **byte-identical** to the one authored here, with no
  common ancestor. Rebased local history onto it (clean, no force-push), so
  the public history is linear with their initial commit as root.
- Pushed `main` to `github.com/MiltonKlun/Cartographer` (`46c6ec8..aa11cee`).

## First real CI run (H5.4) — green on Ubuntu, first try

The workflow (`.github/workflows/ci.yml`: `check` + `guardrails-gate` +
`dogfood`) had only ever been reasoned about on Windows. Its first execution
on `ubuntu-latest`:

```
run:        https://github.com/MiltonKlun/Cartographer/actions/runs/28699137372
head_sha:   aa11cee  (main)
status:     completed
conclusion: success
```

`check` (the full DoD gate) and `dogfood` (emit JUnit of Cartographer's own
tests → ingest into a fresh ledger → `cart status`) both green. **No
Ubuntu-specific fixes were needed.** Pre-flight audit confirmed why:

- the `dist/test/**/*.test.js` glob is expanded by **Node's** `--test` runner,
  not the shell, so bash `globstar` differences don't apply (verified locally
  with a single-quoted pattern);
- no hardcoded `C:\` paths, `\r\n` expectations, or `process.platform`
  branches anywhere in `src/`;
- temp state uses `mkdtempSync(tmpdir())` — cross-platform;
- the dogfood JUnit-linkage quirk (node:test `classname` vs bootstrap
  `test_id`, the H8 target) runs under `|| true` and only *reports* — it is a
  finding, not a CI failure.

The single Windows→Linux assumption that could have broken (the test glob) was
the one I checked hardest; it held.

## CI badge (H5.5)

The README badge points at the real workflow
(`…/actions/workflows/ci.yml/badge.svg`, verified HTTP 200):

```md
[![ci](https://github.com/MiltonKlun/Cartographer/actions/workflows/ci.yml/badge.svg)](https://github.com/MiltonKlun/Cartographer/actions/workflows/ci.yml)
```

## Note on CI/CD

The workflow **is** the CI: gate on every push/PR, guardrails gate on PRs,
dogfood ingestion. There is deliberately **no CD** — Cartographer is a local
CLI, not a deployed service, so there is nothing to release-deploy, and
`private: true` blocks npm publish. A deploy stage would be scope-creep against
the plan's out-of-scope list.

## DoD

`npm run check` green locally (283 tests) **and** the CI workflow green on a
real `ubuntu-latest` runner (run 28699137372, conclusion `success`). Repo
public at `github.com/MiltonKlun/Cartographer`; LICENSE + badge live.
