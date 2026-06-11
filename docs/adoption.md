# Should you adopt Cartographer?

> The same honesty the tool enforces in its claims, applied to itself. A tool
> that tells you when *not* to use it is one you can believe when it says you
> should (I9, at the project scale).

## Don't adopt Cartographer if…

- **You have no CI, or CI that doesn't run automated tests.** The map is fed
  by evidence (test runs, traces, incidents). With no automated runs there is
  nothing to decay against — every behavior sits at `ASSERTED` forever and the
  map never earns trust. Wire CI first; adopt after.

- **The work has no regression future.** One-off scripts, throwaway spikes,
  prototypes you'll delete after the demo — the ledger's whole value is that
  findings *compound*. For disposable work, the bookkeeping cost isn't repaid.
  (`cart decline "<request>"` will tell you this per-task.)

- **You want a productivity dashboard.** Cartographer refuses per-person
  metrics by construction (I7 — no code path, not a setting). If the goal is
  to measure individual engineers, this is the wrong tool and will stay the
  wrong tool.

- **You expect it to decide what ships, or what a behavior *should* be.**
  Judgment is human (anti-goals; I3). Cartographer surfaces evidence and risk;
  it never approves a release or invents intended behavior. If you want an
  autonomous gate, look elsewhere.

- **You can't give it ~an hour for cold start.** The map is only useful once
  ~50 behaviors are confirmed (bootstrap import + one interview sitting,
  Phase 4). A half-bootstrapped map answers `UNKNOWN` a lot — honestly, but
  unhelpfully. Budget the sitting or don't start.

- **Your tests have no stable identity.** Linking (Phase 1) keys on `test_id`
  and `@bhv` annotations. If test names churn every run or there's no stable
  file/title, evidence won't link and the map stays thin. Adopt the
  `@bhv BHV-xxxx` convention first.

## Adopt Cartographer if…

- You have a real test suite running in CI, and you keep asking the same
  interrupt-shaped questions: *"do we test X?", "is this PR safe?", "why is CI
  red?", "can we ship?"*
- Your team loses exploratory-testing findings to evaporation (they live in
  someone's memory, not a record).
- You've been bitten by "verified in March" that wasn't verified anymore —
  decay is the headline feature.
- You want an evidence trail and reversible receipts for every automated
  action, not a black box.

## The honest middle

You can adopt *partially*. The system is genuinely usable from Phase 3
(`cart ask`) onward, and each surface earns trust independently:

- Start with `ask` + `brief` for honest coverage answers.
- Add `pr` once your churn index and linking are validated
  (the retro-validation gate, Phase 5).
- Add `triage` + `quarantine` when flaky tests are a real cost.
- Add `session` / ET-Kit ingestion when exploratory findings matter.
- Turn on `heal` last — it's the only autonomous code change, and it's
  locator-only with self-evidencing receipts (I12).

If after reading this you're unsure, run the cold start on one repo for a week
and look at the morning brief. If it's telling you things you didn't know and
citing evidence for them, keep going. If it's mostly `UNKNOWN`, you either
need more confirmed behaviors or you're not the right adopter yet — and the
map will have told you so without pretending otherwise.
