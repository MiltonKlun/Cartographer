# Phase 5 demo — 2026-06-11

> BUILD-PLAN Phase 5 DoD: `npm run check` green (typecheck + lint + 142
> tests + validate:schemas) + this demo: a risk note on a real PR + the
> retro-validation transcript.

## Risk note (the SPEC §7.2 scenario)

Seeded: a stale red behavior and a fresh high behavior in `permissions/records`,
plus a PR that edits `src/records/delete.ts` and adds `src/records/export.ts`.

```
> cart pr 412 --diff pr-412.diff --queue
Cartographer — risk note for PR 412 (+242/−40 in src/records/**)
BHV-0001 viewer cannot bulk-delete records  [red]   UNKNOWN  F=0.01  (newest: EV-0001)  [BHV-0001, EV-0001]
BHV-0002 bulk-delete confirms count         [high]  VERIFIED F=0.90  (newest: EV-0002)  [BHV-0002, EV-0002]
UNKNOWN: src/records/export.ts is new — queued Q-0001
inference: before merging I'd: 1) re-run the suites covering BHV-0001 to
refresh their evidence; 2) answer Q-0001.
Every behavior line cites ledger rows; only the recommendation is inferred.
```

- Behaviors are ranked by `criticality × (1 − F)`: the stale red one leads
  the fresh high one.
- The new `export.ts` is uncovered → a gap candidate → `--queue` filed
  `Q-0001` (a question, never a guessed behavior — I3).
- Every behavior line carries citations + a complete verdict (I1/I2); the
  only un-cited line is explicitly labeled `inference`.

### Posting the comment is PROPOSE by default (CG-5.2)

```
> cart pr 412 --diff pr-412.diff --post
[comment is PROPOSE-tier: draft ready, not posted. Re-run with --post-act
 after the 2-week observation period to auto-post (SPEC §7.2).]
```
`--post-act` flips it to an ACT (additive, reversible) that writes a receipt
— opt-in only, exactly the autonomy-matrix default.

## Retro-validation (CG-5.3) — the gate

Three historical incidents replayed through `cart pr`; each note **must**
flag the incident's behavior or linking is wrong and the surface is not
trusted. Encoded as tests in `src/pr.test.ts` so the gate runs every build:

```
ok - retro-validation — INC-23: viewer bulk-delete regression in a records PR: note flags BHV-0142
ok - retro-validation — INC-31: coupon stacking regression in a pricing PR:   note flags BHV-0093
ok - retro-validation — INC-44: auth bypass in a session-handling PR:         note flags BHV-0210
```

All three pass: the incident behavior is not only present but ranks first in
each note. Linking (Phase 1) is sound enough to trust `cart pr`.

## What this phase added

- `src/diff.ts` (CG-5.1) — numstat parsing (`GitDiff` port + `diffFromText`
  for captured diffs), binary-safe, new-file detection from `create mode`.
- `src/pr.ts` (CG-5.1/5.2) — `assembleRiskNote` (diff → implemented_in
  overlap → rank by criticality×(1−F); uncovered new source files → gaps),
  `queueGaps` (gap → Q, I3), `renderRiskNote` (SPEC §7.2 format, cited rows
  + labeled recommendation). Confirmed behaviors only (I3). Comment posting
  is PROPOSE; `--post-act` opt-in promotes to a receipted ACT.
- CLI: `cart pr <ref> [--repo D | --diff F] [--queue] [--post|--post-act]`.
- `src/pr.test.ts` — risk-note tests + the 3-case retro-validation gate.
