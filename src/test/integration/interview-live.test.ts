// H6 — the live interview loop: scripted IO exercises every branch
// (y/e/m/d/s/q + invalid merge target) and the immediate-apply semantics
// (a decision is durable the moment it's made; quitting loses nothing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../../db.js';
import { runInterviewLoop, type InterviewIO } from '../../interview-live.js';
import { pendingProposals } from '../../interview.js';
import { fixedClock } from '../../clock.js';
import { tempLedger } from '../helpers/ledger.js';
import { makeProposal, makeBehavior } from '../helpers/factories.js';
import type { Behavior } from '../../types.js';

const clock = fixedClock('2026-06-11T12:00:00Z');

/** A scripted IO: answers are dequeued in order; output is captured. */
function scriptedIO(answers: string[]): InterviewIO & { out: string[] } {
  const queue = [...answers];
  const out: string[] = [];
  return {
    out,
    ask: async (prompt: string) => {
      out.push(prompt);
      return queue.shift() ?? 'q'; // exhausted script ⇒ quit, never hang
    },
    say: (line: string) => out.push(line),
  };
}

function seed(ledger: Ledger, ...proposals: Behavior[]): void {
  for (const p of proposals) ledger.insertBehavior(p, 'bootstrap');
}

test('H6: empty pending set says so and applies nothing', async () => {
  const ledger = tempLedger(clock);
  const io = scriptedIO([]);
  const s = await runInterviewLoop(ledger, io, 'ana', clock);
  assert.deepEqual(s, { confirmed: 0, merged: 0, discarded: 0, skipped: 0, remaining: 0 });
  assert.ok(io.out.some((l) => /no pending proposals/.test(l)));
});

test('H6: y confirms, d discards, s skips — counts and persistence', async () => {
  const ledger = tempLedger(clock);
  seed(ledger,
    makeProposal({ id: 'BHV-0001', statement: 'Alpha behavior holds' }),
    makeProposal({ id: 'BHV-0002', statement: 'Beta behavior holds' }),
    makeProposal({ id: 'BHV-0003', statement: 'Gamma behavior holds' }),
  );
  // y (confirm 1) · d + reason (discard 2) · s (skip 3)
  const io = scriptedIO(['y', 'd', 'not real', 's']);
  const s = await runInterviewLoop(ledger, io, 'ana', clock);
  assert.equal(s.confirmed, 1);
  assert.equal(s.discarded, 1);
  assert.equal(s.skipped, 1);
  assert.equal(s.remaining, 1, 'the skipped one is still pending');

  assert.ok(ledger.getBehavior('BHV-0001')?.confirmed_by, 'confirm persisted');
  assert.equal(ledger.getBehavior('BHV-0002')?.status, 'retired', 'discard persisted');
  assert.equal(ledger.getBehavior('BHV-0003')?.confirmed_by, undefined, 'skip left it untouched');
});

test('H6: e edits the statement then confirms', async () => {
  const ledger = tempLedger(clock);
  seed(ledger, makeProposal({ id: 'BHV-0001', statement: 'orignal typo' }));
  const io = scriptedIO(['e', 'Coupons cannot stack']);
  const s = await runInterviewLoop(ledger, io, 'ana', clock);
  assert.equal(s.confirmed, 1);
  const b = ledger.getBehavior('BHV-0001');
  assert.equal(b?.statement, 'Coupons cannot stack');
  assert.ok(b?.confirmed_by);
});

test('H6: e with empty input keeps the statement as-is', async () => {
  const ledger = tempLedger(clock);
  seed(ledger, makeProposal({ id: 'BHV-0001', statement: 'keep me exactly' }));
  const io = scriptedIO(['e', '   ']); // whitespace ⇒ empty ⇒ keep
  await runInterviewLoop(ledger, io, 'ana', clock);
  assert.equal(ledger.getBehavior('BHV-0001')?.statement, 'keep me exactly');
});

test('H6: m merges into a valid confirmed survivor', async () => {
  const ledger = tempLedger(clock);
  // survivor must be active + confirmed
  ledger.insertBehavior(makeBehavior({ id: 'BHV-0001', statement: 'survivor', confirmed_by: { person: 'ana', at: '2026-06-01T00:00:00Z' } }), 'ana');
  seed(ledger, makeProposal({ id: 'BHV-0002', statement: 'Duplicate behavior' }));
  const io = scriptedIO(['m', 'BHV-0001']);
  const s = await runInterviewLoop(ledger, io, 'ana', clock);
  assert.equal(s.merged, 1);
  assert.equal(ledger.getBehavior('BHV-0002')?.status, 'retired', 'the dup is retired');
});

test('H6: m into an invalid/unconfirmed target is refused and skipped (no mutation)', async () => {
  const ledger = tempLedger(clock);
  // BHV-0001 exists but is UNCONFIRMED → not a valid merge target
  seed(ledger,
    makeProposal({ id: 'BHV-0001', statement: 'also unconfirmed' }),
    makeProposal({ id: 'BHV-0002', statement: 'Duplicate behavior' }),
  );
  const io = scriptedIO(['s', 'm', 'BHV-0001']); // skip 1, try merge 2 into unconfirmed 1
  const s = await runInterviewLoop(ledger, io, 'ana', clock);
  assert.equal(s.merged, 0);
  assert.ok(s.skipped >= 1);
  assert.equal(ledger.getBehavior('BHV-0002')?.status, 'active', 'refused merge left the dup untouched');
  assert.ok(io.out.some((l) => /not a confirmed active behavior/.test(l)));
});

test('H6: q quits mid-way — everything already answered is durable, the rest stays pending', async () => {
  const ledger = tempLedger(clock);
  seed(ledger,
    makeProposal({ id: 'BHV-0001', statement: 'Alpha behavior holds' }),
    makeProposal({ id: 'BHV-0002', statement: 'Beta behavior holds' }),
    makeProposal({ id: 'BHV-0003', statement: 'Gamma behavior holds' }),
  );
  const io = scriptedIO(['y', 'q']); // confirm 1, then quit before 2/3
  const s = await runInterviewLoop(ledger, io, 'ana', clock);
  assert.equal(s.confirmed, 1);
  assert.equal(s.remaining, 2, 'the two unreached proposals are still pending');
  assert.ok(ledger.getBehavior('BHV-0001')?.confirmed_by, 'the pre-quit confirm survived (durable)');
  assert.equal(pendingProposals(ledger).length, 2);
});

test('H6: an unrecognized key is skipped, not applied', async () => {
  const ledger = tempLedger(clock);
  seed(ledger, makeProposal({ id: 'BHV-0001', statement: 'Alpha behavior holds' }));
  const io = scriptedIO(['x']); // not a known choice
  const s = await runInterviewLoop(ledger, io, 'ana', clock);
  assert.equal(s.confirmed, 0);
  assert.equal(s.skipped, 1);
  assert.equal(ledger.getBehavior('BHV-0001')?.confirmed_by, undefined);
});
