// CG-2.3 — health: ingestor staleness degrades loudly (I6) and the banner
// reaches every renderer call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../../db.js';
import { computeHealth, computeStatus } from '../../health.js';
import { loadDecayConfig } from '../../decay.js';
import { NullChurnIndex } from '../../churn.js';
import { fixedClock } from '../../clock.js';
import { renderClaims } from '../../renderer.js';
import { tempLedger } from '../helpers/ledger.js';
import { makeBehavior, makeEvidence } from '../helpers/factories.js';
import type { Evidence } from '../../types.js';

function healthLedger(clockIso: string): Ledger {
  return tempLedger(fixedClock(clockIso));
}

function someEvidence(id: string): Evidence {
  return makeEvidence({ id, behavior_ids: [], observed_at: '2026-06-08T03:00:00Z' });
}

test('no ingestors yet → healthy (cold start is honest, not degraded)', () => {
  const ledger = healthLedger('2026-06-10T00:00:00Z');
  const { health, ingestors } = computeHealth(ledger, fixedClock('2026-06-10T00:00:00Z'));
  assert.equal(health.degraded, false);
  assert.deepEqual(ingestors, []);
});

test('ingestor within SLA → healthy; beyond SLA → degraded with reason and since', () => {
  const ledger = healthLedger('2026-06-08T03:00:00Z'); // mutation logged at this time
  ledger.insertEvidence(someEvidence('EV-0001'), 'ingest:playwright-json@1');

  const fresh = computeHealth(ledger, fixedClock('2026-06-08T20:00:00Z')); // 17h later
  assert.equal(fresh.health.degraded, false);
  assert.equal(fresh.ingestors[0]?.withinSla, true);

  const stale = computeHealth(ledger, fixedClock('2026-06-10T03:00:00Z')); // 48h later
  assert.equal(stale.health.degraded, true);
  assert.match(stale.health.reason ?? '', /ingest:playwright-json@1 has not ingested for 48h/);
  assert.equal(stale.health.since, '2026-06-08T03:00:00Z');
});

test('I6: degraded health reaches the rendered output as a banner', () => {
  const ledger = healthLedger('2026-06-08T03:00:00Z');
  ledger.insertEvidence(someEvidence('EV-0001'), 'ingest:playwright-json@1');
  const { health } = computeHealth(ledger, fixedClock('2026-06-10T03:00:00Z'));
  const out = renderClaims([{ text: 'anything', citations: ['EV-0001'] }], health);
  assert.match(out.split('\n')[0] ?? '', /HEALTH DEGRADED/);
});

test('status report: counts and verdict histogram', () => {
  const ledger = healthLedger('2026-06-10T00:00:00Z');
  ledger.insertBehavior(makeBehavior({ criticality: 'normal', created_by: 'manual' }), 'ana');
  ledger.insertEvidence(
    { ...someEvidence('EV-0001'), behavior_ids: ['BHV-0001'], observed_at: '2026-06-10T00:00:00Z' },
    'ingest:playwright-json@1',
  );
  const report = computeStatus(ledger, {
    config: loadDecayConfig(),
    churn: new NullChurnIndex(),
    clock: fixedClock('2026-06-10T00:00:00Z'),
  });
  assert.equal(report.counts.behaviors, 1);
  assert.equal(report.counts.confirmed, 1);
  assert.equal(report.counts.evidence, 1);
  assert.equal(report.verdictHistogram.VERIFIED, 1);
  assert.equal(report.health.degraded, false);
});
