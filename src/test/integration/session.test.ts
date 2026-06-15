// CG-8.1/8.2 — ride-along: silent capture until stop (I8); stop drafts
// proposals into the review queue; nothing merges unreviewed (I3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../../db.js';
import { startSession, noteSession, stopSession, draftProposals, openSessionFor, SessionError } from '../../session.js';
import { fixedClock } from '../../clock.js';
import type { Behavior, Question, Session } from '../../types.js';

const clock = fixedClock('2026-06-11T14:00:00Z');

function freshLedger(): Ledger {
  return new Ledger(join(mkdtempSync(join(tmpdir(), 'cart-sess-')), 'ledger.db'), { clock });
}

test('start opens one session; a second start is refused while open', () => {
  const ledger = freshLedger();
  const s = startSession(ledger, 'ana', clock);
  assert.equal(s.status, 'open');
  assert.equal(s.id, 'SES-0001');
  assert.throws(() => startSession(ledger, 'ana', clock), SessionError);
});

test('note appends silently; requires an open session', () => {
  const ledger = freshLedger();
  assert.throws(() => noteSession(ledger, 'ana', { note: 'x' }, clock), SessionError);
  startSession(ledger, 'ana', clock);
  noteSession(ledger, 'ana', { note: 'double-submit creates two carts' }, clock);
  noteSession(ledger, 'ana', { note: 'totals look right otherwise' }, clock);
  const open = openSessionFor(ledger, 'ana');
  assert.equal(open?.observations?.length, 2);
});

test('draftProposals classifies notes into behaviors / tests / questions', () => {
  const session: Session = {
    id: 'SES-0001',
    engineer: 'ana',
    started_at: '2026-06-11T14:00:00Z',
    status: 'open',
    observations: [
      { at: '2026-06-11T14:31:00Z', note: 'double-submit creates two carts', auto: false },
      { at: '2026-06-11T14:45:00Z', note: 'should expired coupons show an error?', auto: false },
      { at: '2026-06-11T14:50:00Z', note: 'the totals panel is clear and readable', auto: false },
    ],
  };
  const p = draftProposals(session);
  assert.equal(p.behaviors.length, 2); // bug-note + neutral-note both yield behaviors
  assert.equal(p.tests.length, 1); // only the bug yields a regression test
  assert.equal(p.questions.length, 1);
  assert.match(p.tests[0] ?? '', /double-submit/);
});

test('stop drafts proposals, queues questions as Q records, moves to in_review (nothing merged, I3)', () => {
  const ledger = freshLedger();
  startSession(ledger, 'ana', clock);
  noteSession(ledger, 'ana', { note: 'double-submit on coupon form creates two carts' }, clock);
  noteSession(ledger, 'ana', { note: 'should expired coupons show a specific error?' }, clock);
  const result = stopSession(ledger, 'ana', clock);

  assert.equal(result.session.status, 'in_review');
  assert.ok(result.session.ended_at);
  assert.equal(result.queuedQuestionIds.length, 1);

  // the question is a real open Q in the review queue
  const questions = ledger.allRecords('questions') as Question[];
  assert.equal(questions.length, 1);
  assert.equal(questions[0]?.status, 'open');
  assert.match(questions[0]?.why_asked ?? '', /exploratory session SES-0001/);

  // NOTHING merged into the map — no behaviors created
  assert.equal((ledger.allRecords('behaviors') as Behavior[]).length, 0);
  // behavior/test proposals are parked as text on the session for review
  assert.ok((result.session.proposals?.behaviors?.length ?? 0) > 0);
});

test('stop without an open session is refused', () => {
  const ledger = freshLedger();
  assert.throws(() => stopSession(ledger, 'ana', clock), SessionError);
});

test('a stopped session lets the engineer start a fresh one', () => {
  const ledger = freshLedger();
  startSession(ledger, 'ana', clock);
  stopSession(ledger, 'ana', clock);
  const second = startSession(ledger, 'ana', clock);
  assert.equal(second.id, 'SES-0002');
});
