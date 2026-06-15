// CG-2.4 — table-driven decay tests with an injected clock (tests never
// sleep, BUILD-PLAN rule 5). Numbers are computed from SPEC §4 constants:
// τ_time(red 7, high 14, normal 30, low 90), τ_churn 400, W(1.0/0.85/0.5),
// thresholds 0.50 / 0.15.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeVerdict, freshnessOf, loadDecayConfig } from '../../decay.js';
import { StaticChurnIndex, NullChurnIndex } from '../../churn.js';
import { fixedClock } from '../../clock.js';
import type { Behavior, Criticality, Confidence, Evidence } from '../../types.js';

const config = loadDecayConfig();
const NOW = '2026-06-10T00:00:00Z';
const clock = fixedClock(NOW);

function behavior(over: Partial<Behavior> = {}): Behavior {
  return {
    id: 'BHV-0001',
    statement: 'A viewer-role user cannot bulk-delete records',
    area: 'permissions/records',
    criticality: 'normal',
    links: { implemented_in: ['src/records/**'] },
    confirmed_by: { person: 'ana', at: '2026-01-01T00:00:00Z' },
    created_by: 'manual',
    status: 'active',
    ...over,
  };
}

function evidence(over: Partial<Evidence> = {}): Evidence {
  return {
    id: 'EV-0001',
    behavior_ids: ['BHV-0001'],
    kind: 'test_run',
    outcome: 'supports',
    observed_at: NOW,
    source: { type: 'ci', ref: 'run 1' },
    redaction: { status: 'clean', rules_hit: [] },
    link_confidence: 'high',
    ingested_by: 'ingest:playwright-json@1',
    ...over,
  };
}

function daysAgo(days: number): string {
  return new Date(Date.parse(NOW) - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const noChurn = new NullChurnIndex();
const ctx = (churn = noChurn as StaticChurnIndex | NullChurnIndex) => ({ config, churn, clock });

// ---- time decay table ----
const timeTable: { criticality: Criticality; days: number; f: number }[] = [
  { criticality: 'normal', days: 0, f: 1.0 },
  { criticality: 'normal', days: 30, f: Math.exp(-1) },   // 0.3679 → STALE
  { criticality: 'normal', days: 90, f: Math.exp(-3) },   // 0.0498 → UNKNOWN
  { criticality: 'red', days: 7, f: Math.exp(-1) },       // red decays in a week
  { criticality: 'red', days: 2, f: Math.exp(-2 / 7) },   // 0.751 → VERIFIED
  { criticality: 'high', days: 14, f: Math.exp(-1) },
  { criticality: 'low', days: 90, f: Math.exp(-1) },      // low criticality lives long
];

for (const row of timeTable) {
  test(`time decay: ${row.criticality} @ ${row.days}d → F=${row.f.toFixed(4)}`, () => {
    const b = behavior({ criticality: row.criticality });
    const f = freshnessOf(b, evidence({ observed_at: daysAgo(row.days) }), ctx());
    assert.ok(Math.abs(f - row.f) < 1e-9, `expected ${row.f}, got ${f}`);
  });
}

// ---- churn decay table ----
const churnTable: { lines: number; factor: number }[] = [
  { lines: 0, factor: 1.0 },
  { lines: 400, factor: Math.exp(-1) },
  { lines: 600, factor: Math.exp(-1.5) }, // 0.2231
];

for (const row of churnTable) {
  test(`churn decay: ${row.lines} lines → ×${row.factor.toFixed(4)}`, () => {
    const churn = new StaticChurnIndex({ 'src/records/**': row.lines });
    const f = freshnessOf(behavior(), evidence(), ctx(churn));
    assert.ok(Math.abs(f - row.factor) < 1e-9);
  });
}

// ---- link-confidence weights ----
const weightTable: { confidence: Confidence; w: number }[] = [
  { confidence: 'high', w: 1.0 },
  { confidence: 'medium', w: 0.85 },
  { confidence: 'low', w: 0.5 },
];

for (const row of weightTable) {
  test(`link confidence ${row.confidence} weighs ${row.w}`, () => {
    const f = freshnessOf(behavior(), evidence({ link_confidence: row.confidence }), ctx());
    assert.ok(Math.abs(f - row.w) < 1e-9);
  });
}

// ---- threshold states ----
test('thresholds: F≥0.50 VERIFIED · 0.15≤F<0.50 STALE · F<0.15 UNKNOWN', () => {
  const fresh = computeVerdict(behavior(), [evidence()], ctx());
  assert.equal(fresh.state, 'VERIFIED');
  assert.equal(fresh.freshness, 1);

  const stale = computeVerdict(behavior(), [evidence({ observed_at: daysAgo(30) })], ctx());
  assert.equal(stale.state, 'STALE');
  assert.ok(Math.abs(stale.freshness - Math.exp(-1)) < 1e-9);

  const gone = computeVerdict(behavior(), [evidence({ observed_at: daysAgo(90) })], ctx());
  assert.equal(gone.state, 'UNKNOWN');
});

test('the demo numbers: 30 days + 600 churned lines drop VERIFIED → UNKNOWN', () => {
  const churn = new StaticChurnIndex({ 'src/records/**': 600 });
  const v = computeVerdict(behavior(), [evidence({ observed_at: daysAgo(30) })], ctx(churn));
  const expected = Math.exp(-1) * Math.exp(-1.5); // 0.0821
  assert.ok(Math.abs(v.freshness - expected) < 1e-9);
  assert.equal(v.state, 'UNKNOWN');
});

// ---- hard rules and state machine ----
test('hard rule: newest violates beats fresher supports, regardless of freshness', () => {
  const v = computeVerdict(
    behavior(),
    [
      evidence({ id: 'EV-0001', outcome: 'supports', observed_at: daysAgo(2) }),
      evidence({ id: 'EV-0002', outcome: 'violates', observed_at: daysAgo(1) }),
    ],
    ctx(),
  );
  assert.equal(v.state, 'VIOLATED');
  assert.equal(v.newest_evidence_id, 'EV-0002');
});

test('supports newer than violates: not VIOLATED', () => {
  const v = computeVerdict(
    behavior(),
    [
      evidence({ id: 'EV-0001', outcome: 'violates', observed_at: daysAgo(2) }),
      evidence({ id: 'EV-0002', outcome: 'supports', observed_at: daysAgo(1) }),
    ],
    ctx(),
  );
  assert.equal(v.state, 'VERIFIED');
});

test('confirmed behavior with zero conclusive evidence → ASSERTED', () => {
  const v = computeVerdict(behavior(), [evidence({ outcome: 'inconclusive' })], ctx());
  assert.equal(v.state, 'ASSERTED');
  assert.equal(v.freshness, 0);
});

test('unconfirmed behavior → UNKNOWN even with supporting evidence (I3)', () => {
  const unconfirmed = behavior();
  delete unconfirmed.confirmed_by;
  const v = computeVerdict(unconfirmed, [evidence()], ctx());
  assert.equal(v.state, 'UNKNOWN');
});

test('superseded evidence is ignored', () => {
  const v = computeVerdict(
    behavior(),
    [
      evidence({ id: 'EV-0001', outcome: 'violates', observed_at: daysAgo(1) }),
      evidence({ id: 'EV-0002', outcome: 'supports', observed_at: daysAgo(3), supersedes: 'EV-0001' }),
    ],
    ctx(),
  );
  assert.equal(v.state, 'VERIFIED', 'the superseded violation must not count');
});

test('every verdict carries all four I2 fields', () => {
  const v = computeVerdict(behavior(), [evidence()], ctx());
  assert.deepEqual(Object.keys(v).sort(), ['computed_at', 'freshness', 'newest_evidence_id', 'state']);
  assert.equal(v.computed_at, '2026-06-10T00:00:00Z');
});
