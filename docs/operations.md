# Operations — backup, restore, redaction review

> Cartographer has no server and no queue (SPEC §2). The whole state is two
> filesystem paths. That makes operations boring on purpose.

## What the state is

- `ledger.db` — the SQLite ledger (WAL mode; `ledger.db-wal`, `ledger.db-shm`
  alongside it).
- `vault/` — content-addressed evidence blobs.

Everything else (`export/`, `quarantine.json`, `config/`) is either derived or
version-controlled. **Backup = copy those two paths. Restore = copy them back.**

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
