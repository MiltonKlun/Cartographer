# Phase 7 demo — 2026-06-11

> BUILD-PLAN Phase 7 DoD: `npm run check` green (typecheck + lint + 172
> tests + validate:schemas) + this demo: a morning brief off real data;
> answer one question and watch the ledger mutate with attribution.

## The morning brief (CG-7.1)

Day 1 — a confirmed red behavior with fresh evidence; the brief writes the
first verdict snapshot:

```
> cart brief --now 2026-06-11T08:00:00Z
☕ cart brief — 2026-06-11T08:00:00Z

Overnight transitions:
  (first brief — no prior snapshot to compare; transitions appear from tomorrow)
Decayed red-criticality behaviors:
  none — all red behaviors are fresh
Today's open PRs × stale exposure:
  (no PR-tracker integration in v1 — run `cart pr <ref>` per PR; see SPEC §14)
Quarantine expiries:
  none
Top 3 open questions:
  none open
ingestion health: OK
```

Day 22 — the red behavior (τ=7) has decayed with no fresh evidence; the brief
diffs against day 1's snapshot and surfaces the transition:

```
> cart brief --now 2026-06-22T08:00:00Z
Overnight transitions:
  BHV-0001 [red] VERIFIED → STALE  "viewer cannot bulk-delete records"
Decayed red-criticality behaviors:
  BHV-0001 STALE F=0.20  "viewer cannot bulk-delete records"
…
Top 3 open questions:
  Q-0001 do we test password reset email delivery?
⚠ ingestion health: DEGRADED — ingest:playwright-json@1 has not ingested for 266h (SLA 26h)
```

Sections render in the fixed SPEC §7.4 order; `→ FAILING` transitions lead
(shown with 🚨 in the test suite); the health footer fires loudly (I6) — the
time travel itself made ingestion stale.

## The single-question interview (CG-7.2)

```
> cart interview
Q-0001: do we test password reset email delivery?
  why asked: gap: cart ask found no confirmed behavior covering "…" (…)

Answer it (the answer IS the approval — I3):
  cart interview answer Q-0001 --person <you> --new-behavior "<statement>" --area <area>
  cart interview answer Q-0001 --person <you> --confirm <BHV-id>
  cart interview answer Q-0001 --person <you> --dismiss [--reason "<why>"]

> cart interview answer Q-0001 --person erick \
    --new-behavior "Password reset emails are delivered within 60 seconds" --area auth/email
Q-0001 answered by erick
  → BHV-0002 created
  → BHV-0002 confirmed
```

The answer **is** the approval (I3): `BHV-0002` is created and confirmed in
one transaction, the question closes with `answer.by = erick` and records its
`resulting_mutations`. The criticality guesser even tagged it `red` (the
auth/email domain). `cart verdict BHV-0002` → `ASSERTED` (confirmed intent,
no evidence yet) — honest, and ready to become VERIFIED once CI runs.

## What this phase added

- Ledger migration 4: append-only `verdict_snapshots` table + read/write
  helpers (`writeVerdictSnapshot`, `previousSnapshotAt`, `verdictSnapshot`)
  for the overnight diff.
- `src/brief.ts` (CG-7.1) — ordered sections, snapshot-diff transitions
  (→FAILING first), decayed-red list, quarantine expiries (wired from
  Phase 6), top-3 questions, health footer; one screen.
- `src/interview.ts` (CG-7.2) — `nextQuestion` + `answerQuestion`
  (new_behavior creates+confirms, confirm_existing, dismiss); one
  transaction; closes the question with attribution and resulting mutations.
  `ledger.updateQuestion` added.
- CLI: `cart brief`; `cart interview` (single-question, default) and
  `cart interview answer <Q-id> …`; batch mode now needs an explicit
  `--batch N`.
