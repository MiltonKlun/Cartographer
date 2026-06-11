# Cartographer — design kit v0.1

> **The map, not the pipeline.** Cartographer is an AI QA assistant built
> around a living model of the product under test — the **behavior ledger** —
> instead of a per-story artifact pipeline. It answers a QA engineer's actual
> interrupts ("is this PR safe?", "why is CI red?", "do we test X?", "can we
> ship?") with evidence-cited verdicts that decay honestly over time.
> Deterministic core, probabilistic rim: the LLM translates and proposes; it
> never mutates the ledger directly.

## The kit

| File | What it is | Who reads it |
|---|---|---|
| `CONSTITUTION.md` | The 12 invariants + vocabulary + anti-goals + amendment rule. Everything else is negotiable; this isn't. | Everyone, first |
| `SPEC.md` | Architecture, data model + schemas, decay formula, storage, ingestion contracts, the 7 surfaces, autonomy matrix, guardrails, bootstrap, failure behavior. | Builders |
| `BUILD-PLAN.md` | 11 phases, one PR each, atomic checkboxed tasks (CG-X.Y) with demos — written for an agent (e.g., Claude Code) to execute serially. | The executing agent |
| `skills/cartographer/SKILL.md` | The operating layer: how the assistant behaves on top of the built system — claim phrasing, surface routing, interview protocol, decline patterns. | The runtime assistant |

## Read order

- **Building it:** CONSTITUTION → SPEC → hand BUILD-PLAN to the agent, one
  phase per PR. The system is usable from Phase 3 (`cart ask`) onward.
- **Operating it:** install `skills/cartographer/` once Phase 3 ships.

## Design commitments worth knowing up front

- Node 22+ / TypeScript / `node:sqlite` — zero runtime dependencies except
  AJV; one pre-approved fallback (`better-sqlite3`), everything else is
  stop-and-ask.
- Invariants are enforced by code chokepoints (claims renderer, autonomy
  gateway, decay engine, guardrails), built in Phase 0 before any feature.
- Cold start is a first-class problem: bootstrap import + batch interview
  (SPEC §11), and a minimum-viable-map rule so an empty map says UNKNOWN
  instead of lying.
- The NEVER list and the anti-surveillance clause (no per-person metrics)
  cannot be loosened by configuration or by any executing agent.

*Status: Phases 0–2 complete (2026-06-10). Phase 0: enforcement primitives —
schemas + AJV validator, append-only ledger, claims renderer (I1/I2),
autonomy gateway (I4/I5/I7), deterministic `cart export`. Phase 1: evidence
ingestion — content-addressed vault, non-optional redaction stage (I10),
idempotent Playwright/JUnit ingestors, deterministic linking. Phase 2: decay
engine (the only verdict constructor, I2), git churn index, `cart status` +
degraded-health banners (I6). Phase 3: `cart ask` — query API verbs,
minimum-viable-map rule, rows-only rim (the system is now genuinely usable).
Phase 4: bootstrap tooling — `cart bootstrap import` (one unconfirmed
behavior per test), red-domain criticality guesser, `cart interview` batch
confirm/edit/merge/discard. Phase 5: `cart pr` risk notes — diff → at-risk
behaviors ranked by criticality×(1−F), new files → queued gap questions,
PROPOSE-by-default comment posting, and a retro-validation gate (3/3
historical incidents flagged). Phase 6: `cart triage` — failure clustering by
signature, deterministic product/brittleness/environment classifier (LLM
residue labeled `inference`), and the `quarantine.json` non-blocking lane
(entry = receipted ACT, never edits test source, 7-day expiry escalation).
Phase 7: `cart brief` (one-screen morning brief — overnight verdict
transitions via snapshot diff, decayed-red, quarantine expiries, top
questions, health footer) + `cart interview` single-question flow (the answer
is the approval, I3). Phase 8: ride-along sessions (`cart session
start|note|stop`, silent until stop — I8) + the ET-Kit session-sheet importer
(`cart ingest session`, the decision-0001 seam: BUG/ISSUE→evidence,
QUESTION→Q, IDEA→proposal, evidence redacted before vaulting). Phase 9:
selector heal — `guardrails.ts` (one pure `patchViolations`, the §10/I5
source of truth) + the self-evidencing heal flow (`cart heal`: guardrails →
apply → re-run → green evidence in receipt, else auto-revert + demote to
PROPOSE, I12). Phase 10: evaluation + calibration + hardening — the eval
harness (`cart eval`: claim-citation audit, golden ask set, triage precision,
decline rule I9), the decay-calibration procedure (`docs/decisions/0002`,
priors kept), operations/backup/restore + redaction-review checklist
(`docs/operations.md`), and the adoption-honesty doc (`docs/adoption.md`).

**All 11 phases (CG-0 → CG-10) are complete.** 216 tests; zero runtime
dependencies beyond AJV; every invariant enforced at a code chokepoint.
Demos: `docs/demos/phase-0.md … phase-10.md`.
The companion ET-Kit (exploratory testing) lives in a separate folder and
feeds `ingest:session` from Phase 8 on — see `docs/decisions/0001`.*
