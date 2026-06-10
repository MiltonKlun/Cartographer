// CG-2.3 — health: ingestor staleness degrades loudly (I6) and the banner
// reaches every renderer call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from './db.js';
import { computeHealth, computeStatus } from './health.js';
import { loadDecayConfig } from './decay.js';
import { NullChurnIndex } from './churn.js';
import { fixedClock } from './clock.js';
import { renderClaims } from './renderer.js';
import type { Evidence } from './types.js';

function tempLedger(clockIso: string): Ledger {
  return new Ledger(join(mkdtempSync(join(tmpdir(), 'cart-health-')), 'ledger.db'), {
    clock: fixedClock(clockIso),
  });
}

function someEvidence(id: string): Evidence {
  return {
    id,
    behavior_ids: [],
    kind: 'test_run',
    outcome: 'supports',
    observed_at: '2026-06-08T03:00:00Z',
    source: { type: 'ci', ref: 'run 1' },
    redaction: { status: 'clean', rules_hit: [] },
    link_confidence: 'high',
    ingested_by: 'ingest:playwright-json@1',
  };
}

test('no ingestors yet → healthy (cold start is honest, not degraded)', () => {
  const ledger = tempLedger('2026-06-10T00:00:00Z');
  const { health, ingestors } = computeHealth(ledger, fixedClock('2026-06-10T00:00:00Z'));
  assert.equal(health.degraded, false);
  assert.deepEqual(ingestors, []);
});

test('ingestor within SLA → healthy; beyond SLA → degraded with reason and since', () => {
  const ledger = tempLedger('2026-06-08T03:00:00Z'); // mutation logged at this time
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
  const ledger = tempLedger('2026-06-08T03:00:00Z');
  ledger.insertEvidence(someEvidence('EV-0001'), 'ingest:playwright-json@1');
  const { health } = computeHealth(ledger, fixedClock('2026-06-10T03:00:00Z'));
  const out = renderClaims([{ text: 'anything', citations: ['EV-0001'] }], health);
  assert.match(out.split('\n')[0] ?? '', /HEALTH DEGRADED/);
});

test('status report: counts and verdict histogram', () => {
  const ledger = tempLedger('2026-06-10T00:00:00Z');
  ledger.insertBehavior(
    {
      id: 'BHV-0001',
      statement: 'A viewer-role user cannot bulk-delete records',
      area: 'permissions/records',
      criticality: 'normal',
      links: {},
      confirmed_by: { person: 'ana', at: '2026-06-01T00:00:00Z' },
      created_by: 'manual',
      status: 'active',
    },
    'ana',
  );
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
