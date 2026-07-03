# Phase H3 demo — health SLA realism — 2026-07-02

> HARDENING-PLAN Phase H3 DoD: `npm run check` green (273 tests) + this demo:
> the one-time-ingestor trap reproduced then healthy, and the expected-ingestor
> case still degrading — both against real `cart status`.

## What H3 fixed (review A3)

`computeHealth` tracked **every** actor that ever appeared with an `ingest:`
prefix, forever, against one fixed 26h SLA. So a single ad-hoc
`cart ingest junit` — run once during evaluation, never again — left the map
**DEGRADED for life**, with an I6 banner on every surface. A banner that is
always up trains users to ignore it, which destroys the exact loud-degradation
property I6 exists for.

The fix gives each ingestor one of three states, all derived from the
mutations log (no extra bookkeeping):

| State | When | Health |
|---|---|---|
| **fresh** | last ingest ≤ `sla_hours` (26) | healthy |
| **stale** | past SLA, within `retirement_hours` (336 = 14d) | **degrades** |
| **inactive** | past retirement **and not** an expected feed | excused |

An ingestor listed in `expected_ingestors` (`config/health.json`) is a
*deliberate* feed and **never** retires — it keeps health degraded however long
it's been quiet, because that silence is the failure the banner should shout
about. Config is optional; a missing or broken file falls back to defaults and
never throws (`loadHealthConfig`).

## The trap, reproduced then fixed — real `cart status`

Seed: one evidence row from `ingest:junit-once@1`, its mutation logged
`2026-06-01T00:00:00Z`; evaluate at `2026-06-17T16:00:00Z` (400h later, well
past the 336h retirement). Default config (no `expected_ingestors`):

```
$ cart status --now 2026-06-17T16:00:00Z
health: OK
  ingest:junit-once@1  last success 2026-06-01T00:00:00Z  inactive (not counted against health; quiet 400h)
```

**health: OK** — the one-off feed went inactive on its own instead of poisoning
the banner forever. (Before H3, this same state reported
`health: DEGRADED` permanently.)

## The expected-ingestor case — still degrades loudly

List that ingestor as a deliberate feed in `config/health.json`:

```json
{ "sla_hours": 26, "retirement_hours": 336, "expected_ingestors": ["ingest:junit-once@1"] }
```

Same 400h-stale ledger, same clock:

```
$ cart status --now 2026-06-17T16:00:00Z
health: DEGRADED — ingest:junit-once@1 has not ingested for 400h (SLA 26h)
  ingest:junit-once@1  last success 2026-06-01T00:00:00Z  STALE (400h > 26h SLA)
```

A feed you *depend on* going quiet keeps the banner up — retirement does not
apply to it. This is the whole point of the list: retire the noise, keep
shouting about the signal.

## The changes

- `src/health.ts` — `IngestorState` (`fresh|stale|inactive`) on
  `IngestorStatus`; `HealthConfig` + `loadHealthConfig` (defaults on
  absent/broken) + `healthConfig(over?)`; `retirement_hours`
  (`DEFAULT_RETIREMENT_HOURS = 336`); only `stale` degrades;
  `expected_ingestors` block retirement.
- `config/health.json` — shipped with documented defaults + empty
  `expected_ingestors` (no behavior change until a user lists one).
- `src/cli.ts` — `cart status` labels inactive ingestors; `--sla` override
  flows through `healthConfig({ sla_hours })`.
- `docs/operations.md` — Health-SLA section (state table + the
  `expected_ingestors` contract).
- Tests: `health.test.ts` +H3.1/H3.2/H3.3 (existing 17h/48h cases unchanged).

## DoD

`npm run check` green: typecheck + lint + **273 tests** (118 unit / 143
integration / 12 e2e) + schema validation. Both the trap→OK and
expected→DEGRADED paths driven end-to-end against real `bin/cart.mjs status`;
`config/health.json` restored to shipped defaults afterward. No test weakened.
