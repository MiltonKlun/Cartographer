// CG-7.1 — the morning brief: ordered sections, overnight transitions from
// snapshot diff, decayed red behaviors, quarantine expiries, top questions,
// health footer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from './db.js';
import { QueryApi } from './query.js';
import { assembleBrief, renderBrief } from './brief.js';
import { loadDecayConfig } from './decay.js';
import { NullChurnIndex } from './churn.js';
import { fixedClock, type Clock } from './clock.js';
import type { Behavior, Evidence, Question } from './types.js';

function ctxAt(iso: string): { config: ReturnType<typeof loadDecayConfig>; churn: NullChurnIndex; clock: Clock } {
  return { config: loadDecayConfig(), churn: new NullChurnIndex(), clock: fixedClock(iso) };
}

function redBehavior(id: string, over: Partial<Behavior> = {}): Behavior {
  return {
    id,
    statement: 'A viewer-role user cannot bulk-delete records',
    area: 'permissions/records',
    criticality: 'red',
    links: {},
    confirmed_by: { person: 'ana', at: '2026-06-01T00:00:00Z' },
    created_by: 'interview',
    status: 'active',
    ...over,
  };
}

function support(id: string, behaviorId: string, at: string, outcome: Evidence['outcome'] = 'supports'): Evidence {
  return {
    id,
    behavior_ids: [behaviorId],
    kind: 'test_run',
    outcome,
    observed_at: at,
    source: { type: 'ci', ref: 'run 1' },
    redaction: { status: 'clean', rules_hit: [] },
    link_confidence: 'high',
    ingested_by: 'ingest:playwright-json@1',
  };
}

function freshLedger(clock: Clock): Ledger {
  return new Ledger(join(mkdtempSync(join(tmpdir(), 'cart-brief-')), 'ledger.db'), { clock });
}

const emptyQuarantine = (): string => {
  const p = join(mkdtempSync(join(tmpdir(), 'cart-brief-q-')), 'quarantine.json');
  writeFileSync(p, JSON.stringify({ version: 1, entries: [] }));
  return p;
};

test('first brief: no prior snapshot, transitions section says so', () => {
  const clock = fixedClock('2026-06-11T08:00:00Z');
  const ledger = freshLedger(clock);
  ledger.insertBehavior(redBehavior('BHV-0001'), 'ana');
  const ctx = ctxAt('2026-06-11T08:00:00Z');
  const data = assembleBrief(ledger, new QueryApi(ledger, ctx), ctx, { quarantinePath: emptyQuarantine(), writeSnapshot: true });
  assert.equal(data.isFirstBrief, true);
  assert.match(renderBrief(data), /first brief — no prior snapshot/);
});

test('overnight transition VERIFIED → STALE shows up after a second brief', () => {
  const ledger = freshLedger(fixedClock('2026-06-11T08:00:00Z'));
  ledger.insertBehavior(redBehavior('BHV-0001'), 'ana');
  // fresh evidence as of day 1 → VERIFIED
  ledger.insertEvidence(support('EV-0001', 'BHV-0001', '2026-06-11T00:00:00Z'), 'ingest:playwright-json@1');

  // brief on day 1 writes the snapshot (VERIFIED)
  const d1 = ctxAt('2026-06-11T08:00:00Z');
  assembleBrief(ledger, new QueryApi(ledger, d1), d1, { quarantinePath: emptyQuarantine(), writeSnapshot: true });

  // brief 10 days later: red τ=7, no new evidence → decayed to STALE/UNKNOWN
  const d2 = ctxAt('2026-06-21T08:00:00Z');
  const data = assembleBrief(ledger, new QueryApi(ledger, d2), d2, { quarantinePath: emptyQuarantine(), writeSnapshot: true });
  const t = data.transitions.find((x) => x.behaviorId === 'BHV-0001');
  assert.ok(t, 'expected a transition for BHV-0001');
  assert.equal(t.from, 'VERIFIED');
  assert.ok(t.to === 'STALE' || t.to === 'UNKNOWN');
});

test('→ VIOLATED transitions lead the section', () => {
  const ledger = freshLedger(fixedClock('2026-06-11T08:00:00Z'));
  ledger.insertBehavior(redBehavior('BHV-0001'), 'ana');
  ledger.insertBehavior(redBehavior('BHV-0002', { statement: 'Coupon applies before tax', criticality: 'normal' }), 'ana');
  ledger.insertEvidence(support('EV-0001', 'BHV-0001', '2026-06-11T00:00:00Z'), 'ingest:playwright-json@1');
  ledger.insertEvidence(support('EV-0002', 'BHV-0002', '2026-06-11T00:00:00Z'), 'ingest:playwright-json@1');

  const d1 = ctxAt('2026-06-11T08:00:00Z');
  assembleBrief(ledger, new QueryApi(ledger, d1), d1, { quarantinePath: emptyQuarantine(), writeSnapshot: true });

  // BHV-0002 gets violated; BHV-0001 just decays a little
  ledger.insertEvidence(support('EV-0003', 'BHV-0002', '2026-06-11T12:00:00Z', 'violates'), 'ingest:playwright-json@1');
  const d2 = ctxAt('2026-06-12T08:00:00Z');
  const data = assembleBrief(ledger, new QueryApi(ledger, d2), d2, { quarantinePath: emptyQuarantine(), writeSnapshot: true });
  assert.equal(data.transitions[0]?.to, 'VIOLATED');
  assert.match(renderBrief(data), /🚨 BHV-0002/);
});

test('decayed red section lists stale red behaviors, freshest pain first', () => {
  const ledger = freshLedger(fixedClock('2026-07-01T08:00:00Z'));
  ledger.insertBehavior(redBehavior('BHV-0001'), 'ana');
  ledger.insertEvidence(support('EV-0001', 'BHV-0001', '2026-06-01T00:00:00Z'), 'ingest:playwright-json@1'); // ~30d old, red
  const ctx = ctxAt('2026-07-01T08:00:00Z');
  const data = assembleBrief(ledger, new QueryApi(ledger, ctx), ctx, { quarantinePath: emptyQuarantine(), writeSnapshot: false });
  assert.equal(data.decayedRed.length, 1);
  assert.equal(data.decayedRed[0]?.id, 'BHV-0001');
});

test('quarantine expiries surface in the brief (wired from Phase 6)', () => {
  const clock = fixedClock('2026-06-25T08:00:00Z');
  const ledger = freshLedger(clock);
  const qPath = join(mkdtempSync(join(tmpdir(), 'cart-brief-q-')), 'quarantine.json');
  writeFileSync(
    qPath,
    JSON.stringify({
      version: 1,
      entries: [{ test_id: 'tests/login.spec.ts::flaky', ticket: 'FLAKE-101', entered_at: '2026-06-11T00:00:00Z', expires_at: '2026-06-18T00:00:00Z' }],
    }),
  );
  const ctx = ctxAt('2026-06-25T08:00:00Z');
  const data = assembleBrief(ledger, new QueryApi(ledger, ctx), ctx, { quarantinePath: qPath, writeSnapshot: false });
  assert.equal(data.quarantineExpiries.length, 1);
  assert.match(renderBrief(data), /⚠ tests\/login\.spec\.ts::flaky .* expired/);
});

test('top 3 open questions, health footer present', () => {
  const clock = fixedClock('2026-06-11T08:00:00Z');
  const ledger = freshLedger(clock);
  for (let i = 1; i <= 4; i++) {
    const q: Question = {
      id: `Q-000${i}`,
      behavior_id: null,
      prompt: `question ${i}?`,
      why_asked: 'gap',
      status: 'open',
    };
    ledger.insertQuestion(q, 'cart');
  }
  const ctx = ctxAt('2026-06-11T08:00:00Z');
  const data = assembleBrief(ledger, new QueryApi(ledger, ctx), ctx, { quarantinePath: emptyQuarantine(), writeSnapshot: false });
  assert.equal(data.topQuestions.length, 3);
  const out = renderBrief(data);
  assert.match(out, /ingestion health: OK/);
  assert.match(out, /Top 3 open questions/);
});

test('rendered brief keeps the fixed section order', () => {
  const clock = fixedClock('2026-06-11T08:00:00Z');
  const ledger = freshLedger(clock);
  ledger.insertBehavior(redBehavior('BHV-0001'), 'ana');
  const ctx = ctxAt('2026-06-11T08:00:00Z');
  const out = renderBrief(assembleBrief(ledger, new QueryApi(ledger, ctx), ctx, { quarantinePath: emptyQuarantine(), writeSnapshot: false }));
  const order = ['Overnight transitions:', 'Decayed red-criticality', "Today's open PRs", 'Quarantine expiries:', 'open questions:', 'ingestion health:'];
  let last = -1;
  for (const marker of order) {
    const idx = out.indexOf(marker);
    assert.ok(idx > last, `section "${marker}" out of order`);
    last = idx;
  }
});
