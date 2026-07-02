# SPEC.md — Cartographer Technical Specification

> The engineering contract. `CONSTITUTION.md` says what must always be true;
> this document says how. `BUILD-PLAN.md` says in what order. Schemas here are
> normative; field names are binding for v1.

---

## 1. Architecture

```
  SOURCES                    DETERMINISTIC CORE                         SURFACES (LLM rim)
  ───────                    ──────────────────                         ──────────────────
  CI reports ──┐                                                        cart ask
  git diffs  ──┤   ingestors ─► redaction ─► validator ─► ledger.db     cart pr <ref>
  incidents  ──┤        │                                   ▲   │       cart triage <run>
  crawls     ──┤        └──► evidence vault ────────────────┘   ▼       cart brief
  sessions   ──┘             (content-addressed blobs)    decay engine  cart interview
                                                                │       cart session …
                                                                ▼       cart status
                                                 verdicts ─► query API ─► claims renderer
                                                                          (cite-or-fail, I1)
```

- **Ingestors** are the only write path into the vault and ledger (I10).
- **The decay engine** is the only constructor of verdict objects (I2).
- **The claims renderer** is the only path from ledger rows to human-facing
  prose; it rejects citation-less claims (I1) and injects health banners (I6).
- **The autonomy gateway** (`autonomy.ts`) is the only path to side effects
  outside the ledger — PR comments, tickets, quarantine entries, heals (I4).
- **The LLM** sits between the query API/renderer and the human. It receives
  structured rows, returns structured proposals or prose-over-rows. It has no
  database handle (Constitution §1).

## 2. Stack and dependency policy

- **Node 22+** (pins `node:sqlite`), **TypeScript 5+ strict**, `node:test`.
- **Persistence:** `node:sqlite` single file `ledger.db`. Pre-approved
  fallback if `node:sqlite` proves limiting: `better-sqlite3` — the *only*
  pre-approved dependency; anything else is stop-and-ask.
- **Validation:** AJV + JSON Schema draft-07, one generic validator script,
  schemas in `schemas/`. Every record validates at the ingestion boundary.
- **Optional integrations (adapter pattern, not core):** Playwright (crawl +
  ride-along observation), `git` CLI (churn), CI provider API (comment
  posting), tracker API (tickets). Each behind a small port so absence
  degrades features, not the core.
- **No server, no queue, no web dashboard in v1.** Backup = copy two paths
  (`ledger.db`, `vault/`).

## 3. Data model and schemas

IDs: `BHV-` `EV-` `Q-` `SES-` `ACT-` + zero-padded integer. All timestamps
ISO 8601 UTC. Schemas below are abridged to normative fields; full drafts
live in `schemas/` (Phase 0 task).

### 3.1 Behavior — `schemas/behavior.schema.json`

```json
{
  "id": "BHV-0142",
  "statement": "A viewer-role user cannot bulk-delete records",
  "area": "permissions/records",
  "criticality": "red | high | normal | low",
  "links": {
    "demanded_by":   ["JIRA-812"],
    "verified_by":   [{"test_id": "tests/perm.spec.ts::viewer cannot bulk delete", "confidence": "high | medium | low"}],
    "implemented_in": ["src/records/**", "src/auth/roles.ts"],
    "violated_by":   ["INC-23"]
  },
  "confirmed_by": {"person": "ana", "at": "2026-06-10T09:00:00Z"},
  "created_by": "ingest:ci | interview | session | import | manual",
  "status": "active | retired",
  "notes": ""
}
```

Rules: `statement` must be a single falsifiable sentence (lint: no "and"
joining two promises — split instead). `criticality: red` is reserved for
money, permissions/roles, security, compliance, and data integrity.
`confirmed_by` absent ⇒ behavior is a proposal (I3). `retired` behaviors keep
their history; nothing is deleted (I11).

### 3.2 Evidence — `schemas/evidence.schema.json` (immutable, append-only)

```json
{
  "id": "EV-9311",
  "behavior_ids": ["BHV-0142"],
  "kind": "test_run | trace | screenshot | manual_observation | crawl | incident",
  "outcome": "supports | violates | inconclusive",
  "observed_at": "2026-06-08T03:12:44Z",
  "source": {"type": "ci", "ref": "run 8841", "url": "…"},
  "artifact": {"vault_path": "vault/sha256/ab/abcd…", "media_type": "application/zip"},
  "redaction": {"status": "clean | redacted | quarantined", "rules_hit": []},
  "link_confidence": "high | medium | low",
  "ingested_by": "ingest:playwright-json@1"
}
```

Rules: evidence is never edited or deleted; corrections are new records that
supersede (`supersedes: "EV-…"` optional field). `quarantined` evidence is
metadata-only — the blob was not stored (I10). `link_confidence: low`
evidence contributes at half weight to freshness (see §4).

### 3.3 Question — `schemas/question.schema.json`

```json
{
  "id": "Q-0031",
  "behavior_id": "BHV-0290 | null",
  "prompt": "Should viewer role be able to export records? No spec, test, or behavior covers it.",
  "why_asked": "gap: PR #412 adds /export endpoint; no behavior matches src/records/export.ts",
  "status": "open | answered | dismissed",
  "answer": {"by": "ana", "at": "…", "text": "No — export is admin+editor only."},
  "resulting_mutations": ["BHV-0291 created", "BHV-0291 confirmed"]
}
```

### 3.4 Session — `schemas/session.schema.json`

```json
{
  "id": "SES-0007",
  "engineer": "ana",
  "started_at": "…", "ended_at": "…",
  "observations": [
    {"at": "…", "note": "double-submit on coupon form creates two carts", "auto": false, "evidence_id": "EV-9402"}
  ],
  "proposals": {"behaviors": ["BHV-0312?"], "tests": ["draft: coupon double-submit"], "questions": ["Q-0042"]},
  "status": "open | in_review | merged | discarded"
}
```

### 3.5 Action receipt — `schemas/receipt.schema.json`

```json
{
  "id": "ACT-0019",
  "class": "selector_heal | flake_quarantine | flake_ticket | pr_comment | verdict_recompute | evidence_ingest",
  "target": "tests/checkout.spec.ts::applies coupon",
  "summary": "locator '#apply' → getByRole('button', {name: 'Apply'})",
  "evidence_basis": ["EV-9388 (failing)", "EV-9391 (green re-run)"],
  "revert": "git apply -R receipts/ACT-0019.patch | remove quarantine entry | delete comment id …",
  "performed_at": "…", "performed_by": "cartographer@0.1"
}
```

Rule: an `ACT`-tier action without a written receipt did not happen — the
gateway writes the receipt in the same transaction as the action (I4, I11).

## 4. Verdicts and decay

States: `VERIFIED`, `STALE`, `ASSERTED` (confirmed behavior, zero evidence),
`UNKNOWN` (no confirmed behavior or no info), `FAILING`.

**Hard rule first:** if the newest evidence with `outcome: violates` is newer
than the newest `supports` ⇒ `FAILING`, regardless of freshness.

Otherwise compute freshness `F ∈ [0,1]` from the newest supporting evidence:

```
F = exp(-Δt_days / τ_time(criticality)) × exp(-churn_lines / τ_churn) × W(link_confidence)
```

| Constant | red | high | normal | low |
|---|---|---|---|---|
| `τ_time` (days) | 7 | 14 | 30 | 90 |

- `churn_lines` = lines changed under `links.implemented_in` globs since
  `observed_at` of that evidence (from `git log --numstat`). `τ_churn = 400`.
- `W`: high = 1.0, medium = 0.85, low = 0.5.
- Thresholds: `F ≥ 0.50` ⇒ `VERIFIED` · `0.15 ≤ F < 0.50` ⇒ `STALE` ·
  `F < 0.15` ⇒ treated as `UNKNOWN` (with history shown).

All constants live in `config/decay.json` with a calibration note: tune after
two weeks of real data (Phase 10 task); changing constants requires a decision
note (Constitution §5). Verdict objects always carry
`{state, freshness, computed_at, newest_evidence_id}` — the renderer rejects
anything less (I2).

## 5. Storage and export

- `ledger.db` (SQLite): tables `behaviors`, `evidence`, `questions`,
  `sessions`, `receipts`, `mutations` (append-only audit: actor, at, table,
  record id, diff). WAL mode; one writer (the ingestion/gateway process).
- `vault/`: content-addressed blobs `vault/sha256/<2-char>/<hash>`; never
  mutated; orphan-sweep only via explicit `cart vault gc` with receipt.
- `cart export` → `export/ledger.jsonl` (one record per line, stable key
  order) — the `exportLedger()` function is deterministic given identical DB
  state (tested), for diff/review and for the I11 inspectability guarantee.
  Note: `cart export` is an `ACT` and records its own receipt + mutation, so
  two *consecutive* receipted exports differ by exactly that one receipt. For
  pure, byte-identical snapshots (diff, review, reproducible backup) use
  `cart export --no-receipt`, which writes the file without mutating the
  ledger. The receipted default keeps export in the audit trail (I4).

## 6. Ingestion contracts

Each ingestor: parse → **redact** → validate (AJV) → link → write. Redaction
patterns in `config/redaction.json` (secret regexes + team PII patterns);
a hit ⇒ scrub or quarantine per rule. Ingestors are idempotent (re-ingesting
the same run creates no duplicates; dedupe key = source ref + artifact hash).

| Ingestor | Input | Produces |
|---|---|---|
| `ingest:playwright-json` | Playwright JSON report (+ trace zips) | `EV` per test result, linked via `verified_by.test_id` |
| `ingest:junit` | JUnit XML | same, lower default `link_confidence` |
| `ingest:diff` | `git` ref range | churn data for decay; behavior-touch index for `cart pr` |
| `ingest:incident` | manual/webhook JSON `{title, behavior_ids?, occurred_at, url}` | `EV` with `outcome: violates`; queues a `Q` if no behavior matches |
| `ingest:crawl` | Playwright crawl script output | `EV(kind: crawl)` observations (reachability, console errors) |
| `ingest:session` | session stop payload **or ET-Kit session sheet** | `EV(kind: manual_observation)` + proposals |

**Linking:** deterministic first — exact `test_id` match, then annotation
match (`@bhv BHV-0142` in test title/annotations is the recommended team
convention), then area/path overlap. The LLM may *propose* links for the
residue; proposed links are `link_confidence: low` until a human confirms
(I3).

**ET-Kit compatibility (decision 0001):** `ingest:session` accepts, in
addition to the native stop payload, an **ET-Kit session sheet** — the
markdown produced by the separate exploratory-testing kit (observation log
lines `HH:MM | TAG | note | oracle | evidence-ref`, TAG ∈
BUG/ISSUE/QUESTION/IDEA). Mapping: BUG/ISSUE → `EV(kind:
manual_observation, outcome: violates)`; QUESTION → draft `Q` records;
IDEA → session proposals; referenced evidence files pass through the same
redaction stage before vaulting. The ET-Kit (user-level skills, separate
project) is the recommended interactive session front end; Cartographer's
own `cart session` (§7.6) remains the minimal native capture path. See
BUILD-PLAN Phase 8 scope note.

## 7. Surfaces (contracts + examples)

Every surface = deterministic data assembly → claims renderer → optional LLM
prose pass over the rendered rows. Examples below are output contracts, not
aspirations.

### 7.1 `cart ask "<question>"` — the 30-second answer

```
> cart ask "do we test coupon stacking?"
BHV-0093 "Two coupons cannot be applied to one cart"  VERIFIED  F=0.84  EV-9311 (CI, 2026-06-08)
BHV-0094 "Coupon applies before tax"                  STALE     F=0.22  newest EV 2026-04-30; 612 lines churn in src/pricing/** since
No confirmed behavior covers gift-card × coupon interaction → UNKNOWN.
[q] queue interview question for the gap   [d] details
```

Minimum-viable-map rule: `ask` answers only for areas with ≥1 confirmed
behavior; elsewhere it must answer `UNKNOWN` and offer to queue a question —
a cold map must not pretend (I1, I3).

### 7.2 `cart pr <ref>` — risk note

Assembly: diff → touched globs → behaviors via `implemented_in` overlap →
sort by `criticality × (1 − F)` → unmatched new files become gap candidates.

```
Cartographer — risk note for PR #412 (+182/−40 in src/records/**)
  BHV-0142 viewer cannot bulk-delete     [red]   STALE    F=0.31 (last EV 2026-05-12)
  BHV-0150 bulk-delete confirms count    [high]  VERIFIED F=0.78
  src/records/export.ts is new — no behavior covers it → queued Q-0031
Before merging I'd: 1) re-run @permissions suite (refreshes BHV-0142); 2) answer Q-0031.
Every line cites ledger rows; nothing above is inferred.
```

Posting the comment: `PROPOSE` by default; team may promote to `ACT` (it is
additive and reversible) after a two-week observation period.

### 7.3 `cart triage <run|report.json>` — failure clustering

Assembly: cluster failures by signature (error class + normalized locator +
stack hash) → deterministic heuristics classify
`product_bug | test_brittleness | environment`; residue goes to the LLM and
is **marked `inference`** → per cluster: affected behaviors, minimal-repro
proposal, recommended action.

Quarantine design: an entry in `quarantine.json`
`{test_id, ticket, entered_at, expires_at}` consumed by CI to route matching
tests into a separate **non-blocking lane**. Test source is never edited —
no `.skip` (I5). Default expiry 7 days; expiry without resolution escalates
in `cart brief`. Quarantine entry + ticket filing = `ACT` with receipt.

### 7.4 `cart brief` — the morning brief (one screen, hard limit)

Sections, in order: overnight verdict transitions (→`FAILING` first, then
`VERIFIED`→`STALE`); decayed `red`-criticality behaviors; today's open PRs ×
stale behaviors exposure; quarantine expiries; top 3 open questions. Footer:
ingestion health (I6).

### 7.5 `cart interview` — filling gaps with human meaning

One question at a time, always with `why_asked`. Answer → draft mutation
shown → inline human confirm applies it (the interview *is* the approval,
satisfying I3). Batch mode (`--batch 20`) exists for bootstrap only.

### 7.6 `cart session start|note|stop` — ride-along

`start` attaches passive observation (Playwright context events when
available; otherwise timestamped manual notes via `note`); auto-screenshot on
navigation. **No output until `stop`** (I8). `stop` → draft proposals
(behaviors observed, candidate regression tests, questions) into the review
queue; nothing merges without human review.

### 7.7 `cart status` — health

Per-ingestor last-success timestamps, record counts, freshness distribution
histogram, quarantine count, open questions. Any ingestor stale beyond its
SLA flips global health to degraded ⇒ banner on all surfaces (I6).

## 8. Query API (internal)

Core verbs the surfaces and the LLM rim are allowed to call:
`findBehaviors({text?, area?, globs?})`, `verdict(behaviorId)`,
`evidenceFor(behaviorId, limit)`, `gapsFor(globs)`, `openQuestions()`,
`health()`. Read-only. Mutations go exclusively through
`propose(mutation)` → validation → tier check → (human confirm | receipt).
**Forbidden query shape:** any per-person aggregation (I7) — the API rejects
`groupBy: person`.

## 9. Autonomy matrix (normative defaults)

| Action class | Tier | Notes |
|---|---|---|
| Ingest evidence; recompute verdicts; export | ACT | receipts via mutations log |
| File flake/incident ticket | ACT | receipt links cluster + evidence |
| Quarantine-lane entry (with ticket + expiry) | ACT | never edits test source |
| Selector heal (locator-only patch) | ACT | guardrails §10 + I12 self-evidence; else auto-revert → PROPOSE |
| Post PR risk-note comment | PROPOSE → ACT opt-in | additive, reversible |
| New test files; behavior statements; links above `low` confidence | PROPOSE | human confirm required (I3) |
| Any assertion change; expected-value change; repro scripts that mutate state | PROPOSE | always |
| Delete a test; weaken an assertion; `.skip`/`.fixme`; mark VERIFIED without evidence; per-person metrics; merge/commit to protected branches; fabricate evidence | NEVER | no code path (I4, I5, I7) |

## 10. Guardrails module — `src/guardrails.ts`

One exported pure function `patchViolations(original, patched): Violation[]`
applied to **every** patch Cartographer produces (heals and test proposals
alike). Rejects: test deletion (test-count drop), `.skip`/`.fixme`/`.only`
introduction, assertion weakening (`toBeTruthy`/`toBeDefined`/`not.toThrow`
substitutions), expected-value/literal changes inside assertion calls,
snapshot introduction. For `selector_heal` additionally: AST diff must be
confined to locator-string arguments of an allowlist
(`page.locator`, `getByRole/Text/Label/TestId/Placeholder`); any node outside
⇒ violation. One source of truth: the same function runs in the gateway and
in the unit tests.

## 11. Bootstrap protocol (cold start)

A blank map helps nobody; a lying map is worse (I6). Sequence:

1. **Import** (`cart bootstrap import <repo>`): parse the existing suite;
   draft one behavior proposal per test (title → statement), area from path,
   `criticality` guessed only for red-domain keywords, all unconfirmed.
2. **Batch interview** (`cart interview --batch 20`): the engineer confirms /
   edits / merges duplicates / discards. Target: ≥50 confirmed behaviors in
   one sitting.
3. **Evidence accrual:** wire `ingest:playwright-json` into CI; 3–5 runs give
   first real freshness values.
4. **Enable surfaces progressively:** `ask` (immediately, minimum-viable-map
   rule applies) → `brief` (after first decay cycle) → `pr` (after churn
   index built) → `triage` → `session`.
5. **Retro-validation:** replay 2–3 historical incident PRs through `cart pr`
   — the note should have flagged the incident's behavior. If not, fix
   linking before trusting the surface (BUILD-PLAN Phase 5).

## 12. Failure and degradation behavior

Ingestor failure ⇒ health degraded ⇒ banners (I6). DB corruption ⇒ restore =
copy back two paths; `cart export` after every successful brief gives a daily
JSONL snapshot for worst-case manual recovery. LLM unavailable ⇒ all surfaces
still work in rows-only mode (deterministic core stands alone); prose pass is
an enhancement, never a dependency.

## 13. Security and privacy

Redaction at ingestion (I10); `config/redaction.json` reviewed at adoption.
Vault is filesystem-permissioned; no network service exposes it. Tracker/CI
tokens live in env, never in the ledger. Receipts never contain secrets
(scrubbed by the same redaction pass).

## 14. Out of scope for v1

Web dashboard; multi-repo federation; flaky-evidence statistical weighting
beyond `link_confidence`; auto-generated test *suites* (only single candidate
tests via sessions/proposals); non-Playwright runner adapters (port exists,
implement on demand); IDE plugins.

## 15. Open design questions (honest)

1. **Behavior dedup at scale** — statement similarity will eventually need
   embedding-assisted merge proposals; v1 relies on the interview.
2. **Churn attribution precision** — glob overlap is coarse; consider
   coverage-map-assisted linking later.
3. **Multi-service products** — one ledger per deployable vs. federated map;
   deferred until a real adopter forces it.
4. **Evidence weighting for flaky tests** — a test that flips daily should
   support less than W suggests; revisit with real data in Phase 10.
