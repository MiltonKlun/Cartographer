# Phase 2 demo — 2026-06-10

> BUILD-PLAN Phase 2 DoD: `npm run check` green (typecheck + lint + 91 tests
> + validate:schemas) + this demo: simulate the passage of time and churn;
> watch VERIFIED → STALE → UNKNOWN with correct numbers.

## Time-travel transcript (`--now` = injected clock; BHV-0001 is red, τ=7d)

```
> cart verdict BHV-0001 --now 2026-06-10T12:00:00Z       (day 0)
A viewer-role user cannot bulk-delete records  [red]
  VERIFIED  F=0.95  (computed 2026-06-10, newest: EV-0001)  [BHV-0001, EV-0001]

> cart verdict BHV-0001 --now 2026-06-17T03:00:00Z       (day 7 = τ_red)
!! HEALTH DEGRADED — ingest:playwright-json@1 has not ingested for 151h (SLA 26h)
A viewer-role user cannot bulk-delete records  [red]
  STALE  F=0.37  (= e^-1, exactly per SPEC §4)             [BHV-0001, EV-0001]

> cart verdict BHV-0001 --now 2026-07-10T03:00:00Z       (day 30)
!! HEALTH DEGRADED — ... 703h ...
A viewer-role user cannot bulk-delete records  [red]
  UNKNOWN  F=0.01                                          [BHV-0001, EV-0001]
```

The 30-days + 600-churned-lines case from the BUILD-PLAN demo line is proven
numerically in `src/decay.test.ts` ("the demo numbers"): F = e⁻¹ × e⁻¹·⁵ =
0.0821 < 0.15 ⇒ UNKNOWN.

Note the banner: the time travel itself made the ingestors stale beyond the
26h SLA, so I6 kicked in organically — verdicts kept rendering, loudly
flagged, never silently served.

## `cart status`

```
> cart status --now 2026-06-10T20:00:00Z
health: OK
ingestors: ingest:junit@1 OK · ingest:playwright-json@1 OK
records: 1 behaviors (1 confirmed) · 7 evidence (1 quarantined) · 0 open questions · 5 receipts
verdicts: VERIFIED 1 · STALE 0 · ASSERTED 0 · UNKNOWN 0 · VIOLATED 0

> cart status --now 2026-06-13T20:00:00Z
health: DEGRADED — ingest:playwright-json@1 has not ingested for 72h (SLA 26h)
```

## What this phase added

- `src/decay.ts` — the only verdict constructor (I2). Rule order:
  unconfirmed → UNKNOWN (I3) · hard VIOLATED rule (newest violates beats any
  freshness) · zero evidence → ASSERTED · thresholds → VERIFIED/STALE/UNKNOWN.
  Superseded evidence is excluded.
- `src/churn.ts` — churn port: `GitChurnIndex` (`git log --numstat`, cached),
  `StaticChurnIndex` (tests/demos), `NullChurnIndex` (no repo → factor 1,
  feature degrades, core stands).
- `src/health.ts` — per-ingestor last success from the mutations log; beyond
  SLA ⇒ degraded ⇒ renderer banner on every surface (I6).
- CLI: `cart verdict <BHV-id> [--repo dir]`, `cart status [--sla h]`;
  `behavior list` now carries the live health banner.
- 25 new table-driven decay/health tests, all with injected clocks.
