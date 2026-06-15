# Phase V3 demo — live LLM rim — 2026-06-15

> ROADMAP Phase V3 DoD: `npm run check` green (254 tests) + this demo: the
> same `ask` rows-only vs. with-rim, the no-key degradation, and the
> faithfulness guard discarding a hallucinated citation.

## What V3 activates

The README always promised an "AI QA assistant," but every surface ran
rows-only — the rim interface existed and no surface called it. V3 wires a
**real `AnthropicRimAdapter`** (Anthropic Messages API via Node 22's built-in
`fetch` — no SDK, so the zero-dependency rule holds) into `cart ask`, behind
two guarantees that keep the invariants intact:

1. **The rim only ever sees projected rows** (`toRimRows`) — plain JSON, no
   ledger, no handles (Constitution §1). It cannot read or mutate state.
2. **The deterministic core verifies the LLM's output** — a faithfulness
   guard (`proseCitesOnlyKnownIds`) rejects any prose that cites an id not in
   the rows. The renderer stays the source of truth (I1).

## Degradation is the default (SPEC §12)

```
# default — no flag, no key needed: deterministic rows-only
> cart ask "do we test coupons before tax?"
BHV-0001 "Coupon applies before tax"  (ci, 2026-06-10)  VIOLATED  F=0.44  …  [BHV-0001, EV-0002]

# --prose opt-in, but ANTHROPIC_API_KEY unset: notice + identical rows-only
> cart ask "do we test coupons before tax?" --prose
cart: --prose needs ANTHROPIC_API_KEY (falling back to rows-only)
BHV-0001 "Coupon applies before tax"  …  VIOLATED  F=0.44  …  [BHV-0001, EV-0002]
```

The rows-only output is byte-identical with and without the rim — prose is an
enhancement, never a dependency.

## The faithfulness guard (V3.3, I1) — stubbed rim, fully offline

```
=== FAITHFUL rim — prose prepended above the canonical rows: ===
Coupon-before-tax is currently VIOLATED — the latest CI run contradicts it (BHV-0001, EV-0002).

BHV-0001 "Coupon applies before tax"  …  VIOLATED  F=0.44  …  [BHV-0001, EV-0002]

=== HALLUCINATING rim (cites BHV-9999, which is NOT in the rows): ===
BHV-0001 "Coupon applies before tax"  …  VIOLATED  F=0.44  …  [BHV-0001, EV-0002]
guard: prose DISCARDED — rows-only stands (I1)
```

When the LLM invents `BHV-9999`, the guard rejects the whole prose pass and
the output is *exactly* the rows-only render. The LLM can propose; it can
never introduce a citation the core didn't produce.

## What this phase added

- `src/rim.ts`:
  - `AnthropicRimAdapter` — Messages API via built-in `fetch`, model
    `claude-opus-4-8`, env-gated on `ANTHROPIC_API_KEY`. `proseOverRows`
    **never throws**: a non-200, a `stop_reason: "refusal"`, a network error,
    or bad JSON all return `undefined` → rows-only.
  - `toRimRows` — the ledger-free projection the LLM sees.
  - `proseCitesOnlyKnownIds` — the V3.3 guard.
  - `RimAdapter.proseOverRows` is now `async` (a real HTTP call).
- `src/ask.ts` — `renderAskWithProse(result, rim)`: always produces
  `renderAsk(result)`; prepends prose only if available **and** faithful.
  Unmapped questions never call the rim (no rows to summarize).
- CLI — `cart ask … --prose` (opt-in); `main`/`cmdAsk` are async;
  `bin/cart.mjs` catches rejections.
- Tests — `test/unit/rim.test.ts` (guard, projection, adapter driven by a
  **stubbed fetch** — no network, no key) + prose-pass cases in
  `ask.test.ts`. All offline and deterministic.

## Honest note

A real end-to-end call against the live API isn't exercised here (no key in
this environment). The adapter's wire shape (endpoint, headers, `x-api-key`,
`anthropic-version`, refusal handling) follows the current Anthropic API
reference; the stubbed-fetch tests pin the request/response contract. First
real use should confirm one live call, per the adapter's own design note.
