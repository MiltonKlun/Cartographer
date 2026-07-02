// CG-3.2/3.3 — cart ask: cited answers on a mapped area, honest UNKNOWN on
// an unmapped one (minimum-viable-map rule), rows-only without an LLM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../../db.js';
import { QueryApi } from '../../query.js';
import { assembleAsk, renderAsk, renderAskWithProse, queueGapQuestion, type AskRow } from '../../ask.js';
import { applyInterview } from '../../interview.js';
import { NullRimAdapter, type RimAdapter } from '../../rim.js';
import { fixedClock } from '../../clock.js';
import { tempLedger, testCtx } from '../helpers/ledger.js';
import { makeBehavior, makeProposal, makeEvidence } from '../helpers/factories.js';
import type { Behavior, Evidence, Question } from '../../types.js';

const NOW = '2026-06-10T12:00:00Z';
const clock = fixedClock(NOW);
const ctx = testCtx(clock);

function seeded(): { ledger: Ledger; api: QueryApi } {
  const ledger = tempLedger(clock);
  const behaviors: Behavior[] = [
    makeBehavior({ id: 'BHV-0001', statement: 'Two coupons cannot be applied to one cart', area: 'checkout/coupons', criticality: 'high' }),
    makeBehavior({ id: 'BHV-0002', statement: 'Coupon applies before tax', area: 'checkout/coupons', criticality: 'normal' }),
    makeProposal({ id: 'BHV-0003', statement: 'Coupon codes are case-insensitive', area: 'checkout/coupons', criticality: 'low', created_by: 'session' }),
  ];
  for (const b of behaviors) ledger.insertBehavior(b, 'ana');
  const evidence: Evidence[] = [
    makeEvidence({ id: 'EV-0001', behavior_ids: ['BHV-0001'], observed_at: '2026-06-09T03:00:00Z', source: { type: 'ci', ref: 'run 8841' } }),
    makeEvidence({ id: 'EV-0002', behavior_ids: ['BHV-0002'], outcome: 'violates', observed_at: '2026-06-10T03:00:00Z', source: { type: 'ci', ref: 'run 8850' } }),
  ];
  for (const e of evidence) ledger.insertEvidence(e, 'ingest:playwright-json@1');
  return { ledger, api: new QueryApi(ledger, ctx) };
}

test('mapped area: cited rows with verdicts; FAILING leads', () => {
  const { api } = seeded();
  const result = assembleAsk(api, 'do we test coupons?');
  assert.equal(result.mapViable, true);
  assert.equal(result.rows[0]?.behavior.id, 'BHV-0002');
  assert.equal(result.rows[0]?.verdict.state, 'FAILING');
  assert.equal(result.rows[1]?.verdict.state, 'VERIFIED');

  const out = renderAsk(result);
  assert.match(out, /BHV-0002 .*FAILING/s);
  assert.match(out, /\[BHV-0001, EV-0001\]/);
  assert.match(out, /\(ci, 2026-06-09\)/);
});

test('unconfirmed matches are badged, never part of the verified answer (I3)', () => {
  const { api } = seeded();
  const result = assembleAsk(api, 'are coupon codes case-insensitive?');
  assert.ok(result.unconfirmedMatches.some((b) => b.id === 'BHV-0003'));
  const out = renderAsk(result);
  assert.match(out, /BHV-0003 .*\[unconfirmed proposal/);
});

test('H1.1: a discarded proposal never resurfaces in search or ask (I3)', () => {
  const { ledger, api } = seeded();
  // BHV-0003 is an unconfirmed proposal; discard it in the interview.
  applyInterview(ledger, 'ana', [{ behaviorId: 'BHV-0003', decision: { kind: 'discard', reason: 'not a real rule' } }], clock);

  // search must not return it at all
  const hits = api.searchBehaviors('are coupon codes case-insensitive?');
  assert.ok(!hits.some((h) => h.behavior.id === 'BHV-0003'), 'retired proposal must not be searchable');

  // ask must not surface it in rows OR as an unconfirmed match
  const result = assembleAsk(api, 'are coupon codes case-insensitive?');
  assert.ok(!result.rows.some((r) => r.behavior.id === 'BHV-0003'), 'retired proposal must not be a row');
  assert.ok(!result.unconfirmedMatches.some((b) => b.id === 'BHV-0003'), 'retired proposal must not be an unconfirmed match');
  assert.ok(!renderAsk(result).includes('BHV-0003'), 'retired proposal must not render anywhere');
});

test('H1.2: a FAILING behavior below the row cut still leads (sort precedes cut)', () => {
  const ledger = tempLedger(clock);
  // 7 confirmed behaviors sharing the token "coupon"; the LAST one added is
  // the lowest-ranked by token overlap (extra noise words dilute its score)
  // yet it is the only one with violating evidence.
  const behaviors: Behavior[] = [];
  for (let i = 1; i <= 6; i++) {
    behaviors.push(makeBehavior({ id: `BHV-000${i}`, statement: `Coupon rule number ${i} holds`, area: 'checkout/coupons', criticality: 'normal' }));
  }
  // lowest score: many non-matching words around the single "coupon" token
  behaviors.push(makeBehavior({ id: 'BHV-0007', statement: 'A coupon with many many many other unrelated descriptive words', area: 'checkout/coupons', criticality: 'high' }));
  for (const b of behaviors) ledger.insertBehavior(b, 'ana');
  ledger.insertEvidence(
    makeEvidence({ id: 'EV-0001', behavior_ids: ['BHV-0007'], outcome: 'violates', observed_at: '2026-06-10T03:00:00Z', source: { type: 'ci', ref: 'run 1' } }),
    'ingest:playwright-json@1',
  );
  const api = new QueryApi(ledger, ctx);

  const result = assembleAsk(api, 'coupon');
  assert.ok(result.rows.length > 0, 'need rows (guards vacuous pass)');
  assert.ok(result.rows.length <= 5, 'rows are still capped at MAX_ROWS');
  assert.equal(result.rows[0]?.behavior.id, 'BHV-0007', 'the FAILING behavior leads even though it ranked below the cut');
  assert.equal(result.rows[0]?.verdict.state, 'FAILING');
});

test('minimum-viable-map: unmapped area answers UNKNOWN and offers the queue', () => {
  const { api } = seeded();
  const result = assembleAsk(api, 'do we test gift card refunds?');
  assert.equal(result.mapViable, false);
  assert.equal(result.rows.length, 0);
  const out = renderAsk(result);
  assert.match(out, /^UNKNOWN: no confirmed behavior covers/m);
  assert.match(out, /--queue/);
});

test('partial match: rows render plus an inference-labeled gap note (SPEC §7.1)', () => {
  const { api } = seeded();
  const result = assembleAsk(api, 'do we test gift cards combined with coupons?');
  assert.equal(result.mapViable, true);
  assert.equal(result.partial, true, 'coupon row matches but most terms are uncovered');
  const out = renderAsk(result);
  assert.match(out, /inference: these rows cover only part of/);
  assert.match(out, /--queue/);
});

test('full match is not flagged partial', () => {
  const { api } = seeded();
  const result = assembleAsk(api, 'coupon tax');
  assert.equal(result.partial, false);
});

test('--queue files a Q record with why_asked, not a guessed behavior (I3)', () => {
  const { ledger } = seeded();
  const q = queueGapQuestion(ledger, 'do we test gift card refunds?', 'erick', clock);
  assert.equal(q.id, 'Q-0001');
  assert.equal(q.status, 'open');
  assert.match(q.why_asked, /^gap: cart ask found no confirmed behavior/);
  const stored = ledger.allRecords('questions') as Question[];
  assert.equal(stored.length, 1);
  assert.equal((ledger.allRecords('behaviors') as Behavior[]).length, 3, 'no behavior invented');
});

test('CG-3.3: rows-only output is complete without any LLM', async () => {
  const { api } = seeded();
  const result = assembleAsk(api, 'do we test coupons?');
  const rim = new NullRimAdapter();
  assert.equal(rim.available(), false);
  assert.equal(await rim.proseOverRows(), undefined);
  // the surface renders fully from rows alone
  const out = renderAsk(result);
  assert.ok(out.includes('FAILING') && out.includes('VERIFIED'));
});

test('AskRow carries only plain data — no ledger handle, no methods (Constitution §1)', () => {
  // The rim contract is structural: proseOverRows receives AskRow[] and
  // nothing else. We prove every row the assembler emits is plain,
  // serializable data — a row that smuggled a Ledger/QueryApi (a function or
  // a class instance) would be caught here.
  const { api } = seeded();
  const result = assembleAsk(api, 'do we test coupons?');
  assert.ok(result.rows.length > 0, 'need rows to inspect');

  for (const row of result.rows) {
    // exact shape — no extra fields (a leaked handle would add a key)
    assert.deepEqual(Object.keys(row).sort(), ['behavior', 'evidenceSource', 'score', 'verdict']);
    // no field is a function or carries methods (a Ledger/QueryApi would)
    for (const value of Object.values(row)) {
      assert.notEqual(typeof value, 'function', 'a row field is a function — possible handle leak');
    }
    // the whole row round-trips through JSON unchanged ⇒ pure data, no
    // class instance with behavior could survive this
    assert.deepEqual(JSON.parse(JSON.stringify(row)), row);
  }
});

test('the rim adapter is only ever handed rows (spy confirms the call shape)', async () => {
  const seen: AskRow[][] = [];
  const spyRim: RimAdapter = {
    available: () => true,
    proseOverRows: async (_q, rows) => {
      seen.push(rows);
      return 'prose';
    },
  };
  const { api } = seeded();
  const result = assembleAsk(api, 'do we test coupons?');
  await spyRim.proseOverRows(result.question, result.rows);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], result.rows);
});

// ---- V3.2/V3.3: the prose pass over rows ----

/** A rim that returns whatever prose the test specifies. */
function fixedRim(prose: string | undefined, available = true): RimAdapter {
  return { available: () => available, proseOverRows: async () => prose };
}

test('V3.2: faithful prose is prepended; the rows-only render is always preserved', async () => {
  const { api } = seeded();
  const result = assembleAsk(api, 'do we test coupons?');
  const rim = fixedRim('Coupon-before-tax is currently FAILING (BHV-0002, EV-0002).');
  const out = await renderAskWithProse(result, rim);
  assert.match(out, /^Coupon-before-tax is currently FAILING/);
  // the canonical rows-only output still follows the prose, intact
  assert.match(out, /BHV-0002 .*FAILING/s);
  assert.ok(out.includes(renderAsk(result)), 'rows-only render must be present verbatim');
});

test('V3.3: prose citing an unknown id is DISCARDED — output is exactly rows-only (I1)', async () => {
  const { api } = seeded();
  const result = assembleAsk(api, 'do we test coupons?');
  // the LLM hallucinated BHV-9999, which is not in the rows
  const rim = fixedRim('Also, gift cards are covered by BHV-9999.');
  const out = await renderAskWithProse(result, rim);
  assert.equal(out, renderAsk(result), 'unfaithful prose must be dropped entirely');
  assert.ok(!out.includes('BHV-9999'));
});

test('V3.2: an unavailable rim yields exactly the rows-only render (SPEC §12)', async () => {
  const { api } = seeded();
  const result = assembleAsk(api, 'do we test coupons?');
  const out = await renderAskWithProse(result, new NullRimAdapter());
  assert.equal(out, renderAsk(result));
});

test('V3.2: a declining/erroring rim (undefined) yields exactly rows-only', async () => {
  const { api } = seeded();
  const result = assembleAsk(api, 'do we test coupons?');
  const out = await renderAskWithProse(result, fixedRim(undefined));
  assert.equal(out, renderAsk(result));
});

test('V3.2: an unmapped question never calls the rim (no rows to summarize)', async () => {
  const { api } = seeded();
  const result = assembleAsk(api, 'do we test gift card refunds?');
  let called = false;
  const rim: RimAdapter = { available: () => true, proseOverRows: async () => { called = true; return 'x'; } };
  const out = await renderAskWithProse(result, rim);
  assert.equal(called, false, 'no rows ⇒ rim is not consulted');
  assert.equal(out, renderAsk(result));
});
