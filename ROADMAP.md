# ROADMAP.md — Cartographer v0.2 (validation + activation)

> Post-build roadmap. BUILD-PLAN.md (Phases 0–10) built the system; it is
> complete and green (233 tests). This roadmap takes the next five steps that
> turn a well-built artifact into a *validated, activated* one. Same rules as
> BUILD-PLAN: one phase = one PR, strictly serial, every phase ends in a
> runnable demo, DoD = `npm run check` green + demo recorded.

## Why these five, in this order

The deterministic core is done and tested, but: (a) it has only ever touched
hand-authored fixtures, and (b) three integrations are *defined but wired to
nothing real* (LLM rim, PR-comment posting, heal runner). Order is by
value-at-risk: prove it on reality first, lock that in with CI, then activate
the headline integration, then lower the adoption barrier, then pay tidy debt.

Status: `[ ]` todo · `[x]` done · `[~]` blocked (reason inline)

---

## Phase V1 — Real-repo validation (PR 1)
Goal: the map meets a codebase nobody designed it around, and we record what
breaks. This is the retro-validation bar from SPEC §11 against real data.
- [x] V1.1 Pick a real OSS repo with a Playwright **or** JUnit suite; vendor a
      captured CI report + a real `git diff` range into `testdata/real/` (no
      network at test time — fixtures are captured once, by hand).
      → sindresorhus/got `test/cache.ts` + `test/cookies.ts` (MIT, 37K).
- [x] V1.2 Cold-start it: `cart bootstrap import` → confirm a batch via
      `cart interview` → `cart ingest` the captured report. Record counts.
      → 55 proposals, 12 confirmed; cited `ask` answers.
- [x] V1.3 Run `ask` / `pr` / `brief` / `triage` against it; capture a
      findings log of every linking miss, bad area name, or weak statement.
      → 4 findings (2 silent-failure high-sev) in `docs/demos/v1-real-repo.md`.
- [x] V1.4 Fix the highest-value real defect surfaced (likely linking or
      area-derivation); add a regression test from the real fixture.
      → fixed test-dir discovery, area extension-strip, batch-abort-on-one-bad
      -title; 4 `V1:` regressions in `bootstrap.test.ts`.
**Demo:** `docs/demos/v1-real-repo.md` — the transcript + the findings log +
the fixes, on a repo we did not author. ✅ (2026-06-15; 237 tests green).

## Phase V2 — Self-CI + dogfooding (PR 2)
Goal: the tool that consumes CI gets CI, and ingests its own results.
- [x] V2.1 `.github/workflows/ci.yml`: `npm run check` on push/PR (Node 22).
- [x] V2.2 A `cart`-dogfood job: after tests pass, run `cart ingest junit`
      on Cartographer's own test results into a committed-or-artifact ledger;
      prove the ingestion pipeline runs unattended. → 237 testcases → 237
      evidence; honest finding logged (node:test JUnit `classname` vs bootstrap
      `test_id` mismatch → low linkage; not a bug, an adapter-format note).
- [x] V2.3 `cart guardrails-check` wired as a CI gate on changed test files
      (the §10 function is already exit-1-on-violation). → rehearsed
      positive (clean) + negative (test-deletion refused).
**Demo:** `docs/demos/v2-self-ci.md` — the workflow + the dogfood `cart status`
output + the gate rehearsal. ✅ (2026-06-15; no source changes — surfaces were
already CI-ready; 237 tests green).

## Phase V3 — Live LLM rim (PR 3)
Goal: activate the probabilistic rim the README promises, without breaking
the zero-dependency rule or any invariant.
- [x] V3.1 `AnthropicRimAdapter implements RimAdapter` using the built-in
      `fetch` (no SDK — dependency policy holds). Reads `ANTHROPIC_API_KEY`
      from env; absent ⇒ falls back to `NullRimAdapter` (rows-only, SPEC §12).
      → never-throws (non-200/refusal/network → undefined); model claude-opus-4-8.
- [x] V3.2 Wire the prose pass into `cart ask` (and only `ask` first):
      structured rows in → prose over rows out. The rim still gets **rows
      only** (Constitution §1); a prose pass that drops/contradicts a cited
      row is rejected (the renderer remains the source of truth, I1).
      → `renderAskWithProse`; `--prose` opt-in; `toRimRows` projection.
- [x] V3.3 Eval guard: a golden check that the prose never introduces an
      uncited claim or a behavior id absent from the rows it was given.
      → `proseCitesOnlyKnownIds`; hallucinated id ⇒ whole prose discarded.
**Demo:** `docs/demos/v3-llm-rim.md` — same `ask` rows-only vs. with-rim; key
unset ⇒ identical rows-only output; hallucination discarded. ✅ (2026-06-15;
254 tests; offline stubbed-fetch adapter).

## Phase V4 — Adoption on-ramp (PR 4)
Goal: a new user goes from clone to first answer in under 5 minutes.
- [x] V4.1 README quickstart: install → `cart init` → bootstrap → ingest →
      ask, copy-pasteable, matching real command output. → captured verbatim
      from the bundled got fixtures.
- [x] V4.2 `cart --help` / top-level usage parity check (a test asserts every
      documented command exists in the dispatch switch). → e2e test parses
      `cart help` and runs each command, asserting no "unknown command".
- [x] V4.3 A `cart doctor` (or `status`-extension) that reports environment
      readiness: Node version, `git` present, vault writable, config valid.
      → `src/doctor.ts`; git absent = warn (optional), others = fail.
**Demo:** `docs/demos/v4-quickstart.md` — a timed clean-clone-to-first-answer
run following only the README. ✅ (2026-06-15; ~1s command time; 262 tests).

## Phase V5 — Test-helper migration + tidy (PR 5)
Goal: finish the de-duplication started in the test-suite audit; pay debt.
- [ ] V5.1 Migrate the remaining ~16 integration tests to `test/helpers/`
      factories + `tempLedger`/`testCtx`; delete inline boilerplate.
- [ ] V5.2 Add a short `docs/testing.md`: the unit/integration/e2e tiers, how
      to run each, the helper conventions, the "no vacuous pass" rule.
**Demo:** `docs/demos/v5-tidy.md` — line-count delta + `test:unit` wall-clock.

---

## Dependency order
`V1 → V2 → V3 → V4 → V5` — strictly serial. V1 is the gate: if real data
breaks something fundamental, that reshapes everything after it.
