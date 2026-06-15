// CG-10.1 — the eval harness: golden ask, citation audit, triage precision,
// decline rule. The harness is itself tested against a seeded ledger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Ledger } from '../../db.js';
import { QueryApi } from '../../query.js';
import { runEval, type GoldenSet } from '../../eval.js';
import { tempLedger, testCtx } from '../helpers/ledger.js';
import { makeBehavior, makeEvidence } from '../helpers/factories.js';
import { fixtures } from '../helpers/fixtures.js';

const ctx = testCtx();

function seeded(): { ledger: Ledger; api: QueryApi } {
  const ledger = tempLedger();
  ledger.insertBehavior(
    makeBehavior({ statement: 'Coupon applies before tax', area: 'checkout/coupons' }),
    'ana',
  );
  ledger.insertEvidence(makeEvidence(), 'ingest:playwright-json@1');
  return { ledger, api: new QueryApi(ledger, ctx) };
}

const golden: GoldenSet = JSON.parse(readFileSync(fixtures.goldenSet, 'utf8'));

test('a healthy seeded ledger passes every eval check', () => {
  const { ledger, api } = seeded();
  const report = runEval(ledger, api, golden);
  assert.ok(report.ok, JSON.stringify(report.checks.flatMap((c) => c.failures)));
});

test('citation audit catches an evidence row citing a missing behavior', () => {
  const { ledger, api } = seeded();
  // insert evidence pointing at a behavior that does not exist
  ledger.insertEvidence(
    {
      id: 'EV-0002',
      behavior_ids: ['BHV-9999'],
      kind: 'test_run',
      outcome: 'supports',
      observed_at: '2026-06-10T00:00:00Z',
      source: { type: 'ci', ref: 'run 2' },
      redaction: { status: 'clean', rules_hit: [] },
      link_confidence: 'high',
      ingested_by: 'ingest:playwright-json@1',
    },
    'ingest:playwright-json@1',
  );
  const report = runEval(ledger, api, {});
  const audit = report.checks.find((c) => c.name === 'claim-citation audit');
  assert.ok(audit && audit.passed < audit.total);
  assert.ok(audit.failures.some((f) => f.includes('BHV-9999')));
  assert.equal(report.ok, false);
});

test('ask golden check fails loudly when an expected behavior is missing', () => {
  const { ledger, api } = seeded();
  const report = runEval(ledger, api, { ask: [{ question: 'do we test gift cards?', expectBehaviors: ['BHV-0001'] }] });
  const askCheck = report.checks.find((c) => c.name === 'ask golden-question set');
  assert.ok(askCheck && askCheck.passed === 0);
});

test('triage precision check scores against human labels', () => {
  const { ledger, api } = seeded();
  const triageLabels = golden.triage ?? [];
  assert.ok(triageLabels.length > 0, 'golden set must carry triage labels — empty would pass vacuously');
  const report = runEval(ledger, api, { triage: triageLabels });
  const triage = report.checks.find((c) => c.name === 'triage precision vs. labels');
  assert.ok(triage);
  assert.ok(triage.total > 0, 'triage check ran against zero labels (vacuous)');
  assert.equal(triage.passed, triage.total, JSON.stringify(triage.failures));
});

test('decline check scores the I9 rule', () => {
  const { ledger, api } = seeded();
  const declineCases = golden.decline ?? [];
  assert.ok(declineCases.length > 0, 'golden set must carry decline cases — empty would pass vacuously');
  const report = runEval(ledger, api, { decline: declineCases });
  const decline = report.checks.find((c) => c.name === 'decline-rule (I9)');
  assert.ok(decline);
  assert.ok(decline.total > 0, 'decline check ran against zero cases (vacuous)');
  assert.equal(decline.passed, decline.total);
});
