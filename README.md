# Cartographer

[![ci](https://github.com/MiltonKlun/Cartographer/actions/workflows/ci.yml/badge.svg)](https://github.com/MiltonKlun/Cartographer/actions/workflows/ci.yml)

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

## Quickstart (clone → first answer in ~5 minutes)

Node 22.13+ required. From a clone:

```sh
npm install            # ajv + typescript + @types/node only
npm run build          # compile src/ → dist/
node bin/cart.mjs doctor   # check your environment is ready
```

`doctor` confirms the environment before you start:

```
cart doctor — environment readiness

  ✓ node: v22.19.0 (≥ 22.13)
  ✓ node:sqlite: available
  ✓ git: git version 2.51.0
  ✓ vault: writable (./vault)
  ✓ heal: no interrupted heal
  ✓ config: decay.json + redaction.json valid

READY — you can `cart init` and start.
```

Then cold-start a map from an existing test suite and ask it a question
(`<repo>` is any project with a test suite — here the bundled `testdata/real`
sample from the `got` library):

```sh
node bin/cart.mjs init                                   # create ledger.db
node bin/cart.mjs bootstrap import <repo> --apply --actor you
#   → scanned 2 test file(s) → 55 behavior proposal(s) (all unconfirmed)
node bin/cart.mjs interview --batch 20                   # confirm/edit/merge the proposals
node bin/cart.mjs ask "do we cache responses?"
#   BHV-0002 "Cacheable responses are cached"  ASSERTED  F=0.00  …  [BHV-0002]
```

Until you confirm a proposal in the interview, `ask` honestly answers
`UNKNOWN` and badges the matching proposals as unconfirmed — a cold map does
not pretend (I3). Once confirmed, `ASSERTED` means *confirmed as intended, but
not yet evidenced* — wire `cart ingest playwright <report.json>` into CI and
the verdicts become `VERIFIED` with real freshness. From there: `cart pr
<ref>`, `cart brief`, `cart triage <run>`. Add `cart ask … --prose` (needs
`ANTHROPIC_API_KEY`) for an LLM summary over the cited rows.

**Should you adopt it at all?** Read [`docs/adoption.md`](docs/adoption.md)
first — it's honest about when Cartographer is the wrong tool (no CI, one-off
work, you want per-person metrics).

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

## Status

**All 11 build phases (CG-0 → CG-10) are complete**, followed by a validation
+ activation roadmap (ROADMAP.md, V1–V5) and a critical-review hardening pass
(HARDENING-PLAN.md, in progress). The deterministic core (schemas + AJV,
append-only ledger, claims renderer, autonomy gateway, decay engine,
guardrails, redaction) is enforced at code chokepoints; the seven surfaces
(`ask`, `pr`, `brief`, `triage`, `status`, `session`, `heal`) all run; the
LLM rim (`--prose`) is wired rows-only over the core.

- **283 tests** (unit / integration / e2e), zero runtime dependencies beyond
  AJV. `npm run check` is the full gate (typecheck + lint + tests + schemas).
- Demos per phase in `docs/demos/` (`phase-0.md … phase-10.md`, `v1…v5`,
  `h1…`).
- The companion ET-Kit (exploratory testing) lives in a separate folder and
  feeds `ingest:session` from Phase 8 on — see `docs/decisions/0001`.

## Credits

Cartographer itself is MIT-licensed (see [`LICENSE`](LICENSE)). The
`testdata/real/` fixtures are unmodified test files vendored from the
MIT-licensed [sindresorhus/got](https://github.com/sindresorhus/got) for
real-repo validation — attribution and license in
[`testdata/real/README.md`](testdata/real/README.md).
