# CONSTITUTION.md — Cartographer

> The invariants of the system. Everything in `SPEC.md` (the engineering) is
> negotiable; this document is not. Builders read this first.
> Every invariant names its **enforcement point** — an invariant that lives
> only in prose is a wish, not a rule.

---

## 1. Identity and stance

**Cartographer is a map, not a pipeline.** Its product is a continuously
maintained model of what the product under test does, what is verified, and
what is risky *right now* — the **behavior ledger**. Tests, tickets, and
reports are byproducts of the map. A QA engineer's day is interrupt-shaped
("why is CI red?", "is this PR safe?", "do we test X?", "can we ship?"), so
Cartographer's surfaces answer interrupts; it does not impose a sequence.

**Deterministic core, probabilistic rim.** The ledger, ingestion, decay,
verdicts, and every state mutation are plain code with tests. The LLM lives at
the rim only: it maps natural language to ledger queries, drafts prose from
structured rows, and writes *proposals*. **The LLM never mutates the ledger
directly.** Proposals enter through the same validated, tiered gateway as
everything else.

---

## 2. Vocabulary (binding)

| Term | Meaning |
|---|---|
| **Behavior** (`BHV-xxxx`) | A user-visible promise the product makes, stated as one falsifiable sentence ("A viewer-role user cannot bulk-delete records"). Not a file, not a test name. |
| **Evidence** (`EV-xxxx`) | An immutable, timestamped record of an observation that supports or violates a behavior: a test run, trace, screenshot, manual observation, crawl result, or incident. |
| **Verdict** | The computed state of a behavior: `VERIFIED`, `STALE`, `ASSERTED`, `UNKNOWN`, `FAILING` — always paired with a freshness score and a date. |
| **Freshness** | Decayed confidence in a verdict, computed from evidence age, code churn near the behavior, and incident history. |
| **Claim** | Any statement Cartographer makes about coverage, risk, or product behavior. |
| **Surface** | A place Cartographer meets the engineer: `ask`, `pr`, `triage`, `brief`, `interview`, `session`, `status`. |
| **Question** (`Q-xxxx`) | An assistant-initiated request for human meaning, queued when the map has a gap. |
| **Session** (`SES-xxxx`) | A ride-along recording of human exploratory testing. |
| **Receipt** (`ACT-xxxx`) | The immutable record of any autonomous action: what, why, evidence basis, and how to revert. |

---

## 3. The Invariants

**I1 — Evidence or silence.** Every claim cites evidence IDs or is explicitly
labeled `inference` or `UNKNOWN`. "Covered" without a pointer to a concrete
observation is forbidden output.
*Enforced by:* the claims renderer (core module, built in Phase 0) refuses to
render claim objects lacking citations or an explicit inference flag. Surfaces
cannot bypass it.

**I2 — Decay is load-bearing.** No verdict may be displayed without its
freshness score and the date of its newest evidence. "Verified in March" must
stop counting as verified on the schedule the decay model defines.
*Enforced by:* verdict objects are only constructible through the decay
engine; the renderer rejects verdicts missing `freshness`/`computed_at`.

**I3 — Meaning is human.** Cartographer never invents intended behavior. A
gap becomes a queued `Q-xxxx` interview question, never a guessed behavior.
LLM-drafted behavior statements are proposals until a human confirms them.
*Enforced by:* behavior records carry `confirmed_by`; unconfirmed behaviors
render with an `[unconfirmed]` badge and are excluded from `VERIFIED` claims.

**I4 — Consequence-tiered autonomy.** Every action class is assigned a tier —
`ACT` (autonomous, with receipt), `PROPOSE` (draft for a human), `NEVER` —
by *consequence*, not by pipeline stage. Teams may move classes toward
caution; **the `NEVER` tier can never be loosened by configuration.** Full
matrix in `SPEC.md §9`.
*Enforced by:* a single `autonomy.ts` gateway through which all side effects
pass; `NEVER` classes have no code path.

**I5 — The NEVER list.** Cartographer never: deletes a test; weakens or
rewrites an assertion; changes an expected value; adds `.skip`/`.fixme` to
test source; marks a behavior `VERIFIED` without supporting evidence; merges
or commits to protected branches; fabricates evidence.
*Enforced by:* the guardrails module (`SPEC.md §10`), applied to every patch
Cartographer produces, in the spirit of one-source-of-truth guardrail code.

**I6 — A stale map is worse than no map.** Ingestion failures degrade
*loudly*: every surface shows a banner ("CI ingestion broken since
<date> — verdicts unreliable") rather than silently serving old data.
*Enforced by:* `cart status` health checks gate every surface render; a
red health state injects the banner at the renderer level.

**I7 — The map serves the engineer, not management.** No per-person metrics,
no leaderboards, no individual productivity aggregation. Ledger analytics
aggregate at the product/area level only. Names appear solely for
attribution of decisions (who confirmed a behavior, who answered a question).
*Enforced by:* the schema has no per-person rollup tables; the query API
refuses `group by person` style aggregations; this is also a `NEVER` class.

**I8 — Capture, don't interrupt.** During a ride-along session, Cartographer
observes silently and summarizes only at `session stop`. Exploratory
instinct is the scarce resource; the system does the bookkeeping.
*Enforced by:* session mode disables all surfaces except passive capture.

**I9 — Decline when raw prompting wins.** For one-off scripts, throwaway
spikes, and work with no regression future, Cartographer recommends direct
prompting and says exactly what is forfeited (an evidence trail). A tool
that knows when it isn't worth using is a tool people believe when it says
it is.
*Enforced by:* SKILL.md decline patterns; checked in the evaluation harness.

**I10 — Privacy at ingestion.** Evidence may contain user data and secrets.
Redaction runs *at ingestion*, before anything reaches the vault; records
that fail redaction are quarantined, not stored. Secrets never enter the
ledger.
*Enforced by:* the ingestion pipeline is the only write path to the vault,
and redaction is a non-optional stage in it.

**I11 — Inspectable and attributable.** The ledger exports to human-readable
JSONL on demand; every mutation records who or which ingestor made it and
when. No hidden state.
*Enforced by:* append-only `mutations` log table; `cart export` is a
first-class command with a determinism test.

**I12 — Heals must self-evidence.** An autonomous selector heal is not
complete until a green re-run produces new supporting evidence linked in its
receipt. No green re-run ⇒ the heal auto-reverts and demotes to `PROPOSE`.
*Enforced by:* the heal action class implementation; covered by unit tests.

---

## 4. Anti-goals (what Cartographer is not)

- **Not a test generator firehose.** Volume of generated tests is an
  explicit non-metric. The map's honesty is the metric.
- **Not an autonomous QA replacement.** Judgment calls — what a behavior
  *should* be, whether a risk is acceptable, what ships — are human.
- **Not a dashboard product.** Surfaces are terse, terminal/PR/chat-native,
  and engineer-facing. No web dashboard in v1 (see `SPEC.md §14`).
- **Not a metrics regime.** See I7.
- **Not a pipeline.** There is no required order of operations and no gate
  ceremony; trust comes from evidence and receipts instead.

---

## 5. Amendment rule

Changing this document requires: a written decision note in
`docs/decisions/` (context, alternatives, consequences), a version bump of
this file, and an update to any enforcement code in the same PR. Invariants
I1–I12 may be *tightened* freely. Loosening I5 (the NEVER list) or I7
(anti-surveillance) is out of bounds for any agent executing the build plan;
treat a request to do so as a stop-and-report event.

---

*Companion documents: `SPEC.md` (how it works) and
`skills/cartographer/SKILL.md` (how the assistant operates it).*
