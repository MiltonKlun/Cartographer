# Phase 3 demo — 2026-06-10

> BUILD-PLAN Phase 3 DoD: `npm run check` green (typecheck + lint + 103
> tests + validate:schemas) + this demo: the 30-second answer with citations
> on a seeded ledger; an unmapped area answers honestly.

## Transcript

```
> cart ask "do we test coupons before tax?"
BHV-0002 "Coupon applies before tax"  (ci, 2026-06-10)
  FAILING  F=0.95  (computed 2026-06-10, newest: EV-0009)  [BHV-0002, EV-0009]
```
FAILING leads, always — the failing CI run from this morning outranks the
relevance order.

```
> cart ask "do we test gift cards combined with coupons?" --queue
BHV-0002 "Coupon applies before tax"  ...  FAILING ... [BHV-0002, EV-0009]
inference: these rows cover only part of "do we test gift cards combined
with coupons?" — no confirmed behavior covers the rest
queued Q-0001 — answer it via the interview to grow the map
```
Partial coverage is labeled `inference`, mirroring SPEC §7.1's
"gift-card × coupon → UNKNOWN" example.

```
> cart ask "do we test password reset emails?" --queue
UNKNOWN: no confirmed behavior covers "do we test password reset emails?"
— the map cannot answer this
queued Q-0002
```
Minimum-viable-map rule: a cold area answers UNKNOWN and offers the queue —
never a guess (I3).

```
> cart status
records: 2 behaviors (2 confirmed) · 11 evidence (2 quarantined)
         · 2 open questions · 6 receipts
verdicts: VERIFIED 1 · STALE 0 · ASSERTED 0 · UNKNOWN 0 · FAILING 1
```

## What this phase added

- Query API verbs (SPEC §8): `searchBehaviors` (deterministic token
  relevance), `verdict` (delegates to the decay engine, I2), `evidenceFor`,
  `gapsFor`, `openQuestions`, `health` — read-only; person aggregation still
  refused (I7).
- `src/ask.ts` — assembly → claims renderer → optional prose. FAILING
  sorts first; unconfirmed matches render badged and outside the verified
  answer; partial matches get an inference-labeled gap note; `--queue`
  files a `Q-` record with `why_asked`.
- `src/rim.ts` — the LLM rim interface receives rows only (no ledger
  handle, Constitution §1); `NullRimAdapter` is the v1 default, so
  rows-only is the tested normal mode, not a degraded afterthought
  (CG-3.3, SPEC §12).
- CLI: `cart ask "<question>" [--queue]`; `behavior add --verified-by`.

The system is now genuinely usable per the BUILD-PLAN dependency note.
