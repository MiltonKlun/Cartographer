# Phase H9 demo — debt pins + branded Verdict — 2026-07-07

> HARDENING-PLAN Phase H9 DoD: `npm run check` green (308 tests) + this demo:
> the two doc pins and the branded-type outcome (landed or dropped-with-reason).

## What H9 did

The last hardening phase: write down the accepted limitations where an adopter
will look, and attempt the one cheap compile-time hardening from the review.

## H9.1 — single-writer note (docs/operations.md)

`Ledger.nextId` reads `MAX(id)` and inserts the record in separate steps, so
two `cart` processes writing the same `ledger.db` concurrently can pick the
same id and collide. Added a **"One writer per ledger"** section to
`docs/operations.md`: the collision is a *loud* PK-constraint failure (not
silent corruption, append-log untouched), the guidance is one writer per
ledger (give CI its own DB — the workflow already uses `runner.temp`), and this
is a deliberate SPEC §2 scope choice, not a config flag. No code change.

## H9.3 — scaling posture (docs/decisions/0003-defer-query-scaling.md)

`Ledger.allRecords` loads and `JSON.parse`s a whole table; ~31 call sites do
this per command. Fine now (a command is dominated by process startup);
evidence is the table that grows unbounded (~10^4–10^5 rows for a team-year of
daily CI). Decision **0003** records: keep full-table reads until real data
demands otherwise, with explicit triggers to revisit (`ask`/`brief` > ~500 ms,
evidence > ~50k rows, or backup pain) and the known fix (SQL-side filtering
behind the existing `Ledger` API — not an ORM, not a cache, not a second
store). Consistent with SPEC §15 and decision 0002.

## H9.2 — branded Verdict: LANDED

The review suggested branding `Verdict` so "the decay engine is the only
constructor" (I2) becomes a *type-checked* property, not just a comment. I
attempted it with the ≤1h abandon rule in mind — it landed cleanly.

```ts
// types.ts
declare const verdictBrand: unique symbol;
export interface VerdictData { state; freshness; computed_at; newest_evidence_id }
export type Verdict = VerdictData & { readonly [verdictBrand]: typeof verdictBrand };

// decay.ts — the single blessed mint (a cast in exactly one place)
function mintVerdict(v: VerdictData): Verdict { return v as Verdict; }
```

The brand is a **required** phantom key of an unforgeable symbol type, so no
object literal satisfies `Verdict` — construction *must* go through a visible
cast. `computeVerdict`'s four returns now route through `mintVerdict`.

**Blast radius (why it was cheap):** the typecheck flagged exactly **two
files** that constructed a `Verdict` literal — both tests, zero production code
outside decay.ts. That's the branding paying off immediately: it proved the
"only constructor" claim was already true. The tests get their brand from a
single test-side mint, `makeVerdict` in `factories.ts` (the parallel to
`mintVerdict`).

**Runtime cost: none.** The brand is erased by the compiler; a `Verdict` stays
a plain four-field record. Pinned by `H9.2` in `decay.test.ts`:

```ts
const v = computeVerdict(behavior(), [evidence()], ctx());
assert.deepEqual(JSON.parse(JSON.stringify(v)), v);            // round-trips
assert.equal(Object.getOwnPropertySymbols(v).length, 0);      // no runtime key
```

So JSONL export (I11) and the rim projection are unaffected — the AskRow
JSON-round-trip test still passes untouched.

## The changes

- `docs/operations.md` — "One writer per ledger" section (H9.1).
- `docs/decisions/0003-defer-query-scaling.md` — scaling deferral (H9.3).
- `src/types.ts` — `VerdictData` + branded `Verdict` (H9.2).
- `src/decay.ts` — `mintVerdict`, the single mint; four returns routed through it.
- `src/test/helpers/factories.ts` — `makeVerdict` (test-side mint).
- Tests: `decay.test.ts` +H9.2 (round-trip / no runtime symbol); `renderer` +
  `rim` tests updated to the branded type.

## DoD

`npm run check` green: typecheck + lint + **308 tests** (139 unit / 155
integration / 14 e2e) + schemas. The branded type compiled with no
`exactOptionalPropertyTypes` fight and touched only two files beyond the mint —
well inside the abandon threshold. No test weakened.
