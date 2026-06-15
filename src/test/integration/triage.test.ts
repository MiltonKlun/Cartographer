// CG-6.1 — failure clustering by signature + deterministic classification;
// inconclusive clusters defer to the LLM rim, marked inference (never guessed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  signatureOf,
  classifyCluster,
  clusterFailures,
  renderTriage,
  type TestFailure,
} from '../../triage.js';
import { failuresFromPlaywright } from '../../triage-parse.js';
import { projectRoot } from '../../paths.js';
import type { Behavior } from '../../types.js';

const HEALTH_OK = { degraded: false } as const;
const report = join(projectRoot, 'testdata', 'triage-report.json');

function fail(over: Partial<TestFailure> = {}): TestFailure {
  return { testId: 't::x', errorMessage: 'AssertionError: expected 1 to equal 2', ...over };
}

test('signature: error class, normalized locator, stack hash', () => {
  const sig = signatureOf(
    fail({ errorMessage: "TimeoutError: waiting for getByRole('button', { name: 'Sign in' })" }),
  );
  assert.equal(sig.errorClass, 'TimeoutError');
  assert.match(sig.normalizedLocator ?? '', /getByRole/);
  assert.equal(sig.stackHash.length, 12);
});

test('normalized locator strips ids/numbers so equivalent failures group', () => {
  const a = signatureOf(fail({ errorMessage: 'expected #row-42 to be visible' }));
  const b = signatureOf(fail({ errorMessage: 'expected #row-99 to be visible' }));
  assert.equal(a.normalizedLocator, b.normalizedLocator);
});

test('classify: assertion on a value → product_bug', () => {
  const f = [fail({ errorMessage: 'AssertionError: expected 9.00 to equal 10.00' })];
  const { classification } = classifyCluster(f, signatureOf(f[0]!));
  assert.equal(classification, 'product_bug');
});

test('classify: locator timeout → test_brittleness', () => {
  const f = [fail({ errorMessage: "TimeoutError: locator.click: Timeout 30000ms exceeded waiting for getByRole('button')" })];
  const { classification } = classifyCluster(f, signatureOf(f[0]!));
  assert.equal(classification, 'test_brittleness');
});

test('classify: ECONNREFUSED / 503 → environment', () => {
  const f = [fail({ errorMessage: 'Error: connect ECONNREFUSED 127.0.0.1:5432' })];
  const { classification } = classifyCluster(f, signatureOf(f[0]!));
  assert.equal(classification, 'environment');
});

test('classify: no clear signal → inference (deferred, never guessed)', () => {
  const f = [fail({ errorMessage: 'Error: something happened' })];
  const { classification, rationale } = classifyCluster(f, signatureOf(f[0]!));
  assert.equal(classification, 'inference');
  assert.match(rationale, /defer to the LLM rim/);
});

test('clusterFailures groups by signature and links affected behaviors', () => {
  const behaviors: Behavior[] = [
    {
      id: 'BHV-0001',
      statement: 'Coupon applies before tax',
      area: 'checkout',
      criticality: 'red',
      links: { implemented_in: ['src/pricing/**'], verified_by: [{ test_id: 'tests/checkout.spec.ts::coupon applies before tax', confidence: 'high' }] },
      confirmed_by: { person: 'ana', at: '2026-06-01T00:00:00Z' },
      created_by: 'interview',
      status: 'active',
    },
  ];
  const clusters = clusterFailures(failuresFromPlaywright(report), behaviors);

  // 2 pricing assertion failures share src/pricing/coupon.ts root → one cluster
  const product = clusters.find((c) => c.classification === 'product_bug');
  assert.ok(product, 'expected a product_bug cluster');
  assert.equal(product.failures.length, 2);
  assert.deepEqual(product.affectedBehaviors, ['BHV-0001']);

  assert.ok(clusters.some((c) => c.classification === 'test_brittleness'));
  assert.ok(clusters.some((c) => c.classification === 'environment'));
  // product bugs lead the report
  assert.equal(clusters[0]?.classification, 'product_bug');
});

test('renderTriage: inference clusters are labeled; brittleness suggests quarantine', () => {
  const clusters = clusterFailures(failuresFromPlaywright(report), []);
  const out = renderTriage('run-8841', clusters, HEALTH_OK);
  assert.match(out, /cart triage — run-8841: 4 failure\(s\) in 3 cluster\(s\)/);
  assert.match(out, /TEST BRITTLENESS/);
  assert.match(out, /cart quarantine add/);
});

test('empty run triages cleanly', () => {
  const out = renderTriage('run-0', [], HEALTH_OK);
  assert.match(out, /no failures/);
});
