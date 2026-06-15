// CG-5.1/5.2/5.3 — cart pr risk note: diff → at-risk behaviors ranked by
// criticality × (1−F), new files → gaps, and the retro-validation gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../../db.js';
import { QueryApi } from '../../query.js';
import { assembleRiskNote, renderRiskNote, queueGaps } from '../../pr.js';
import { diffFromText } from '../../diff.js';
import { loadDecayConfig } from '../../decay.js';
import { NullChurnIndex } from '../../churn.js';
import { fixedClock } from '../../clock.js';
import type { Behavior, Evidence, Question } from '../../types.js';

const NOW = '2026-06-11T00:00:00Z';
const clock = fixedClock(NOW);
const ctx = { config: loadDecayConfig(), churn: new NullChurnIndex(), clock };
const HEALTH_OK = { degraded: false } as const;

function ledgerWith(behaviors: Behavior[], evidence: Evidence[] = []): Ledger {
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'cart-pr-')), 'ledger.db'), { clock });
  for (const b of behaviors) ledger.insertBehavior(b, 'ana');
  for (const e of evidence) ledger.insertEvidence(e, 'ingest:playwright-json@1');
  return ledger;
}

function behavior(id: string, over: Partial<Behavior> = {}): Behavior {
  return {
    id,
    statement: 'A viewer-role user cannot bulk-delete records',
    area: 'permissions/records',
    criticality: 'red',
    links: { implemented_in: ['src/records/**'] },
    confirmed_by: { person: 'ana', at: '2026-06-01T00:00:00Z' },
    created_by: 'interview',
    status: 'active',
    ...over,
  };
}

function support(id: string, behaviorId: string, observedAt: string): Evidence {
  return {
    id,
    behavior_ids: [behaviorId],
    kind: 'test_run',
    outcome: 'supports',
    observed_at: observedAt,
    source: { type: 'ci', ref: 'run 1' },
    redaction: { status: 'clean', rules_hit: [] },
    link_confidence: 'high',
    ingested_by: 'ingest:playwright-json@1',
  };
}

const recordsDiff = diffFromText(
  '182\t40\tsrc/records/delete.ts\n60\t0\tsrc/records/export.ts\n create mode 100644 src/records/export.ts',
);

test('behaviors whose implemented_in overlaps the diff appear, ranked by risk', () => {
  const ledger = ledgerWith(
    [
      behavior('BHV-0142', { criticality: 'red' }), // stale → high risk
      behavior('BHV-0150', { criticality: 'high', statement: 'bulk-delete confirms count' }), // fresh → low risk
    ],
    [
      support('EV-0001', 'BHV-0142', '2026-05-12T00:00:00Z'), // ~30d old, red τ=7 → very stale
      support('EV-0002', 'BHV-0150', '2026-06-10T00:00:00Z'), // 1d old → VERIFIED
    ],
  );
  const note = assembleRiskNote(new QueryApi(ledger, ctx), 'PR #412', recordsDiff, HEALTH_OK);
  assert.equal(note.rows.length, 2);
  assert.equal(note.rows[0]?.behavior.id, 'BHV-0142', 'stale red ranks first');
  assert.ok(note.rows[0]!.risk > note.rows[1]!.risk);
  assert.equal(note.rows[0]?.verdict.state, 'UNKNOWN'); // decayed past stale
  assert.equal(note.rows[1]?.verdict.state, 'VERIFIED');
});

test('unconfirmed behaviors are excluded from the risk note (I3)', () => {
  const unconfirmed = behavior('BHV-0200');
  delete unconfirmed.confirmed_by;
  const ledger = ledgerWith([unconfirmed]);
  const note = assembleRiskNote(new QueryApi(ledger, ctx), 'PR #1', recordsDiff, HEALTH_OK);
  assert.equal(note.rows.length, 0);
});

test('new source files no behavior covers become gap candidates', () => {
  const ledger = ledgerWith([behavior('BHV-0142', { links: { implemented_in: ['src/records/delete.ts'] } })]);
  const note = assembleRiskNote(new QueryApi(ledger, ctx), 'PR #412', recordsDiff, HEALTH_OK);
  assert.deepEqual(note.gaps.map((g) => g.path), ['src/records/export.ts']);
});

test('new TEST files are not gaps (gaps are about product code)', () => {
  const d = diffFromText('40\t0\ttests/new.spec.ts\n create mode 100644 tests/new.spec.ts');
  const ledger = ledgerWith([]);
  const note = assembleRiskNote(new QueryApi(ledger, ctx), 'PR #5', d, HEALTH_OK);
  assert.equal(note.gaps.length, 0);
});

test('--queue files a Q per gap, not a guessed behavior (I3)', () => {
  const ledger = ledgerWith([behavior('BHV-0142', { links: { implemented_in: ['src/records/delete.ts'] } })]);
  const note = assembleRiskNote(new QueryApi(ledger, ctx), 'PR #412', recordsDiff, HEALTH_OK);
  const queued = queueGaps(ledger, note, 'erick', clock);
  assert.equal(queued.length, 1);
  assert.equal(note.gaps[0]?.questionId, queued[0]?.id);
  const stored = ledger.allRecords('questions') as Question[];
  assert.match(stored[0]?.why_asked ?? '', /adds src\/records\/export\.ts/);
  assert.equal((ledger.allRecords('behaviors') as Behavior[]).length, 1, 'no behavior invented');
});

test('rendered note: header with line counts, cited rows, recommendation labeled inference', () => {
  const ledger = ledgerWith(
    [behavior('BHV-0142')],
    [support('EV-0001', 'BHV-0142', '2026-05-12T00:00:00Z')],
  );
  const note = assembleRiskNote(new QueryApi(ledger, ctx), 'PR #412', recordsDiff, HEALTH_OK);
  const out = renderRiskNote(note);
  assert.match(out, /^Cartographer — risk note for PR #412 \(\+242\/−40 in src\/records\/\*\*\)/);
  assert.match(out, /BHV-0142 .*\[red\]/);
  assert.match(out, /\[BHV-0142, EV-0001\]/);
  assert.match(out, /^inference: before merging/m);
  assert.match(out, /Every behavior line cites ledger rows/);
});

test('clean PR (no covered code, no new source) renders an honest UNKNOWN', () => {
  const ledger = ledgerWith([behavior('BHV-0142', { links: { implemented_in: ['src/billing/**'] } })]);
  const note = assembleRiskNote(new QueryApi(ledger, ctx), 'PR #7', diffFromText('3\t1\tREADME.md'), HEALTH_OK);
  const out = renderRiskNote(note);
  assert.match(out, /UNKNOWN: PR #7 touches no code covered/);
});

// ---- CG-5.3 retro-validation gate ----
// Replay historical incident PRs; the note MUST flag the incident's behavior.
// If any case fails, linking is wrong and the surface must not be trusted.
interface IncidentCase {
  name: string;
  incidentBehavior: Behavior;
  evidence: Evidence[];
  prDiff: string;
  expectFlagged: string;
}

const INCIDENTS: IncidentCase[] = [
  {
    name: 'INC-23: viewer bulk-delete regression in a records PR',
    incidentBehavior: behavior('BHV-0142', {
      criticality: 'red',
      links: { implemented_in: ['src/records/**', 'src/auth/roles.ts'] },
    }),
    evidence: [support('EV-9001', 'BHV-0142', '2026-04-01T00:00:00Z')],
    prDiff: '90\t12\tsrc/records/bulk.ts\n5\t2\tsrc/auth/roles.ts',
    expectFlagged: 'BHV-0142',
  },
  {
    name: 'INC-31: coupon stacking regression in a pricing PR',
    incidentBehavior: behavior('BHV-0093', {
      statement: 'Two coupons cannot be applied to one cart',
      area: 'checkout/coupons',
      criticality: 'red',
      links: { implemented_in: ['src/pricing/**'] },
    }),
    evidence: [support('EV-9100', 'BHV-0093', '2026-03-15T00:00:00Z')],
    prDiff: '210\t40\tsrc/pricing/coupon.ts',
    expectFlagged: 'BHV-0093',
  },
  {
    name: 'INC-44: auth bypass in a session-handling PR',
    incidentBehavior: behavior('BHV-0210', {
      statement: 'An expired session cannot perform writes',
      area: 'auth/session',
      criticality: 'red',
      links: { implemented_in: ['src/auth/session.ts'] },
    }),
    evidence: [support('EV-9200', 'BHV-0210', '2026-05-01T00:00:00Z')],
    prDiff: '33\t8\tsrc/auth/session.ts',
    expectFlagged: 'BHV-0210',
  },
];

for (const inc of INCIDENTS) {
  test(`retro-validation — ${inc.name}: note flags ${inc.expectFlagged}`, () => {
    const ledger = ledgerWith([inc.incidentBehavior], inc.evidence);
    const note = assembleRiskNote(new QueryApi(ledger, ctx), inc.name, diffFromText(inc.prDiff), HEALTH_OK);
    const flagged = note.rows.map((r) => r.behavior.id);
    assert.ok(
      flagged.includes(inc.expectFlagged),
      `the risk note for "${inc.name}" should have flagged ${inc.expectFlagged}; flagged: ${flagged.join(', ') || '(none)'}`,
    );
    // and it should be near the top: a red incident behavior is high-risk
    assert.equal(note.rows[0]?.behavior.id, inc.expectFlagged, 'incident behavior should rank first');
  });
}
