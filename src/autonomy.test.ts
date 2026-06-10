// CG-0.5 — the autonomy gateway: tiers by consequence (I4), NEVER list has
// no code path (I5), receipts written in the same transaction as the action.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from './db.js';
import { AutonomyGateway, NeverTierError, NEVER_CLASSES, type ActionRequest } from './autonomy.js';
import { fixedClock } from './clock.js';
import type { Receipt } from './types.js';

const clock = fixedClock('2026-06-10T12:00:00Z');

function tempLedger(): Ledger {
  const dir = mkdtempSync(join(tmpdir(), 'cart-test-'));
  return new Ledger(join(dir, 'ledger.db'), { clock });
}

function request(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    class: 'export',
    target: 'export/ledger.jsonl',
    summary: 'test action',
    evidence_basis: [],
    revert: 'delete the file',
    execute: () => {},
    ...overrides,
  };
}

test('I5: every NEVER class is refused with no dispatch path', () => {
  const gateway = new AutonomyGateway(tempLedger(), { clock });
  for (const cls of NEVER_CLASSES) {
    assert.equal(gateway.tierOf(cls), 'NEVER');
    assert.throws(
      () => gateway.perform(request({ class: cls as unknown as ActionRequest['class'] })),
      NeverTierError,
      cls,
    );
  }
});

test('I5: NEVER cannot be loosened by configuration', () => {
  assert.throws(
    () =>
      new AutonomyGateway(tempLedger(), {
        clock,
        overrides: { delete_test: 'ACT' } as unknown as Record<string, never>,
      }),
    NeverTierError,
  );
});

test('I4: unknown action classes are not dispatched', () => {
  const gateway = new AutonomyGateway(tempLedger(), { clock });
  assert.throws(() => gateway.perform(request({ class: 'reboot_prod' as ActionRequest['class'] })), /unknown action class/);
});

test('ACT runs the action and writes the receipt in the same transaction', () => {
  const ledger = tempLedger();
  const gateway = new AutonomyGateway(ledger, { clock });
  let executed = false;
  const result = gateway.perform(request({ execute: () => { executed = true; } }));
  assert.equal(executed, true);
  assert.equal(result.tier, 'ACT');
  const receipts = ledger.allRecords('receipts') as Receipt[];
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.class, 'export');
  assert.equal(receipts[0]?.performed_at, '2026-06-10T12:00:00Z');
  // the receipt write itself is in the mutations log (I11)
  assert.ok(ledger.allMutations().some((m) => m.tbl === 'receipts'));
});

test('a failing ACT action leaves no receipt behind (rollback)', () => {
  const ledger = tempLedger();
  const gateway = new AutonomyGateway(ledger, { clock });
  assert.throws(() =>
    gateway.perform(request({ execute: () => { throw new Error('side effect failed'); } })),
  );
  assert.equal(ledger.allRecords('receipts').length, 0);
  assert.equal(ledger.allMutations().length, 0);
});

test('PROPOSE returns the draft and does NOT execute', () => {
  const gateway = new AutonomyGateway(tempLedger(), { clock });
  let executed = false;
  const result = gateway.perform(
    request({ class: 'behavior_statement', execute: () => { executed = true; } }),
  );
  assert.equal(result.tier, 'PROPOSE');
  assert.equal(executed, false);
  if (result.tier === 'PROPOSE') {
    assert.equal(result.draft.target, 'export/ledger.jsonl');
    assert.ok(!('execute' in result.draft));
  }
});

test('I4: overrides may move toward caution (ACT → PROPOSE)', () => {
  const gateway = new AutonomyGateway(tempLedger(), { clock, overrides: { selector_heal: 'PROPOSE' } });
  assert.equal(gateway.tierOf('selector_heal'), 'PROPOSE');
});

test('I4: overrides may NOT loosen PROPOSE → ACT (except pr_comment opt-in)', () => {
  assert.throws(
    () => new AutonomyGateway(tempLedger(), { clock, overrides: { behavior_statement: 'ACT' } }),
    /toward caution/,
  );
  const gateway = new AutonomyGateway(tempLedger(), { clock, overrides: { pr_comment: 'ACT' } });
  assert.equal(gateway.tierOf('pr_comment'), 'ACT');
});
