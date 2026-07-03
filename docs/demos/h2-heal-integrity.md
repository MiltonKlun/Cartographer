# Phase H2 demo — heal integrity — 2026-07-02

> HARDENING-PLAN Phase H2 DoD: `npm run check` green (269 tests) + this demo:
> a receipt whose revert path is opened and verified, plus the
> simulated-crash → `cart doctor` → blocked-heal transcript.

## What H2 fixed (review A2)

The selector-heal flow had two integrity holes:

1. **The revert instruction was fiction.** The receipt said
   `revert: "restore <file> from pre-heal source (kept in the receipt's
   patch)"` — but nothing ever stored that source. I4's premise is that every
   ACT carries a *workable* revert; this one pointed at an artifact that
   didn't exist.
2. **A crash window.** `runHeal` applied the patch, then ran the test, then
   wrote the receipt. A crash during the (possibly minutes-long) re-run left
   the patched file on disk with **no receipt and no evidence** — a silent,
   unreceipted source mutation.

The fix, in order, all *before* the patch touches disk:
- **vault the ORIGINAL source** (content-addressed, `src/vault.ts`) and put its
  real vault path in the receipt's `revert`;
- **write an in-flight journal** (`<vault>/heal-inflight.json`) recording the
  file, test, behavior, and the vaulted original's path;
- apply → re-run; on any resolved exit (`healed` or `reverted`) delete the
  journal. A crash leaves it behind — and a leftover journal **blocks the next
  heal** and is surfaced by `cart doctor` (I6, loud not silent).

## A2.1 — the receipt revert now points at a real, correct artifact

Real `cart heal` on a green re-run:

```
$ cart heal tests/checkout.spec.ts --patched tests/checkout.patched.ts \
    --behavior BHV-0001 --test "checkout::coupon before tax" --rerun-passed
heal applied to checkout::coupon before tax — green re-run evidenced as EV-0001 (receipt ACT-0001, I12).
```

Opening the receipt's revert and reading the cited blob:

```
revert: restore .../tests/checkout.spec.ts from vault vault/sha256/07/0702f7c6…962a673d
vault blob starts with #apply original? true
```

The blob is byte-for-byte the pre-heal source (the `page.locator('#apply')`
version), *not* the patched `button[data-test=apply]` version — so following
the revert actually restores the original.
Regression: `H2.1: a green heal receipt revert points at the vaulted original
source`.

## A2.2 — the crash window is closed

Simulating a crash (the re-run port throws mid-heal) leaves a recoverable
journal:

- `H2.2a` — a throwing `rerun` leaves `heal-inflight.json`; its `vaultPath`
  reads back to the exact original source.
- `H2.2b` — with a leftover journal present, a fresh `runHeal` returns
  `interrupted` and applies **no** patch.
- `H2.2c` — both a green heal and a reverted heal leave **no** journal behind.

`cart doctor` surfaces the interrupted heal loudly (H2.3), and exits 1:

```
$ cart doctor --vault ./vault      # (real exit code: 1)
cart doctor — environment readiness

  ✓ node: v22.19.0 (≥ 22.13)
  ✓ node:sqlite: available
  ✓ git: git version 2.51.0.windows.1
  ✓ vault: writable (…/vault)
  ✗ heal: interrupted heal — restore …/tests/checkout.spec.ts from vault
          vault/sha256/40/407f5ed2…f0f95efe, then delete …/vault/heal-inflight.json
  ✓ config: decay.json + redaction.json valid

NOT READY — fix the ✗ checks above first.
```

And the next heal refuses rather than clobbering the file (real exit code: 1):

```
$ cart heal … --rerun-passed
heal BLOCKED for x — a previous heal did not finish.
  in-flight journal: …/vault/heal-inflight.json
  restore …/tests/checkout.spec.ts from vault vault/sha256/40/407f5ed2…, then
  delete the journal to proceed.
```

## The changes

- `src/heal.ts` — `runHeal` gains a `vaultRoot` param; vaults the original and
  journals intent before applying; new `interrupted` outcome; `readHealJournal`
  + `HEAL_JOURNAL` exports; receipt revert cites the vault path; journal
  deleted on `healed`/`reverted`.
- `src/doctor.ts` — `checkHealJournal` wired into `runDoctor` (fail on a
  leftover journal).
- `src/cli.ts` — `cmdHeal` parses `--vault`, passes the root, exits 1 on
  `interrupted`.
- Tests: `heal.test.ts` +H2.1/H2.2a/b/c (existing 4 updated for the new
  signature); `doctor.test.ts` +H2.3.

## DoD

`npm run check` green: typecheck + lint + **269 tests** (118 unit / 139
integration / 12 e2e) + schema validation. The green-heal, interrupted-heal,
doctor-detection, and blocked-heal paths were all driven end-to-end against
the real `bin/cart.mjs` (exit codes 1 confirmed for the loud-failure paths).
No test weakened.
