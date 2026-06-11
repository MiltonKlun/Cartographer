# Phase 8 demo — 2026-06-11

> BUILD-PLAN Phase 8 DoD: `npm run check` green (typecheck + lint + 184
> tests + validate:schemas) + this demo: a 10-minute exploratory session
> becomes reviewed proposals + evidence; an ET-Kit session sheet ingests into
> the same review queue.

## Native ride-along (CG-8.1/8.2) — silent until stop (I8)

```
> cart session start --engineer ana
session SES-0001 started for ana — observing silently until stop (I8)

> cart session note "double-submit on coupon form creates two carts" --engineer ana
noted (1 so far). Silent until stop.
> cart session note "should expired coupons show a specific error?" --engineer ana
noted (2 so far). Silent until stop.
> cart session note "totals panel reads clearly" --engineer ana
noted (3 so far). Silent until stop.

> cart session stop --engineer ana
session SES-0001 stopped (3 observation(s)) → review queue

behavior proposals (2) — review before they enter the map (I3):
  · behavior to consider: the product should NOT "double-submit … creates two carts"
  · behavior to consider: "totals panel reads clearly"
candidate regression tests (1):
  · regression test draft: reproduce "double-submit … creates two carts"
questions queued (1): Q-0001
nothing merged — confirm behaviors via `cart interview`, answer questions, keep or drop test drafts.
```

During the session the tool stays out of the way — `note` only confirms the
count, no analysis (I8). At `stop`, the bug note becomes a behavior + a
regression-test draft, the "should…?" note becomes a queued question
(`Q-0001`), and the neutral note a behavior to consider. **Nothing merges
into the map** — the proposals sit on the session for human review (I3).

## ET-Kit session-sheet import (CG-8.3, decision 0001)

The separate ET-Kit produces a markdown session sheet; Cartographer ingests
it through the same `ingest:session` back end:

```
> cart ingest session testdata/et-session-sheet.md
imported ET-Kit sheet → session SES-0002: 3 evidence, 1 question(s), 1 idea(s) — receipt ACT-0001
  evidence: EV-0001, EV-0002, EV-0003
  questions: Q-0002
  nothing merged into the map — review proposals + answer questions (I3)
```

SPEC §6 mapping in action:
- 2 BUG + 1 ISSUE rows → `EV(kind: manual_observation, outcome: violates)`
- 1 QUESTION row → open `Q-0002`
- 1 IDEA row → a session proposal (text, for review)

Redaction held (I10): the referenced `console.log` carried
`password=hunter2secret9`; its evidence (EV-0003) is `redacted` and the
vaulted blob is scrubbed — the secret never reached the vault or the ledger.

```
EV-0001 redaction=clean    vault=clean      (double-cart.txt)
EV-0002 redaction=clean    vault=n/a        (ISSUE, metadata-only)
EV-0003 redaction=redacted vault=clean      (console.log, password scrubbed)
```

## What this phase added

- Ledger: `getSession` / `updateSession` (logged, validated).
- `src/session.ts` (CG-8.1/8.2) — `start|note|stop`; one open session per
  engineer; silent capture (I8); `draftProposals` classifies notes
  (question-phrasing wins over bug-phrasing); `stop` queues QUESTION notes as
  `Q` records and parks behavior/test proposals on the session — nothing
  merged (I3).
- `src/ingest-session.ts` (CG-8.3) — `parseSessionSheet` (ET-Kit markdown:
  metadata + `HH:MM | TAG | note | oracle | evidence-ref` rows) and
  `importSessionSheet` (one gateway ACT; BUG/ISSUE→EV, QUESTION→Q, IDEA→
  proposal; evidence files redacted+vaulted, oracle BHV-id links at low
  confidence — I3). Native and ET-Kit share the back end.
- CLI: `cart session start|note|stop --engineer E`; `cart ingest session
  <sheet.md>`.
