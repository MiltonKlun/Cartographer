# Phase V4 demo — adoption on-ramp — 2026-06-15

> ROADMAP Phase V4 DoD: `npm run check` green (262 tests) + this demo: a
> clean-clone-to-first-answer run following only the README quickstart.

## What V4 adds

A new adopter previously hit a wall — the README had zero `npm install` /
`cart init` lines, and the first real command was the first time the
environment got checked. V4 closes that:

- **`cart doctor`** — an environment-readiness report (Node ≥ 22.13,
  `node:sqlite` loadable, `git` present, vault writable, config valid). Run
  it first; it exits non-zero if anything is broken, so a misconfigured
  machine fails loudly *before* `init`, not mid-`ingest`.
- **README quickstart** — copy-pasteable `clone → install → doctor → init →
  bootstrap → interview → ask`, with output that matches the real commands
  verbatim.
- **Command/doc-parity test** — every command documented in `cart help` must
  be wired into the dispatch switch, so the docs can't drift from the code.

## Timed clean run (following only the README)

```
1) doctor:    READY — you can `cart init` and start.
2) init:      created ledger at <dir>/ledger.db (migrations applied)
3) bootstrap: wrote 55 unconfirmed proposal(s). Next: cart interview --batch 20
4) interview: interview applied by you: 5 confirmed, 0 merged, 0 discarded
5) ask:       BHV-0001 "Non-cacheable responses are not cached"  ASSERTED  F=0.00  …  [BHV-0001]

--- command time: ~1s (the 5-min budget is the one-time npm install + build,
    plus a human reading and confirming the interview proposals) ---
```

`doctor` output in full:

```
cart doctor — environment readiness

  ✓ node: v22.19.0 (≥ 22.13)
  ✓ node:sqlite: available
  ✓ git: git version 2.51.0.windows.1
  ✓ vault: writable (…/vault)
  ✓ config: decay.json + redaction.json valid

READY — you can `cart init` and start.
```

`git` is the one check that warns rather than fails when absent — it's
optional (churn-based decay degrades to zero churn), so a machine without git
is still `READY`.

## What this phase added

- `src/doctor.ts` (V4.3) — `checkNode` / `checkSqlite` / `checkGit` /
  `checkVaultWritable` / `checkConfig`, each a pure function over an injected
  environment; `runDoctor` aggregates, `renderDoctor` prints. `git` absent =
  `warn` (optional); a bad Node, missing `node:sqlite`, unwritable vault, or
  invalid config = `fail` (blocks).
- CLI: `cart doctor` (exit 1 when not ready); usage header de-stamped from
  "(Phase 0)" and `cart doctor` listed first.
- README: the Quickstart section, with real captured output + a pointer to
  `docs/adoption.md` ("don't adopt if…") so the on-ramp is honest, not just
  inviting.
- Tests: `test/unit/doctor.test.ts` (each check, both directions) +
  `test/e2e/cli.test.ts` V4.2 parity test (every `cart help` command is
  recognized) and a `cart doctor` e2e smoke.

## Honest note

The "~5 minutes" is dominated by `npm install` + `npm run build` (one-time)
and the human confirming the interview batch — the `cart` commands themselves
run in about a second on the sample. The interview is genuinely interactive in
normal use; the demo scripts it via `--apply` to stay non-interactive.
