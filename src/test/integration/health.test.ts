// CG-2.3 — health: ingestor staleness degrades loudly (I6) and the banner
// reaches every renderer call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../../db.js';
import { computeHealth, computeStatus, healthConfig, loadHealthConfig, DEFAULT_SLA_HOURS, DEFAULT_RETIREMENT_HOURS, type HealthConfig } from '../../health.js';
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

// ---- H3: SLA realism — retirement window + expected-ingestors ----

/** ~400h of staleness: mutation at T, clock 400h later. */
function stale400(over?: Partial<HealthConfig>) {
  const ledger = healthLedger('2026-06-01T00:00:00Z');
  ledger.insertEvidence(someEvidence('EV-0001'), 'ingest:junit-once@1');
  const clock = fixedClock('2026-06-17T16:00:00Z'); // 400h after 2026-06-01T00:00
  const cfg = healthConfig(over); // defaults unless overridden
  return computeHealth(ledger, clock, cfg);
}

test('H3.1: a long-quiet UNLISTED ingestor goes inactive and stops degrading health', () => {
  const { health, ingestors } = stale400();
  assert.equal(ingestors[0]?.state, 'inactive', 'past retirement (336h) and unlisted ⇒ inactive');
  assert.equal(ingestors[0]?.withinSla, false);
  assert.equal(health.degraded, false, 'an inactive one-off feed must not degrade the map forever');
});

test('H3.2: an ingestor listed in expected_ingestors NEVER retires — it keeps degrading', () => {
  const { health, ingestors } = stale400({ expected_ingestors: ['ingest:junit-once@1'] });
  assert.equal(ingestors[0]?.state, 'stale', 'a deliberate feed stays stale, never inactive');
  assert.equal(health.degraded, true, 'a listed feed gone quiet must keep the banner up');
  assert.match(health.reason ?? '', /ingest:junit-once@1 has not ingested/);
});

test('H3.2: loadHealthConfig returns defaults when the file is absent (zero-config works)', () => {
  const cfg = loadHealthConfig('/no/such/health.json');
  assert.equal(cfg.sla_hours, DEFAULT_SLA_HOURS);
  assert.equal(cfg.retirement_hours, DEFAULT_RETIREMENT_HOURS);
  assert.deepEqual(cfg.expected_ingestors, []);
});

test('H3.3: computeStatus reports inactive ingestors, distinguished from fresh/stale', () => {
  // Health reads the MUTATION-log timestamp (the ledger clock at write time),
  // so we advance a mutable clock between inserts to get two last-success times.
  let nowIso = '2026-06-01T00:00:00Z';
  const ledger = tempLedger(() => new Date(nowIso));
  ledger.insertEvidence(someEvidence('EV-0001'), 'ingest:junit-once@1'); // logged at 2026-06-01 → 400h stale → inactive
  nowIso = '2026-06-17T15:00:00Z';
  ledger.insertEvidence({ ...someEvidence('EV-0002'), observed_at: nowIso }, 'ingest:playwright@1'); // logged 1h before eval → fresh
  const report = computeStatus(
    ledger,
    { config: loadDecayConfig(), churn: new NullChurnIndex(), clock: fixedClock('2026-06-17T16:00:00Z') },
  );
  const byName = Object.fromEntries(report.ingestors.map((i) => [i.ingestor, i.state]));
  assert.equal(byName['ingest:junit-once@1'], 'inactive');
  assert.equal(byName['ingest:playwright@1'], 'fresh');
  assert.equal(report.health.degraded, false, 'only inactive + fresh present ⇒ not degraded');
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
