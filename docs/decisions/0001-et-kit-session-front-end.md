# 0001 — ET-Kit is the session front end; Cartographer ingests its sheets

- **Date:** 2026-06-10
- **Status:** accepted
- **Scope:** SPEC §6 (`ingest:session` inputs), BUILD-PLAN Phase 8 (new
  CG-8.3, scope note). No constitution change; no invariant touched.

## Context

A separate, portable exploratory-testing kit ("ET-Kit") exists: user-level
Claude Code skills (`exploratory-session`, `bug-report`) plus Chrome
DevTools / Playwright MCPs. It already produces structured session sheets
(timestamped observations tagged BUG/ISSUE/QUESTION/IDEA with evidence
paths) and shares Cartographer's core rules (evidence or silence, meaning
is human, destructive actions propose-only).

Cartographer's BUILD-PLAN Phase 8 planned its own interactive ride-along
front end (`cart session`), duplicating what ET-Kit does better (tours,
heuristics, parallel sweeps), while ET-Kit sessions left findings as
markdown that doesn't compound.

## Alternatives considered

1. **Fuse ET-Kit into Cartographer as a module** — rejected: destroys
   ET-Kit's portability (its skills work on any project, ledger or not),
   couples a working tool to an unbuilt one, and puts an LLM-skill layer
   inside what the constitution requires to be a deterministic core.
2. **Build an import/call bridge between two projects** — rejected:
   user-level skills are already available in every project; a bridge is
   redundant plumbing.
3. **Two layers, one data seam (chosen):** ET-Kit = interactive session
   front end; Cartographer = memory. `ingest:session` accepts ET-Kit
   session sheets as a first-class input.

## Consequences

- SPEC §6 gains the ET-Kit compatibility paragraph (mapping: BUG/ISSUE →
  `EV(kind: manual_observation, outcome: violates)`, QUESTION → `Q`,
  IDEA → proposals; evidence through redaction).
- BUILD-PLAN Phase 8 shrinks: CG-8.1 stays minimal, new CG-8.3 implements
  the sheet importer.
- ET-Kit remains a separate repository/folder; nothing in Cartographer
  depends on it at runtime — absence of ET-Kit degrades nothing (adapter
  pattern, SPEC §2).
