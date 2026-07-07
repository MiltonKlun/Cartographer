# Operations — backup, restore, redaction review

> Cartographer has no server and no queue (SPEC §2). The whole state is two
> filesystem paths. That makes operations boring on purpose.

## What the state is

- `ledger.db` — the SQLite ledger (WAL mode; `ledger.db-wal`, `ledger.db-shm`
  alongside it).
- `vault/` — content-addressed evidence blobs.

Everything else (`export/`, `quarantine.json`, `config/`) is either derived or
version-controlled. **Backup = copy those two paths. Restore = copy them back.**

## One writer per ledger (H9.1)

Cartographer is a **single-writer** tool: run one `cart` process at a time
against a given `ledger.db`. Id allocation reads `MAX(id)` and inserts in
separate steps (`Ledger.nextId` → `SELECT MAX(...)`, then the record `INSERT`),
so two `cart` processes writing the same ledger concurrently can pick the same
next id and collide. The collision is a **loud failure** — the second insert
hits the primary-key constraint and the command errors out; it is **not**
silent corruption, and the append-only log is untouched. But it means:

- Don't run a local `cart ingest`/`cart heal` against the same DB that CI's
  dogfood/ingest job is writing at that moment. Give CI its own ledger (the
  workflow already uses a `runner.temp` DB), or serialize the writers.
- A cron export/backup (`cart export`, read-only) is safe alongside a reader,
  but a second *writer* is not.

This is a deliberate scope choice (SPEC §2 — no server, no queue): the tool
serves one engineer's map, not a concurrent multi-writer service. If you ever
need concurrent writers, that is a real design change, not a config flag.

## Daily export hook (CG-10.3)

`cart export` writes a deterministic JSONL snapshot of the entire ledger,
including the append-only mutations log (I11). Run it after every successful
brief so the worst case — total DB loss — still leaves a human-readable,
diffable daily snapshot.

```bash
# nightly (after CI ingestion + the morning brief)
cart brief                          # writes today's verdict snapshot
cart export --no-receipt --out "backups/ledger-$(date +%F).jsonl"
cp -r vault "backups/vault-$(date +%F)"
```

Use `--no-receipt` for backups and any diff/review: the export then writes the
snapshot **without recording its own receipt**, so two snapshots of an
unchanged ledger are byte-identical and a `git diff` between days shows exactly
what moved. (Plain `cart export`, the receipted default, adds one receipt per
run for the audit trail — so consecutive plain exports differ by that receipt.
Don't use it where you need reproducible bytes.)

## Restore drill

DB corruption or accidental loss:

```bash
# 1. stop any process writing the ledger (single-writer model)
# 2. restore the two paths from the most recent good backup
cp backups/ledger-2026-06-10.db ledger.db
cp -r backups/vault-2026-06-10 vault
# 3. verify
cart status                 # counts + health render → DB opens cleanly
cart export --out /tmp/check.jsonl   # re-export succeeds → integrity OK
```

If only the JSONL snapshot survives (no `.db`), the ledger is reconstructable
by replaying records — but the supported, fast path is keeping the two-path
backup. The JSONL is the human-recoverable floor, not the primary restore.

### Verifying a restore worked

- `cart status` opens the DB and prints counts/health without error.
- `cart export` round-trips (re-export succeeds).
- A spot-check `cart verdict <known-BHV>` returns the expected state.

## Health SLA + ingestor retirement (H3, I6)

Health degrades **loudly** — a stale ingestor puts a `HEALTH DEGRADED` banner
on every surface (I6), because a stale map is worse than no map. But a banner
that is *always* up trains people to ignore it, so health distinguishes three
per-ingestor states, all derived from the mutations log (no extra bookkeeping):

| State | When | Effect on health |
|---|---|---|
| **fresh** | last ingest ≤ `sla_hours` | none — healthy |
| **stale** | past `sla_hours`, within `retirement_hours` | **degrades** (banner up) |
| **inactive** | past `retirement_hours`, **not** an expected feed | none — assumed one-off |

Defaults: `sla_hours = 26` (daily CI + slack), `retirement_hours = 336`
(14 days). So an ad-hoc `cart ingest junit` you ran once during evaluation
degrades health for two weeks, then goes quiet on its own — it no longer
poisons the banner forever.

Override in `config/health.json` (absent ⇒ all defaults; the file is optional
and a broken file falls back to defaults rather than crashing):

```json
{
  "sla_hours": 26,
  "retirement_hours": 336,
  "expected_ingestors": ["ingest:playwright-json@1"]
}
```

**`expected_ingestors` is the important knob.** An ingestor listed here is a
*deliberate* feed — your real nightly CI. It **never** retires: if it goes
quiet it keeps health DEGRADED however long it's been, because that silence is
exactly the failure you want the banner to shout about. List the feeds you
depend on; leave one-off imports unlisted. Per-run override for a spot check:
`cart status --sla <hours>`.

`cart status` prints each ingestor's state, labelling inactive ones
`inactive (not counted against health)` so the distinction is visible.

## Redaction config review checklist (CG-10.3, I10)

`config/redaction.json` is the only thing standing between raw evidence and
the vault. Review it **at adoption** and whenever the product's secret/PII
shape changes. Walk this list:

- [ ] **Secrets in your stack are covered.** Add patterns for any
      provider-specific token formats your CI emits (cloud keys, signing keys,
      webhook secrets) beyond the shipped AWS-key / private-key / bearer /
      generic-api-key / password rules.
- [ ] **Team PII patterns.** Add regexes for internal employee IDs, customer
      identifiers, or region-specific PII (national IDs, etc.) that could
      appear in traces or screenshots.
- [ ] **Quarantine vs. scrub is correct per rule.** `quarantine` drops the
      whole blob (use for high-entropy secrets where partial leakage is
      unacceptable); `scrub` rewrites in place (use for structured fields like
      `password=…`). When unsure, quarantine.
- [ ] **Binary artifacts.** Remember trace zips / screenshots can only be
      *quarantined* on a hit, never scrubbed — confirm that's acceptable for
      your evidence kinds.
- [ ] **Test it.** Seed a fixture with a real-shaped (fake) secret of each
      type and confirm `cart ingest …` scrubs or quarantines it and that
      `cart export` contains zero matches. (The repo's redaction tests are the
      template.)
- [ ] **Tokens live in env, never in the ledger.** CI/tracker tokens are read
      from environment variables; confirm none are committed or logged.

A redaction rule that has never been tested against a seeded secret is a wish,
not a control — add the fixture.
