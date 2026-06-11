// CG-4.2 — batch interview: confirm writes confirmed_by (the approval, I3);
// merge folds verified_by and retires; discard retires (nothing deleted, I11).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from './db.js';
import { applyInterview, pendingProposals } from './interview.js';
import { fixedClock } from './clock.js';
import type { Behavior } from './types.js';

const clock = fixedClock('2026-06-11T09:00:00Z');

function proposal(id: string, over: Partial<Behavior> = {}): Behavior {
  return {
    id,
    statement: 'A viewer-role user cannot bulk-delete records',
    area: 'permissions/records',
    criticality: 'red',
    links: { verified_by: [{ test_id: `tests/p.spec.ts::${id}`, confidence: 'high' }] },
    created_by: 'import',
    status: 'active',
    ...over,
  };
}

function seeded(): Ledger {
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'cart-iv-')), 'ledger.db'), { clock });
  ledger.insertBehavior(proposal('BHV-0001'), 'import');
  ledger.insertBehavior(proposal('BHV-0002', { statement: 'Viewer cannot mass-delete records' }), 'import');
  ledger.insertBehavior(proposal('BHV-0003', { statement: 'Tooltip shows on hover', criticality: 'normal' }), 'import');
  return ledger;
}

test('pendingProposals lists unconfirmed active behaviors, capped', () => {
  const ledger = seeded();
  assert.equal(pendingProposals(ledger).length, 3);
  assert.equal(pendingProposals(ledger, 2).length, 2);
});

test('confirm writes confirmed_by — the interview is the approval (I3)', () => {
  const ledger = seeded();
  const outcome = applyInterview(ledger, 'ana', [{ behaviorId: 'BHV-0001', decision: { kind: 'confirm' } }], clock);
  assert.deepEqual(outcome.confirmed, ['BHV-0001']);
  const b = ledger.getBehavior('BHV-0001');
  assert.deepEqual(b?.confirmed_by, { person: 'ana', at: '2026-06-11T09:00:00Z' });
});

test('confirm with inline edit applies the edit and confirms in one step', () => {
  const ledger = seeded();
  applyInterview(
    ledger,
    'ana',
    [{ behaviorId: 'BHV-0003', decision: { kind: 'confirm', edit: { criticality: 'high', statement: 'Help tooltip appears on hover' } } }],
    clock,
  );
  const b = ledger.getBehavior('BHV-0003');
  assert.equal(b?.criticality, 'high');
  assert.equal(b?.statement, 'Help tooltip appears on hover');
  assert.ok(b?.confirmed_by);
});

test('merge folds verified_by into the target and retires the duplicate (I11)', () => {
  const ledger = seeded();
  // confirm the survivor first, then merge the duplicate into it
  applyInterview(ledger, 'ana', [{ behaviorId: 'BHV-0001', decision: { kind: 'confirm' } }], clock);
  const outcome = applyInterview(ledger, 'ana', [{ behaviorId: 'BHV-0002', decision: { kind: 'merge', into: 'BHV-0001' } }], clock);
  assert.deepEqual(outcome.merged, [{ from: 'BHV-0002', into: 'BHV-0001' }]);

  const survivor = ledger.getBehavior('BHV-0001');
  const testIds = (survivor?.links.verified_by ?? []).map((v) => v.test_id).sort();
  assert.deepEqual(testIds, ['tests/p.spec.ts::BHV-0001', 'tests/p.spec.ts::BHV-0002']);

  const dup = ledger.getBehavior('BHV-0002');
  assert.equal(dup?.status, 'retired', 'merged proposal is retired, not deleted (I11)');
});

test('discard retires the proposal with a reason (I11: history kept)', () => {
  const ledger = seeded();
  const outcome = applyInterview(ledger, 'ana', [{ behaviorId: 'BHV-0003', decision: { kind: 'discard', reason: 'not a product promise' } }], clock);
  assert.deepEqual(outcome.discarded, ['BHV-0003']);
  const b = ledger.getBehavior('BHV-0003');
  assert.equal(b?.status, 'retired');
  assert.match(b?.notes ?? '', /discarded: not a product promise/);
  assert.equal(b?.confirmed_by, undefined, 'discarded ≠ confirmed');
});

test('confirming an already-confirmed behavior is refused', () => {
  const ledger = seeded();
  applyInterview(ledger, 'ana', [{ behaviorId: 'BHV-0001', decision: { kind: 'confirm' } }], clock);
  assert.throws(
    () => applyInterview(ledger, 'ana', [{ behaviorId: 'BHV-0001', decision: { kind: 'confirm' } }], clock),
    /already confirmed/,
  );
});

test('a bad decision rolls back the whole batch (atomic)', () => {
  const ledger = seeded();
  assert.throws(() =>
    applyInterview(
      ledger,
      'ana',
      [
        { behaviorId: 'BHV-0001', decision: { kind: 'confirm' } },
        { behaviorId: 'BHV-9999', decision: { kind: 'confirm' } }, // does not exist
      ],
      clock,
    ),
  );
  assert.equal(ledger.getBehavior('BHV-0001')?.confirmed_by, undefined, 'first confirm rolled back');
});
