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

- [ ] H4.1 **`cmdPr` single-ref handling** (`src/cli.ts:378–387`). Current
      code passes a bare ref straight to `git diff` (`git diff 412` ⇒
      "unknown revision") while the comment claims base-diffing. Change the
      no-`..` branch:
      - contains `..` ⇒ pass through unchanged;
      - matches `/^\d+$/` ⇒ `fail()` with:
        `"NNN" looks like a PR number — git cannot diff a number. Pass a base
        branch/SHA (e.g. main), a range (main...HEAD), or --diff <file>
        (capture one with: gh pr diff NNN > pr.diff)`;
      - otherwise ⇒ diff `` `${ref}...HEAD` `` (merge-base semantics: what
        changed on HEAD since diverging from `ref` — the PR meaning).
      - [ ] Rewrite the line-383 comment to describe the real behavior.
- [ ] H4.2 **Tests.** Build a real throwaway repo (pattern:
      `src/test/integration/churn.test.ts`): commit on `main`, branch, commit
      a test-file change, and assert single-ref `main` from the branch HEAD
      yields the branch's changed files. E2e (or fail-capturing) test: bare
      `412` exits non-zero with the guidance message.
- [ ] H4.3 **Criticality word boundaries** (`src/criticality.ts`,
      `DOMAIN_RULES`). Verified false positives: "payload" → red (matched
      `pay`), "Taxi" → red (matched `tax`); also `cart` prefix-matches
      "Cartesian"/"Cartographer" in the `high` rule and `auth` prefix-matches
      "author". Rule to apply: every alternation token that is a **complete
      word** gets a trailing `\b` (`pay\b`, `tax\b`, `cart\b`, `auth\b`,
      `acl\b`, `pci\b`, `pii\b`, …); deliberate stems keep prefix-matching
      and get listed in a comment above the rule naming them as stems
      (`invoic`, `subscri`, `authoriz`, `authentic`, `privileg`, `complian`,
      `sanitiz`, `vulnerab`, `encrypt`, …). First-match-wins order unchanged.
      - [ ] Regression tests (unit, `criticality.test.ts`):
            "Parses the response payload correctly" ⇒ `normal`;
            "Taxi fare screen renders" ⇒ `normal`;
            "Tax is applied at checkout" ⇒ `red`;
            "Payment succeeds with a saved card" ⇒ `red`;
            "The author byline renders" ⇒ `normal`;
            "Cartesian grid renders" ⇒ not `high` via `cart`.
- [ ] H4.4 **Re-measure on real data:** re-run the bootstrap over the vendored
      got fixtures; record the red/high count delta vs the V1 numbers in the
      demo.

**Demo:** `docs/demos/h4-cli-classifier.md` — the `git diff 412` failure on
HEAD~1 vs the new message; the classifier before/after table; got-fixture
delta.

## Phase H5 — Publication: LICENSE + GitHub + first real CI run (review C2, C3)

Goal: the repo becomes the public portfolio artifact it is meant to be, and
the CI workflow — written blind in V2, never executed — runs on a real
Ubuntu runner and comes back green.

- [ ] H5.1 **LICENSE.** MIT, `Copyright (c) 2026 Milton Klun`. Add
      `"license": "MIT"` to `package.json` (keep `"private": true` — this is
      not an npm package; it prevents accidental publish). Add a one-line
      credits note in the README pointing at `testdata/real/README.md` (the
      vendored `got` files are MIT-attributed there already).
- [ ] H5.2 **README truth pass.** H1–H4 changed `ask` output and interview
      flow is about to change (H6): verify every command transcript in the
      README quickstart against actual current output and re-capture where
      stale. Do **not** rewrite dated files in `docs/demos/` — they are
      historical records. Add a CI badge slot (activated in H5.5).
- [ ] H5.3 **First push.** `git branch -m master main`; `git remote add
      origin https://github.com/MiltonKlun/Cartographer.git`; verify the tree
      is clean and no real secrets exist anywhere (`testdata` redaction
      fixtures contain deliberately fake AWS-style keys — confirm they are
      obviously fake; if GitHub secret-scanning flags them, note it in the
      demo as expected). Then `git push -u origin main`.
      *Pushing publishes the repo — the user has named this repo as the
      destination, but confirm with them immediately before the first push if
      anything about the state differs from this plan.*
- [ ] H5.4 **Make CI actually green.** Watch the first Actions run (all three
      jobs: `check`, `guardrails-gate`, `dogfood`). Expect Ubuntu breakage
      candidates: glob quoting in package.json scripts, path separators,
      `spawnSync` of `bin/cart.mjs`, the `node:sqlite` experimental warning
      on stderr. Fix each with the minimal change + a note in the demo;
      iterate until green. **This phase's DoD includes a green run on
      GitHub**, not just a local `npm run check`.
- [ ] H5.5 **Badge + demo.** Turn on the README CI badge with the real
      workflow URL; the demo links the green run.

**Demo:** `docs/demos/h5-publication.md` — link to the green Actions run, the
list of Ubuntu fixes (or "none needed"), the LICENSE decision line.

## Phase H6 — Interview inline confirm (review C1 — the biggest UX gap)

Goal: confirming 50 bootstrap proposals is one command and one keystroke per
proposal, as SPEC §7.5 intends — not one hand-typed CLI invocation each, not
hand-authored JSON.

- [ ] H6.1 **Testable driver, IO injected.** New `src/interview-live.ts`:
      `runInterviewLoop(ledger, io, actor, clock)` where
      `io = { ask: (prompt: string) => Promise<string>, say: (line: string) =>
      void }`. Loop over `pendingProposals(ledger)`; for each, `say` a
      proposal card (id, statement, area, criticality, created_by) and `ask`
      `[y]es confirm / [e]dit / [m]erge into / [d]iscard / [s]kip / [q]uit`:
      - `y` ⇒ confirm as `actor`;
      - `e` ⇒ ask for a replacement statement (empty input = keep), confirm;
      - `m` ⇒ ask for the survivor `BHV-…` id; validate it exists, is active
        and confirmed; invalid ⇒ re-prompt once, then skip this proposal;
      - `d` ⇒ ask for an optional reason, discard;
      - `s` or empty ⇒ skip; `q` ⇒ stop.
      **Each decision is applied immediately** via the existing
      `applyInterview` with a single-item list (quitting mid-way must lose
      nothing already answered). Return a summary
      `{ confirmed, merged, discarded, skipped, remaining }`.
- [ ] H6.2 **CLI wiring.** `cart interview --live --as <actor>` using
      `node:readline/promises` over stdin/stdout (works on piped stdin too —
      no TTY gate). Existing single-question and batch modes untouched.
- [ ] H6.3 **Tests.**
      - [ ] Integration: scripted `io` (a queue of canned answers) proving
            every branch: y/e/m (valid + invalid survivor)/d/s/q, and the
            immediate-apply semantics (answer one, quit, assert it
            persisted).
      - [ ] E2e: spawn `bin/cart.mjs interview --live --as ana` with
            `"y\nq\n"` piped to stdin against a temp DB seeded with 2
            proposals; assert exit 0, 1 confirmed, 1 still pending.
- [ ] H6.4 **Docs.** README quickstart's confirm step becomes
      `cart interview --live`; note the SPEC §7.5 parity in the demo.

**Demo:** `docs/demos/h6-interview-live.md` — a real transcript confirming a
got-fixture bootstrap batch, with the summary line.

## Phase H7 — Deep-link correctness: merge relink + rim guard v2 (review A6 + A4)

Goal: a merged behavior inherits its duplicate's evidence history, and the
prose guard rejects verdict-upgrading prose, not just unknown ids.

- [ ] H7.1 **Record the merge on the retired side.** Add optional
      `merged_into?: string` to the `Behavior` type (`src/types.ts`) and the
      behavior JSON schema (optional — no migration needed; records are JSON
      blobs). In `applyInterview`'s merge case (`src/interview.ts` ~line 75,
      where `status: 'retired'` and the notes suffix are set), also set
      `merged_into: item.decision.into`.
- [ ] H7.2 **Alias-aware verdicts.** Where verdict computation filters
      evidence by `behavior_ids.includes(b.id)` (in `src/decay.ts`
      `computeVerdict`, called from `QueryApi.verdict`): accept evidence
      citing any behavior whose `merged_into` chain resolves to `b.id`.
      Implementation shape: `QueryApi.verdict` precomputes the alias id set
      (scan behaviors for `merged_into`, follow transitively, cycle-guarded,
      ≤10 hops) and passes it to `computeVerdict` as an optional
      `aliasIds?: string[]` — keep `computeVerdict` pure.
- [ ] H7.3 **Tests.** Merge a duplicate carrying 2 supporting evidence
      records into an evidence-less survivor ⇒ survivor's verdict is
      `VERIFIED` and `newest_evidence_id` is the duplicate's newest; a 2-hop
      chain (A merged into B, B into C) resolves to C; a hand-crafted cycle
      does not hang (assert it terminates with a sane verdict).
- [ ] H7.4 **Rim guard v2** (`src/rim.ts`). Verified blind spot:
      `proseCitesOnlyKnownIds` checks ids only, so "BHV-0001 is fully
      verified" over a STALE row passes. Add
      `proseContradictsVerdicts(prose, rows): boolean`: for each state-claim
      pattern that matches the prose —
      `verified: /\b(verified|passing|passes|green)\b/i`,
      `violated: /\b(violated|failing|fails|broken)\b/i`,
      `stale: /\bstale\b/i`, plus `/\bsafe to ship\b/i` ⇒ `verified` —
      require ≥1 row whose `verdict.state` carries that state; otherwise the
      prose is contradictory. Wire into `renderAskWithProse`
      (`src/ask.ts:121`) alongside the id guard: contradiction ⇒ discard
      prose, return rows-only.
      - [ ] Tests: STALE-only rows + "fully verified" prose ⇒ discarded;
            VERIFIED row + "verified" prose ⇒ kept; prose with no state words
            ⇒ kept; **pin the known limitation**: "is not verified" over
            STALE rows is conservatively discarded too (word-level, no
            negation parsing) — that is the safe direction since rows are
            always shown; say so in a comment.

**Demo:** `docs/demos/h7-deep-links.md` — merged-behavior verdict before/after;
the verdict-upgrade probe from the review now discarded.

## Phase H8 — Dogfood linkage: JUnit classname ↔ test_id (review C4b)

Goal: Cartographer's own CI dogfood evidence actually links to behaviors
(V2 finding: node:test JUnit `classname` never matches bootstrap `test_id` ⇒
~98% of self-evidence unlinked).

- [ ] H8.1 **Capture the real shapes.** Generate Cartographer's own JUnit
      (`node --test --test-reporter junit`), trim a representative sample
      into `testdata/self/junit-sample.xml`. In the demo, write down 5
      observed `classname`/`name` pairs next to the 5 `test_id`s bootstrap
      derives for the same files — the mapping rule must be **written before
      it is coded**.
- [ ] H8.2 **Implement the mapping** in the JUnit ingest adapter: derive
      test-id candidates from `classname` + `name` in bootstrap's format;
      keep the current exact-match path as first preference; derived matches
      get `link_confidence: 'medium'` (it is an inference — say so in the
      evidence).
- [ ] H8.3 **Regression.** Fixture from H8.1 against a ledger bootstrapped
      from the same source tree: assert linked-evidence count > 0 **and**
      linkage rate ≥ 50% where a matching behavior exists (guard the
      precondition — no vacuous pass).
- [ ] H8.4 **Prove it in CI.** Push; record the dogfood job's new linkage
      rate vs the old ~2% in the demo.

**Demo:** `docs/demos/h8-dogfood-linkage.md` — the mapping table, the rate
before/after, link to the CI run.

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
