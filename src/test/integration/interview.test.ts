// CG-4.2 — batch interview: confirm writes confirmed_by (the approval, I3);
// merge folds verified_by and retires; discard retires (nothing deleted, I11).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../../db.js';
import { applyInterview, pendingProposals, nextQuestion, answerQuestion } from '../../interview.js';
import { fixedClock } from '../../clock.js';
import { tempLedger } from '../helpers/ledger.js';
import { makeProposal, makeQuestion } from '../helpers/factories.js';
import type { Behavior, Question } from '../../types.js';

const clock = fixedClock('2026-06-11T09:00:00Z');

function proposal(id: string, over: Partial<Behavior> = {}): Behavior {
  return makeProposal({
    id,
    links: { verified_by: [{ test_id: `tests/p.spec.ts::${id}`, confidence: 'high' }] },
    ...over,
  });
}

function seeded(): Ledger {
  const ledger = tempLedger(clock);
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

// ---- CG-7.2 single-question flow ----

function withQuestion(): Ledger {
  const ledger = tempLedger(clock);
  ledger.insertQuestion(makeQuestion(), 'cart');
  return ledger;
}

test('nextQuestion returns the oldest open question', () => {
  const ledger = withQuestion();
  assert.equal(nextQuestion(ledger)?.id, 'Q-0001');
});

test('answer → new_behavior creates AND confirms in one step (the answer is the approval, I3)', () => {
  const ledger = withQuestion();
  const outcome = answerQuestion(
    ledger,
    'Q-0001',
    'ana',
    { kind: 'new_behavior', statement: 'Only admin and editor can export records', area: 'permissions/records' },
    clock,
  );
  assert.deepEqual(outcome.resultingMutations, ['BHV-0001 created', 'BHV-0001 confirmed']);
  const b = ledger.getBehavior('BHV-0001');
  assert.ok(b?.confirmed_by, 'new behavior is confirmed immediately');
  assert.equal(b?.criticality, 'red', 'export+permissions → guessed red');
  const q = (ledger.allRecords('questions') as Question[])[0];
  assert.equal(q?.status, 'answered');
  assert.equal(q?.answer?.by, 'ana');
  assert.deepEqual(q?.resulting_mutations, ['BHV-0001 created', 'BHV-0001 confirmed']);
});

test('answer → confirm_existing confirms a pending proposal and closes the question', () => {
  const ledger = withQuestion();
  ledger.insertBehavior(proposal('BHV-0001'), 'import'); // unconfirmed
  const outcome = answerQuestion(ledger, 'Q-0001', 'ana', { kind: 'confirm_existing', behaviorId: 'BHV-0001' }, clock);
  assert.deepEqual(outcome.resultingMutations, ['BHV-0001 confirmed']);
  assert.ok(ledger.getBehavior('BHV-0001')?.confirmed_by);
});

test('answer → dismiss closes the question with no behavior (I3: a gap can be a non-promise)', () => {
  const ledger = withQuestion();
  const outcome = answerQuestion(ledger, 'Q-0001', 'ana', { kind: 'dismiss', reason: 'export is out of scope' }, clock);
  assert.deepEqual(outcome.resultingMutations, []);
  const q = (ledger.allRecords('questions') as Question[])[0];
  assert.equal(q?.status, 'dismissed');
  assert.match(q?.answer?.text ?? '', /Dismissed: export is out of scope/);
  assert.equal((ledger.allRecords('behaviors') as Behavior[]).length, 0, 'no behavior invented');
});

test('answering an already-answered question is refused', () => {
  const ledger = withQuestion();
  answerQuestion(ledger, 'Q-0001', 'ana', { kind: 'dismiss' }, clock);
  assert.throws(() => answerQuestion(ledger, 'Q-0001', 'ana', { kind: 'dismiss' }, clock), /not open/);
});
