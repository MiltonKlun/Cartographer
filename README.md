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

*Status: design kit — no code exists yet. The next concrete step is
BUILD-PLAN Phase 0.*
