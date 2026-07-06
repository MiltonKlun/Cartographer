# HARDENING-PLAN.md — Cartographer v0.3 (review findings → fixes + publication)

> Third plan. BUILD-PLAN.md (Phases 0–10) built the system; ROADMAP.md (V1–V5)
> validated and activated it. This plan executes the findings of the 2026-07
> critical review: 9 confirmed defects, 2 architectural-softness items, and the
> project-level difficulties (publication, interview UX, dogfood linkage).
> Every finding referenced here was verified at runtime or in code — file and
> line references below were checked against HEAD `088b6fb`.

## Context — user decisions this plan is built on

- **Destination:** portfolio project (public, recruiters will read it) **and**
  a personal working tool. Consequences: LICENSE = MIT, README must stay
  truthful and current, CI must be proven green on a real GitHub runner, and
  the interview UX matters because the author is also user #1.
- **Remote:** `https://github.com/MiltonKlun/Cartographer.git` (Phase H5).
- **`ANTHROPIC_API_KEY`:** will be provided later ⇒ Phase H10 is blocked, not
  dropped.

## Rules for the executing model (same as BUILD-PLAN, restated)

1. **Strictly serial. One phase = one commit.** Do not start a phase until the
   previous one's DoD is green.
2. **DoD for every phase:** `npm run check` green (typecheck + lint + all
   tests + validate:schemas) **+** a demo file in `docs/demos/` named as given
   in the phase.
3. **Commit mechanics:** write the message to `.git/COMMIT_MSG_TMP.txt`, then
   `git commit -F .git/COMMIT_MSG_TMP.txt` (PowerShell quoting breaks `-m`).
   Trailer: `Co-Authored-By:` line per the active model.
4. **No new runtime dependencies.** `ajv` stays the only one. `node:readline`,
   `node:fs`, `fetch` are all built-in and allowed.
5. **Never weaken an existing test** to make a phase pass (I5 applies to us).
   New tests follow docs/testing.md: factories + `tempLedger`/`testCtx`,
   injected clocks, the no-vacuous-pass rule, negative cases for every guard.
6. **Regression-test naming:** prefix new review-fix tests with the task id,
   e.g. `test('H1.1: retired proposals never surface in search', ...)`.
7. **Clean demo artifacts** (temp DBs, stray `vault/`, root `ledger.db`)
   before committing.
8. **Do not scope-creep.** The "out of scope" list at the bottom is binding.

Status: `[ ]` todo · `[x]` done · `[~]` blocked (reason inline)

---

## Phase H1 — Ask-surface honesty (review A1 + A8)

Goal: `cart ask` never resurfaces a discarded proposal and never hides a
FAILING behavior below the row cut.

- [x] H1.1 **Filter retired records out of search.** In `src/query.ts`
      `searchBehaviors()` (~line 90) the candidate set is
      `this.ledger.allRecords('behaviors')` with no status filter, so
      interview-discarded proposals (status `retired`) come back and `ask`
      renders them as "[unconfirmed proposal — confirm via interview]".
      Verified only production caller is `src/ask.ts:35`; tests are the only
      other callers — the filter is safe.
      - [x] Add `.filter((b) => b.status === 'active')` to the candidate set
            before scoring.
      - [x] Regression test in `src/test/integration/ask.test.ts`: seed a
            proposal, retire it via `applyInterview` with a `discard`
            decision, then assert `assembleAsk` returns it in **neither**
            `rows` **nor** `unconfirmedMatches`, and `searchBehaviors` returns
            it not at all. → `H1.1: a discarded proposal never resurfaces`.
- [x] H1.2 **Sort before the cut.** In `src/ask.ts` `assembleAsk()` the
      `.slice(0, MAX_ROWS)` at line 35 runs **before** verdicts are computed
      and the FAILING-first sort at line 52 — a FAILING behavior at
      relevance rank 6 is silently dropped, contradicting "FAILING leads,
      always" (SKILL.md).
      - [x] Remove the slice from line 35; build `rows` for **all** confirmed
            matches; apply the existing sort; then `rows = rows.slice(0,
            MAX_ROWS)`. Cap `unconfirmedMatches` separately at `MAX_ROWS`.
      - [x] Regression test: seed 6 confirmed behaviors sharing a query token
            where the **lowest-scoring** one has `violates` evidence; assert
            it is `rows[0]` and `rows.length <= 5`. → `H1.2` (verified to fail
            against the pre-fix slice-before-sort code).
      - [x] Confirm the `partial` flag semantics (computed from the final
            `rows`) still pass the existing partial-match tests unchanged.

**Done 2026-07-02** (264 tests green). Also: project-wide `VIOLATED → FAILING`
rename (friendlier verdict word; computed state, no data migration).

**Demo:** `docs/demos/h1-ask-honesty.md` — before/after transcript of the
discarded-proposal probe and the rank-6-FAILING probe.

## Phase H2 — Heal integrity: real revert + crash window (review A2)

Goal: the heal receipt's revert instruction points at an artifact that
actually exists, and a crash mid-heal can no longer leave an unreceipted
source mutation on disk.

Verified defect: `src/heal.ts:79` writes
`revert: 'restore ${proposal.file} from pre-heal source (kept in the
receipt's patch)'` — **nothing stores that source anywhere**. And between
`ports.applyPatch(...)` (line 63) and the receipt (line 74+), a crash during
`ports.rerun(...)` leaves the patched file with no record.

- [x] H2.1 **Vault the pre-heal source.** Add a `vaultRoot: string` parameter
      to `runHeal(...)`. After guardrails pass and **before** `applyPatch`,
      call `vaultWrite(vaultRoot, proposal.originalSource)` (`src/vault.ts`,
      content-addressed, already exists) and change the receipt's `revert`
      text to reference the returned VaultRef's vault path, e.g.
      `restore ${proposal.file} from vault ${ref.path}`.
      - [x] Update callers: `cmdHeal` in `src/cli.ts` (added `--vault`) and the
            heal tests (`setup()` now returns a `tempVaultPath()`).
      - [x] Test `H2.1`: run a green heal, extract the vault path from the
            receipt's `revert` string, `vaultRead` it, assert content equals
            `originalSource` byte-for-byte. → passing + driven via real CLI.
- [x] H2.2 **In-flight journal closes the crash window.** Immediately before
      `applyPatch`, write `join(vaultRoot, 'heal-inflight.json')` containing
      `{ file, testId, behaviorId, vaultPath, startedAt }`. Delete it on
      every resolved exit (`healed`, `reverted`). If the journal already
      exists when `runHeal` starts, **refuse** to run (new `interrupted`
      outcome) and tell the operator to restore `file` from `vaultPath`.
      - [x] Test `H2.2a`: throwing `ports.rerun` leaves the journal; its
            `vaultPath` resolves via `vaultRead` to the original source.
      - [x] Test `H2.2b`: with a leftover journal present, a fresh `runHeal`
            returns `interrupted` and applies no patch.
      - [x] Test `H2.2c`: green heal and reverted heal both leave **no**
            journal behind.
- [x] H2.3 **`cart doctor` surfaces an interrupted heal.** `checkHealJournal`
      in `src/doctor.ts`: leftover `heal-inflight.json` under the vault root ⇒
      `fail` with the file + vault path to restore from (I6). Unit test both
      directions; driven via real `cart doctor` (exit 1).

**Demo:** `docs/demos/h2-heal-integrity.md` — a receipt whose revert path is
opened and verified; the simulated-crash transcript + doctor output.

**Done 2026-07-02** (269 tests green; green/interrupted/doctor/blocked paths
driven end-to-end against real `bin/cart.mjs`).

## Phase H3 — Health SLA realism (review A3)

Goal: a once-used ingestor stops poisoning health forever; deliberately
expected feeds still degrade loudly when they stop.

Verified defect: `src/health.ts` `computeHealth()` tracks **every** actor ever
seen with prefix `ingest:` against a single fixed `DEFAULT_SLA_HOURS = 26`,
forever. One ad-hoc JUnit import ⇒ the map is DEGRADED for life, which trains
users to ignore the I6 banner.

- [x] H3.1 **Retirement window (default behavior).** Added
      `retirement_hours` (default `336` = 14 days). An ingestor past it (and
      not expected) becomes `inactive` — new `state: 'fresh'|'stale'|'inactive'`
      on `IngestorStatus` (`withinSla` retained = `state==='fresh'`), excluded
      from degradation. Between SLA and retirement, stale/degraded unchanged.
- [x] H3.2 **Optional `config/health.json`.** `loadHealthConfig(path?)` mirrors
      `loadDecayConfig`; missing/broken file ⇒ all defaults (never throws).
      `expected_ingestors` entries never retire — they degrade health until
      they ingest again. Shipped `config/health.json` with documented defaults
      + empty `expected_ingestors` (no behavior change until a user lists one).
- [x] H3.3 **Tests** (`src/test/integration/health.test.ts`):
      - [x] existing 17h-fresh / 48h-degraded cases pass unchanged;
      - [x] 400h-stale **unlisted** ⇒ `degraded: false`, `state: 'inactive'`;
      - [x] 400h-stale **listed** in `expected_ingestors` ⇒ `degraded: true`;
      - [x] `computeStatus` distinguishes inactive / fresh / stale.
- [x] H3.4 **Docs:** added a Health-SLA section to `docs/operations.md`
      (state table, defaults, the `expected_ingestors` contract); `cart status`
      labels inactive ingestors `inactive (not counted against health)`.

**Demo:** `docs/demos/h3-health-sla.md` — the one-time-ingestor trap and the
expected-ingestor case, both driven against real `cart status`.

**Done 2026-07-02** (273 tests green; trap→OK and expected→DEGRADED confirmed
via real `bin/cart.mjs status`).

## Phase H4 — CLI + classifier correctness (review A5 + A7)

Goal: `cart pr` does what its comment claims; the criticality guesser stops
flagging "payload" and "Taxi" as money.

- [x] H4.1 **`cmdPr` single-ref handling.** Extracted a pure `resolvePrRef`
      into `src/diff.ts` (unit-testable): `..`-range ⇒ pass through; `/^\d+$/`
      ⇒ actionable error (git cannot diff a PR number; suggests base ref,
      range, or `gh pr diff N > pr.diff`); else ⇒ `${ref}...HEAD` (merge-base).
      `cmdPr` calls it and `fail()`s on the error; the misleading comment is
      gone.
- [x] H4.2 **Tests.** Unit tests on `resolvePrRef` (range / base→...HEAD /
      bare-number-refused). Driven end-to-end against a real throwaway repo:
      `cart pr <base> --repo` produced a risk note over the branch diff
      (`+1/−1 in src/records/**`); bare `cart pr 412 --repo` exited 1 with the
      guidance (the old code produced `fatal: ambiguous argument '412'`).
- [x] H4.3 **Criticality word boundaries** (`src/criticality.ts`). Rebuilt
      `DOMAIN_RULES` from a `rule(words, stems)` helper: complete words get
      both boundaries (`\bpay\b`), deliberate stems (invoic/subscri/authoriz/
      authentic/privileg/complian/encrypt/sanitiz/vulnerab/corrupt/bulk) keep
      leading-boundary prefix matching. `auth` is a word (so "author" ≠ auth).
      - [x] Regression tests: payload⇒normal, Taxi⇒normal, author⇒normal,
            Cartesian/Cartographer⇒not high; Tax/Payment/auth/authorization/
            authentication⇒red; invoice/subscription stems⇒red. All 10
            original red/high/normal cases still pass.
- [x] H4.4 **Re-measured on the got fixtures.** Honest finding: the 2-file /
      55-proposal got set produces **0 red under both old and new** regex — it
      contains no "payload"/"Taxi"/"author"-type leading tokens, so there is no
      delta on this corpus. The fix is validated by the targeted unit cases,
      not by got. Recorded in the demo.

**Demo:** `docs/demos/h4-cli-classifier.md` — the `git diff 412` failure vs the
new message; the classifier before/after cases; the honest zero got-delta.

**Done 2026-07-02** (283 tests green; `cart pr` bare-number-refused and
base-ref paths driven against a real repo).

## Phase H5 — Publication: LICENSE + GitHub + first real CI run (review C2, C3)

Goal: the repo becomes the public portfolio artifact it is meant to be, and
the CI workflow — written blind in V2, never executed — runs on a real
Ubuntu runner and comes back green.

- [x] H5.1 **LICENSE.** MIT, `Copyright (c) 2026 Milton Klun`; `"license":
      "MIT"` added to `package.json` (`"private": true` kept). README Credits
      section attributes the vendored got fixtures + Cartographer's MIT.
- [x] H5.2 **README truth pass.** Dropped the stale `design kit v0.1` title
      and `Phases 0–2 / 216 tests` footer (now 283); added the `heal` line to
      the doctor sample; made the `ask` example honest (UNKNOWN-until-confirmed,
      I3); added the CI-badge slot. `docs/demos/` left untouched (historical).
- [x] H5.3 **First push.** `master → main`; remote added; tree verified clean
      (no tracked db/vault/dist); secret scan found only the canonical fake
      `AKIAIOSFODNN7EXAMPLE` + `hunter2` in redaction fixtures (deliberately
      fake). Remote had an identical placeholder LICENSE on an unrelated
      `Initial commit` → rebased onto it (no force-push); pushed
      `46c6ec8..aa11cee`.
- [x] H5.4 **CI green on a real runner.** First `ubuntu-latest` run
      (28699137372, sha aa11cee) came back `success` — `check` + `dogfood`
      both green, **no Ubuntu fixes needed** (the test glob is Node-expanded,
      no Windows paths in src). Verified via the public Actions API.
- [x] H5.5 **Badge + demo.** README CI badge points at the real
      `ci.yml/badge.svg` (verified HTTP 200); demo links the green run.

**Demo:** `docs/demos/h5-publication.md` — link to the green Actions run
(none-needed on Ubuntu), the LICENSE line, the rebase-onto-placeholder note.

**Done 2026-07-04** (repo public; CI green on real runner; no CD by design —
CLI, not a service).

## Phase H6 — Interview inline confirm (review C1 — the biggest UX gap)

Goal: confirming 50 bootstrap proposals is one command and one keystroke per
proposal, as SPEC §7.5 intends — not one hand-typed CLI invocation each, not
hand-authored JSON.

- [x] H6.1 **Testable driver, IO injected.** `src/interview-live.ts`:
      `runInterviewLoop(ledger, io, actor, clock)`, injected
      `InterviewIO = { ask, say }`. Card per proposal + the y/e/m/d/s/q menu.
      y confirm · e edit-then-confirm (empty=keep) · m merge (invalid/
      unconfirmed target ⇒ refused + skipped — chose skip over "re-prompt
      once", simpler, user re-runs `--live`) · d discard · s/empty skip · q
      quit. Each decision applied immediately via `applyInterview` (durable on
      quit). Returns `{ confirmed, merged, discarded, skipped, remaining }`.
- [x] H6.2 **CLI wiring.** `cart interview --live --as <actor>` over stdin.
      Note: `readline/promises` `question()` hangs after piped-EOF, so the CLI
      drives off the `line` event with a queue that returns a quit sentinel on
      close (works for TTY and pipes). Single-question/batch modes untouched;
      `--batch` output now points at `--live`.
- [x] H6.3 **Tests.**
      - [x] Integration (`interview-live.test.ts`, 8): every branch
            (y/e/m valid + invalid/d/s/q/unrecognized) + durable-quit
            persistence.
      - [x] E2e (`cli.test.ts`, +2): spawn `interview --live --as eval` with
            `y\nq` piped over a got-bootstrapped ledger ⇒ exit 0, 1 confirmed,
            rest pending; `--as` required ⇒ exit 1.
- [x] H6.4 **Docs.** README quickstart confirm step is `cart interview --live`;
      SPEC §7.5 parity noted in the demo.

**Demo:** `docs/demos/h6-interview-live.md` — a real transcript confirming a
got-fixture bootstrap batch, with the summary line.

**Done 2026-07-04** (293 tests green; the loop driven end-to-end over real
piped stdin against `bin/cart.mjs`).

## Phase H7 — Deep-link correctness: merge relink + rim guard v2 (review A6 + A4)

Goal: a merged behavior inherits its duplicate's evidence history, and the
prose guard rejects verdict-upgrading prose, not just unknown ids.

- [x] H7.1 **Record the merge on the retired side.** `merged_into?: string`
      added to the `Behavior` type + behavior schema (optional, no migration).
      `applyInterview`'s merge case sets it on the retired duplicate.
- [x] H7.2 **Alias-aware verdicts.** `computeVerdict(…, aliasIds?)` +
      `conclusiveEvidence` matches the behavior id OR any alias.
      `mergedAliasesOf(behaviors, id)` (pure, transitive, cycle-guarded ≤10
      hops) feeds it. **Consistency fix beyond the plan:** the CLI surfaces
      `cart verdict` and `cart brief` called `computeVerdict` directly and so
      still showed ASSERTED — caught by driving the real binary; routed both
      through the resolver (verdict via QueryApi, the single accessor I2).
- [x] H7.3 **Tests.** Survivor inherits the duplicate's newest evidence ⇒
      VERIFIED, newest = the duplicate's; 2-hop chain A→B→C resolves to C;
      hand-crafted cycle terminates with a sane verdict. Driven end-to-end via
      real `cart verdict` (ASSERTED → VERIFIED F=0.96 after merge).
- [x] H7.4 **Rim guard v2** (`src/rim.ts`). `proseContradictsVerdicts` maps
      state-claim words → asserted state; a state no row carries ⇒ discard.
      Wired into `renderAskWithProse` alongside the id guard.
      - [x] Tests: STALE + "fully verified" ⇒ discarded (the review probe);
            VERIFIED + "verified" ⇒ kept; no state word ⇒ kept; mixed rows
            satisfied by any; **pinned limitation**: "not verified" over STALE
            conservatively discarded (word-level, no negation parsing) — safe
            since rows are always shown.

**Demo:** `docs/demos/h7-deep-links.md` — merged-behavior verdict before/after;
the verdict-upgrade probe from the review now discarded.

**Done 2026-07-06** (301 tests green; merge-relink driven via real
`cart verdict`; rim guard unit-proven incl. the review probe).

## Phase H8 — Dogfood linkage: JUnit classname ↔ test_id (review C4b)

Goal: Cartographer's own CI dogfood evidence actually links to behaviors
(V2 finding: node:test JUnit `classname` never matches bootstrap `test_id` ⇒
~98% of self-evidence unlinked).

- [x] H8.1 **Captured the real shapes.** node:test's JUnit reporter emits
      `classname="test"` and **no** `file` attr — the only identity is `name`
      (the title). Sample in `testdata/self/junit-sample.xml`; the mapping rule
      (match on the shared `::<title>` half) was written in the demo table
      before coding.
- [x] H8.2 **Implemented the mapping** as a new linking tier in
      `src/linking.ts` (step 3, `title_suffix`): `titleOf(testId)` = the half
      after the last `::`; a **unique** title match links at `medium`
      (inference, never high). Exact test_id still wins; ambiguous titles are
      skipped, not mislinked (I3).
- [x] H8.3 **Regression.** `linking.test.ts` (+4: suffix match / exact-wins /
      ambiguous-not-mislinked / path-wins-when-ambiguous);
      `dogfood-linkage.test.ts` (+2: bootstrap this repo's `src/test`, ingest
      the sample, assert linkage > 0 and rate ≥ 50%, all derived links medium).
- [x] H8.4 **Measured end-to-end.** On Cartographer's own 306-row JUnit:
      **~1% → 85%** linked (257 medium + 3 high); the ~15% unlinked are
      template-literal titles bootstrap can't resolve. CI dogfood job runs the
      same path — confirmed green on push.

**Demo:** `docs/demos/h8-dogfood-linkage.md` — the mapping table, the rate
before/after (1% → 85%), the CI run.

**Done 2026-07-06** (307 tests green; real dogfood linkage 85%, up from ~1%).

## Phase H9 — Debt pins + optional hardening (review A9, B1, B2)

Goal: the accepted limitations are written down where an adopter will look,
and the one cheap compile-time hardening is attempted.

- [ ] H9.1 **Single-writer note** (`docs/operations.md`): `nextId` reads
      `MAX(id)` and inserts in separate transactions (`src/db.ts`), so two
      concurrent `cart` processes on one DB can collide — the failure is a
      loud PK violation, not corruption. Multi-writer is unsupported; run one
      `cart` at a time per ledger. No code change.
- [ ] H9.2 **(OPTIONAL — attempt, abandon freely)** Branded `Verdict`:
      phantom-brand the type (`type Verdict = VerdictData & { readonly
      [brand]?: never }` pattern, type-level only — must remain a plain JSON
      record at runtime; the AskRow JSON-round-trip test must still pass)
      with the only mint in `computeVerdict` (`src/decay.ts`). Purpose: code
      outside decay.ts cannot hand-construct a `Verdict` without a visible
      cast. If it fights `exactOptionalPropertyTypes` or turns into >1h of
      churn, drop it and note why in the demo — this is hardening, not a
      feature.
- [ ] H9.3 **Scaling posture pin** (`docs/decisions/0003-defer-query-scaling.md`):
      ~31 `allRecords(` call sites do full-table `JSON.parse` per command;
      fine at current scale; revisit when `cart ask` exceeds ~500 ms wall
      clock or evidence exceeds ~50k rows; the known fix is SQL-side
      filtering behind the existing Ledger API. Decision: deferred until real
      data demands it (consistent with SPEC §15 and decision 0002).

**Demo:** `docs/demos/h9-debt-pins.md` — the two doc pins; branded-type
outcome (landed or dropped-with-reason).

## Phase H10 — Live rim validation `[~]` (review C4a)

**Blocked: needs `ANTHROPIC_API_KEY` from the user.** The AnthropicRimAdapter
has passed only stubbed-fetch tests; the wire contract has never been
exercised for real.

- [~] H10.1 With the key in env: one real `cart ask --prose` against the
      got-fixture ledger. Capture the transcript (never the key), confirm the
      guards (id + H7.4 verdict) behave on real prose, record model id and
      token cost in the demo.
- [~] H10.2 If the wire contract mismatches (headers, body shape,
      `stop_reason` handling), fix the adapter minimally and add the observed
      response shape to the stubbed-fetch fixtures so it stays pinned
      offline.

**Demo:** `docs/demos/h10-live-rim.md` — rows-only vs live-prose output, guard
behavior, cost line.

---

## Dependency order

`H1 → H2 → H3 → H4 → H5 → H6 → H7 → H8 → H9`, with `H10` unblocked whenever
the key arrives (it only needs H5, so it can interleave after that).

Rationale: H1–H4 fix defects in already-shipped behavior — cheapest, highest
truth-value, and they must land **before** the repo goes public in H5 so the
portfolio artifact doesn't showcase known bugs. H5 before H6–H8 so every later
phase gets a real CI run on a real runner. H8 needs H5 (the dogfood job runs
in Actions). H9 is debt paperwork and goes last.

## Out of scope — binding (review §D, SPEC §14/§15)

Do **not** build any of the following while executing this plan, even if a
task seems adjacent: a web dashboard or TUI beyond the readline loop;
embedding/semantic search; an ORM or query-layer rewrite (H9.3 pins the
trigger conditions instead); decay-constant recalibration (decision 0002 —
needs two weeks of real adoption data); multi-repo federation; per-person
metrics of any kind (I7); new runtime dependencies; npm packaging/publishing
(`private: true` stays).
