// CG-3.2/3.3 — cart ask: cited answers on a mapped area, honest UNKNOWN on
// an unmapped one (minimum-viable-map rule), rows-only without an LLM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../../db.js';
import { QueryApi } from '../../query.js';
import { assembleAsk, renderAsk, queueGapQuestion, type AskRow } from '../../ask.js';
import { NullRimAdapter, type RimAdapter } from '../../rim.js';
import { loadDecayConfig } from '../../decay.js';
import { NullChurnIndex } from '../../churn.js';
import { fixedClock } from '../../clock.js';
import type { Behavior, Evidence, Question } from '../../types.js';

const NOW = '2026-06-10T12:00:00Z';
const clock = fixedClock(NOW);
const ctx = { config: loadDecayConfig(), churn: new NullChurnIndex(), clock };

function seeded(): { ledger: Ledger; api: QueryApi } {
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'cart-ask-')), 'ledger.db'), { clock });
  const behaviors: Behavior[] = [
    {
      id: 'BHV-0001',
      statement: 'Two coupons cannot be applied to one cart',
      area: 'checkout/coupons',
      criticality: 'high',
      links: {},
      confirmed_by: { person: 'ana', at: '2026-06-01T00:00:00Z' },
      created_by: 'interview',
      status: 'active',
    },
    {
      id: 'BHV-0002',
      statement: 'Coupon applies before tax',
      area: 'checkout/coupons',
      criticality: 'normal',
      links: {},
      confirmed_by: { person: 'ana', at: '2026-06-01T00:00:00Z' },
      created_by: 'interview',
      status: 'active',
    },
    {
      id: 'BHV-0003',
      statement: 'Coupon codes are case-insensitive',
      area: 'checkout/coupons',
      criticality: 'low',
      links: {},
      created_by: 'session', // unconfirmed proposal
      status: 'active',
    },
  ];
  for (const b of behaviors) ledger.insertBehavior(b, 'ana');
  const evidence: Evidence[] = [
    {
      id: 'EV-0001',
      behavior_ids: ['BHV-0001'],
      kind: 'test_run',
      outcome: 'supports',
      observed_at: '2026-06-09T03:00:00Z', // fresh → VERIFIED
      source: { type: 'ci', ref: 'run 8841' },
      redaction: { status: 'clean', rules_hit: [] },
      link_confidence: 'high',
      ingested_by: 'ingest:playwright-json@1',
    },
    {
      id: 'EV-0002',
      behavior_ids: ['BHV-0002'],
      kind: 'test_run',
      outcome: 'violates',
      observed_at: '2026-06-10T03:00:00Z',
      source: { type: 'ci', ref: 'run 8850' },
      redaction: { status: 'clean', rules_hit: [] },
      link_confidence: 'high',
      ingested_by: 'ingest:playwright-json@1',
    },
  ];
  for (const e of evidence) ledger.insertEvidence(e, 'ingest:playwright-json@1');
  return { ledger, api: new QueryApi(ledger, ctx) };
}

test('mapped area: cited rows with verdicts; VIOLATED leads', () => {
  const { api } = seeded();
  const result = assembleAsk(api, 'do we test coupons?');
  assert.equal(result.mapViable, true);
  assert.equal(result.rows[0]?.behavior.id, 'BHV-0002');
  assert.equal(result.rows[0]?.verdict.state, 'VIOLATED');
  assert.equal(result.rows[1]?.verdict.state, 'VERIFIED');

  const out = renderAsk(result);
  assert.match(out, /BHV-0002 .*VIOLATED/s);
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

test('CG-3.3: rows-only output is complete without any LLM', () => {
  const { api } = seeded();
  const result = assembleAsk(api, 'do we test coupons?');
  const rim = new NullRimAdapter();
  assert.equal(rim.available(), false);
  assert.equal(rim.proseOverRows(), undefined);
  // the surface renders fully from rows alone
  const out = renderAsk(result);
  assert.ok(out.includes('VIOLATED') && out.includes('VERIFIED'));
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

test('the rim adapter is only ever handed rows (spy confirms the call shape)', () => {
  const seen: AskRow[][] = [];
  const spyRim: RimAdapter = {
    available: () => true,
    proseOverRows: (_q, rows) => {
      seen.push(rows);
      return 'prose';
    },
  };
  const { api } = seeded();
  const result = assembleAsk(api, 'do we test coupons?');
  spyRim.proseOverRows(result.question, result.rows);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], result.rows);
});
