# Phase 9 demo — 2026-06-11

> BUILD-PLAN Phase 9 DoD: `npm run check` green (typecheck + lint + 201
> tests + validate:schemas) + this demo: heal a broken locator end-to-end
> with a self-evidencing receipt; show a forbidden patch being refused.

## 1. Forbidden patch → REFUSED before anything touches disk (I5)

A "heal" that quietly changes the expected value from `9.00` to `10.00`:

```
> cart heal checkout.spec.ts --patched checkout.forbidden.ts \
    --behavior BHV-0001 --test "checkout.spec.ts::coupon applies before tax" --rerun-passed
heal REFUSED for checkout.spec.ts::coupon applies before tax — guardrails (§10):
  ✗ expected_value_changed: expected value changed in assertion:
      …toBe('9.00'); → …toBe('10.00');
the patch was never applied.
(exit 1)
```

The guardrail caught it even though the re-run "passed" — a green run can
never launder a forbidden edit. The file was never written.

## 2. Locator heal, red re-run → REVERTED + demoted to PROPOSE (I12)

```
> cart heal checkout.spec.ts --patched checkout.heal.ts … --rerun-failed
heal REVERTED …: no green re-run — heal demoted to PROPOSE (I12).
File restored; propose a manual fix instead.

# file after revert:
await page.locator('#apply').click();      ← original selector restored
```

No green re-run ⇒ no heal. The patch was applied, the re-run failed, and the
file was rolled back to the original — no evidence, no receipt.

## 3. Locator heal, green re-run → HEALED, self-evidenced (I12)

```
> cart heal checkout.spec.ts --patched checkout.heal.ts … --rerun-passed
heal applied … — green re-run evidenced as EV-0001 (receipt ACT-0001, I12).

# file after heal:
await page.locator('button[data-test=apply-coupon]').click();   ← stable selector

> cart verdict BHV-0001
Coupon applies before tax  [red]  VERIFIED  F=1.00  (newest: EV-0001)  [BHV-0001, EV-0001]
```

The heal is only complete because the green re-run produced new supporting
evidence, linked in the receipt — and that evidence flipped the behavior to
VERIFIED. A heal that can't self-evidence doesn't happen.

## What this phase added

- `src/guardrails.ts` (CG-9.1, SPEC §10) — one pure
  `patchViolations(original, patched, {mode})`. Rejects: test deletion
  (count drop), `.skip`/`.fixme`/`.only` introduction, assertion weakening
  (strong matcher → vacuous), expected-value/literal changes inside
  assertions (string *and* numeric), snapshot introduction. In
  `selector_heal` mode, additionally: every changed line must be a locator
  call from the allowlist (`page.locator`, `getByRole/Text/Label/TestId/
  Placeholder`) and only its string argument may differ — any structural
  change is a violation. Errs toward rejection (a false positive blocks a
  heal; a false negative would be unsafe). One source of truth: the gateway
  and the unit tests call the same function.
- `src/heal.ts` (CG-9.2, I12) — guardrails → apply → re-run; green ⇒ ACT
  with green evidence + receipt in one transaction; red ⇒ auto-revert +
  demote to PROPOSE. Apply/re-run sit behind ports (deterministic, testable).
- CLI: `cart heal <file> --patched F --behavior BHV --test "id"
  [--rerun-passed|--rerun-failed]`; `cart guardrails-check <orig> <patched>
  [--selector-heal]` (exit 1 on any violation — usable as a CI gate).
