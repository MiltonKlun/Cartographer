// CG-10.1 — the eval harness: golden ask, citation audit, triage precision,
// decline rule. The harness is itself tested against a seeded ledger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from './db.js';
import { QueryApi } from './query.js';
import { runEval, type GoldenSet } from './eval.js';
import { loadDecayConfig } from './decay.js';
import { NullChurnIndex } from './churn.js';
import { fixedClock } from './clock.js';
import { projectRoot } from './paths.js';
import type { Behavior, Evidence } from './types.js';

const clock = fixedClock('2026-06-11T12:00:00Z');
const ctx = { config: loadDecayConfig(), churn: new NullChurnIndex(), clock };

function seeded(): { ledger: Ledger; api: QueryApi } {
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'cart-eval-')), 'ledger.db'), { clock });
  const b: Behavior = {
    id: 'BHV-0001',
    statement: 'Coupon applies before tax',
    area: 'checkout/coupons',
    criticality: 'red',
    links: {},
    confirmed_by: { person: 'ana', at: '2026-06-01T00:00:00Z' },
    created_by: 'interview',
    status: 'active',
  };
  ledger.insertBehavior(b, 'ana');
  const e: Evidence = {
    id: 'EV-0001',
    behavior_ids: ['BHV-0001'],
    kind: 'test_run',
    outcome: 'supports',
    observed_at: '2026-06-10T00:00:00Z',
    source: { type: 'ci', ref: 'run 1' },
    redaction: { status: 'clean', rules_hit: [] },
    link_confidence: 'high',
    ingested_by: 'ingest:playwright-json@1',
  };
  ledger.insertEvidence(e, 'ingest:playwright-json@1');
  return { ledger, api: new QueryApi(ledger, ctx) };
}

const golden: GoldenSet = JSON.parse(readFileSync(join(projectRoot, 'testdata', 'golden-set.json'), 'utf8'));

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
  const report = runEval(ledger, api, { triage: triageLabels });
  const triage = report.checks.find((c) => c.name === 'triage precision vs. labels');
  assert.ok(triage);
  assert.equal(triage.passed, triage.total, JSON.stringify(triage.failures));
});

test('decline check scores the I9 rule', () => {
  const { ledger, api } = seeded();
  const declineCases = golden.decline ?? [];
  const report = runEval(ledger, api, { decline: declineCases });
  const decline = report.checks.find((c) => c.name === 'decline-rule (I9)');
  assert.ok(decline);
  assert.equal(decline.passed, decline.total);
});
