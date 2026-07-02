# BUILD-PLAN.md — Cartographer

> Agent-executable. One phase = one PR, strictly serial. Walking-skeleton
> rule: **every phase ends with a runnable demo.** Update checkboxes as you go.

## Binding rules for the executing agent

1. Read `CONSTITUTION.md` + `SPEC.md` before any code. Invariants I1–I12 are
   enforced in code, not prose — if a task and an invariant conflict, stop.
2. **Zero dependencies** beyond Node 22 built-ins + AJV. Pre-approved fallback
   only: `better-sqlite3` iff `node:sqlite` blocks — ask first.
3. The claims renderer (I1) and autonomy gateway (I4) are built **first** and
   every later surface must pass through them. No bypass paths, ever.
4. Schema changes ship with: updated examples, updated docs, migration (or a
   note that none is needed) in the same PR.
5. All decay/time logic uses an injected clock; tests never sleep.
6. Every `ACT` class lands with: receipt write, revert path, guardrail check,
   unit tests — or it doesn't land.
7. `>3` failed attempts on a task ⇒ stop and report findings.
8. DoD per phase: `npm run typecheck && npm run lint && npm run test && npm run validate:schemas` green + the phase demo recorded in the PR description.

Status: `[ ]` todo · `[x]` done · `[~]` blocked (reason inline)

---

## Phase 0 — Skeleton + enforcement primitives (PR 1)
Goal: the invariants exist as code before any feature does.
- [x] CG-0.1 Scaffold: TS strict, `node:test`, lint/format, `config/` (decay.json, redaction.json), repo layout per SPEC §1.
- [x] CG-0.2 `schemas/` for behavior, evidence, question, session, receipt (SPEC §3) + one generic AJV validator + `examples/` fixtures.
- [x] CG-0.3 `ledger.db` init + migrations harness + append-only `mutations` table (I11).
- [x] CG-0.4 **Claims renderer**: claim objects without citations or `inference` flag fail to render (I1); verdicts without `freshness/computed_at` rejected (I2). Unit tests prove both.
- [x] CG-0.5 **Autonomy gateway** `autonomy.ts`: tier table from SPEC §9; NEVER classes have no dispatch path (I4/I5); per-person aggregation rejected at query API (I7).
- [x] CG-0.6 `cart export` → deterministic JSONL (stable key order, tested).
**Demo:** create a behavior via CLI, export it, validate it, watch a citation-less claim get refused. ✅ recorded in `docs/demos/phase-0.md` (2026-06-10; 44 tests green).

## Phase 1 — Evidence ingestion (PR 2)
Goal: real CI runs become evidence.
- [x] CG-1.1 Vault: content-addressed write, never mutate; `cart vault gc` stub (receipt-gated).
- [x] CG-1.2 **Redaction stage** (I10): secret regexes + configurable PII; fail ⇒ quarantined metadata-only record. Tests with seeded secrets.
- [x] CG-1.3 `ingest:playwright-json` (+ trace zips) and `ingest:junit`; idempotent (dedupe key = source ref + artifact hash).
- [x] CG-1.4 Deterministic linking: `@bhv BHV-xxxx` annotation → exact `test_id` → path/area overlap; confidence per SPEC §6.
**Demo:** ingest a real Playwright report twice; EV records linked once, no dupes, secrets scrubbed. ✅ recorded in `docs/demos/phase-1.md` (2026-06-10; 66 tests green).

## Phase 2 — Decay engine + health (PR 3)
- [x] CG-2.1 Verdict computation per SPEC §4 (hard FAILING rule first); only constructor of verdicts (I2).
- [x] CG-2.2 `ingest:diff` churn index from `git log --numstat`.
- [x] CG-2.3 `cart status` + degraded-health banner injection at renderer level (I6).
- [x] CG-2.4 Table-driven decay tests with injected clock (time decay, churn decay, link-confidence weights, thresholds).
**Demo:** simulate 30 days + 600 churned lines; watch VERIFIED → STALE → UNKNOWN with correct numbers. ✅ recorded in `docs/demos/phase-2.md` (2026-06-10; 91 tests green).

## Phase 3 — First surface: `cart ask` (PR 4)
- [x] CG-3.1 Query API read verbs (SPEC §8); LLM rim adapter receives rows only — no DB handle.
- [x] CG-3.2 `cart ask` per SPEC §7.1 incl. **minimum-viable-map rule** (UNKNOWN + offer to queue a question for unmapped areas).
- [x] CG-3.3 Rows-only fallback mode (LLM unavailable ⇒ surface still works, SPEC §12).
**Demo:** the 30-second answer with citations on a seeded ledger; an unmapped area answers honestly. ✅ recorded in `docs/demos/phase-3.md` (2026-06-10; 103 tests green).

## Phase 4 — Bootstrap tooling (PR 5)
- [x] CG-4.1 `cart bootstrap import <repo>`: one unconfirmed behavior proposal per existing test (SPEC §11).
- [x] CG-4.2 `cart interview --batch 20`: confirm/edit/merge/discard loop; answers write `confirmed_by` (I3).
- [x] CG-4.3 Red-domain keyword guesser for `criticality` (proposal only).
**Demo:** cold-start a real repo to ≥50 confirmed behaviors in one sitting. ✅ recorded in `docs/demos/phase-4.md` (2026-06-11; 50 confirmed from own suite; 126 tests green).

## Phase 5 — `cart pr` risk notes (PR 6)
- [x] CG-5.1 Diff → globs → behaviors → rank by `criticality × (1−F)`; new files become gap candidates + queued questions.
- [x] CG-5.2 Note renderer per SPEC §7.2; posting = PROPOSE (ACT opt-in flag exists but defaults off).
- [x] CG-5.3 **Retro-validation:** replay 2–3 historical incident PRs; the note must flag the incident's behavior — if not, fix linking before merging this phase.
**Demo:** risk note on a real PR + the retro-validation transcript. ✅ recorded in `docs/demos/phase-5.md` (2026-06-11; 3/3 incidents flagged; 142 tests green).

## Phase 6 — `cart triage` + quarantine (PR 7)
- [x] CG-6.1 Failure clustering (error class + normalized locator + stack hash); deterministic classifier first, LLM residue marked `inference`.
- [x] CG-6.2 `quarantine.json` lane mechanism + CI consumption doc; entry+ticket = ACT with receipt; **no test-source edits** (I5).
- [x] CG-6.3 Expiry (7d) escalation wired for the brief.
**Demo:** triage a red run into clusters with repro proposals; quarantine one flake with receipt + ticket. ✅ recorded in `docs/demos/phase-6.md` (2026-06-11; 159 tests green). CI guide: `docs/quarantine-ci.md`.

## Phase 7 — `cart brief` + interview surface (PR 8)
- [x] CG-7.1 One-screen brief per SPEC §7.4 (hard length limit, ordered sections, health footer).
- [x] CG-7.2 `cart interview` single-question flow with `why_asked` + inline confirm-applies mutation (I3).
**Demo:** a morning brief off real data; answer one question and watch the ledger mutate with attribution. ✅ recorded in `docs/demos/phase-7.md` (2026-06-11; VERIFIED→STALE transition + Q→behavior; 172 tests green).

## Phase 8 — Ride-along sessions (PR 9)
> Scope note (2026-06-10, decision 0001): the separate **ET-Kit** (user-level
> exploratory-testing skills) is the preferred interactive session front end.
> Phase 8 is therefore primarily the ingestion *back end*: CG-8.1 stays
> minimal (manual notes; Playwright capture only if cheap), and CG-8.3 makes
> ET-Kit debriefs land in the ledger.
- [x] CG-8.1 `session start|note|stop`: passive capture (Playwright events when available, manual notes otherwise), auto-screenshot on nav; **silent until stop** (I8).
- [x] CG-8.2 Stop → proposals (behaviors, candidate tests, questions) into a review queue; nothing merges unreviewed.
- [x] CG-8.3 ET-Kit session-sheet importer for `ingest:session` (SPEC §6 mapping: BUG/ISSUE → EV, QUESTION → Q, IDEA → proposals; evidence files through redaction).
**Demo:** 10-minute exploratory session becomes 3 reviewed proposals + evidence; an ET-Kit session sheet ingests into the same review queue. ✅ recorded in `docs/demos/phase-8.md` (2026-06-11; native session + ET-Kit import; 184 tests green).

## Phase 9 — Selector heal (PR 10)
- [x] CG-9.1 `guardrails.ts` per SPEC §10 (one pure function; AST diff confined to locator-string args of the allowlist).
- [x] CG-9.2 Heal flow: patch → guardrails → apply → re-run → green EV linked in receipt, else **auto-revert + demote to PROPOSE** (I12).
**Demo:** heal a broken locator end-to-end with self-evidencing receipt; show a forbidden patch being refused. ✅ recorded in `docs/demos/phase-9.md` (2026-06-11; refused/reverted/healed paths; 201 tests green).

## Phase 10 — Evaluation + calibration + hardening (PR 11)
- [x] CG-10.1 Eval harness: golden-question set for `ask`; weekly random claim-citation audit (sample N claims ⇒ every citation resolves); triage precision vs. human labels; decline-rule check (I9).
- [x] CG-10.2 Calibrate `config/decay.json` against two weeks of real data; decision note required for changes. (v0.1 priors kept; procedure in `docs/decisions/0002`.)
- [x] CG-10.3 Backup/restore doc + daily export hook; redaction config review checklist. (`docs/operations.md`.)
- [x] CG-10.4 Adoption honesty doc: "don't adopt Cartographer if…" (one-off projects, no CI, no regression future). (`docs/adoption.md`.)
**Demo:** eval report + calibrated constants + a clean restore drill. ✅ recorded in `docs/demos/phase-10.md` (2026-06-11; 4/4 eval checks, restore drill; 216 tests green).

---

## Dependency order
`0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10` — strictly serial; the system is
genuinely usable from Phase 3 and earns trust phase by phase.
