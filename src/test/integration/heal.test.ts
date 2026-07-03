// CG-9.2 — selector heal flow (I12): green re-run ⇒ healed with green
// evidence linked in the receipt; red ⇒ auto-revert + demote to PROPOSE;
// forbidden patch ⇒ rejected before anything touches disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ledger } from '../../db.js';
import { AutonomyGateway } from '../../autonomy.js';
import { runHeal, readHealJournal, HEAL_JOURNAL, type HealPorts, type HealProposal } from '../../heal.js';
import { vaultRead, vaultWrite } from '../../vault.js';
import { fixedClock } from '../../clock.js';
import { tempLedger, tempVaultPath } from '../helpers/ledger.js';
import { makeBehavior } from '../helpers/factories.js';
import type { Evidence, Receipt } from '../../types.js';

const clock = fixedClock('2026-06-11T22:00:00Z');

const ORIGINAL = `test('coupon applies before tax', async ({ page }) => {
  await page.locator('#apply').click();
  expect(await page.locator('.total').innerText()).toBe('9.00');
});
`;
const LOCATOR_PATCH = ORIGINAL.replace("page.locator('#apply')", "page.locator('button[data-test=apply]')");
const FORBIDDEN_PATCH = ORIGINAL.replace("toBe('9.00')", "toBe('10.00')");

function setup(): { ledger: Ledger; gateway: AutonomyGateway; vaultRoot: string } {
  const ledger = tempLedger(clock);
  ledger.insertBehavior(
    makeBehavior({ statement: 'Coupon applies before tax', area: 'checkout/coupons' }),
    'ana',
  );
  return { ledger, gateway: new AutonomyGateway(ledger, { clock }), vaultRoot: tempVaultPath() };
}

function proposal(over: Partial<HealProposal> = {}): HealProposal {
  return {
    file: 'tests/checkout.spec.ts',
    behaviorId: 'BHV-0001',
    testId: 'tests/checkout.spec.ts::coupon applies before tax',
    originalSource: ORIGINAL,
    patchedSource: LOCATOR_PATCH,
    ...over,
  };
}

/** Records what was written, so we can prove apply/revert behavior. */
function recordingPorts(passed: boolean): HealPorts & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    applyPatch: (_file, source) => writes.push(source),
    rerun: () => ({ passed, ref: 'run-green-1' }),
  };
}

test('green re-run → healed: green evidence linked in the receipt (I12)', () => {
  const { ledger, gateway, vaultRoot } = setup();
  const ports = recordingPorts(true);
  const outcome = runHeal(ledger, gateway, proposal(), ports, clock, vaultRoot);

  assert.equal(outcome.status, 'healed');
  if (outcome.status !== 'healed') return;

  const evidence = ledger.allRecords('evidence') as Evidence[];
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.id, outcome.evidenceId);
  assert.equal(evidence[0]?.outcome, 'supports');
  assert.deepEqual(evidence[0]?.behavior_ids, ['BHV-0001']);
  assert.equal(evidence[0]?.source.ref, 'run-green-1');

  const receipts = ledger.allRecords('receipts') as Receipt[];
  assert.equal(receipts[0]?.class, 'selector_heal');
  // patch applied once, never reverted
  assert.equal(ports.writes.length, 1);
  assert.equal(ports.writes[0], LOCATOR_PATCH);
});

test('red re-run → reverted + demoted to PROPOSE; no evidence, no receipt (I12)', () => {
  const { ledger, gateway, vaultRoot } = setup();
  const ports = recordingPorts(false);
  const outcome = runHeal(ledger, gateway, proposal(), ports, clock, vaultRoot);

  assert.equal(outcome.status, 'reverted');
  assert.equal(ledger.allRecords('evidence').length, 0, 'no green run ⇒ no evidence (I12)');
  assert.equal(ledger.allRecords('receipts').length, 0, 'no heal ⇒ no ACT receipt');
  // applied, then reverted to the original
  assert.equal(ports.writes.length, 2);
  assert.equal(ports.writes[0], LOCATOR_PATCH);
  assert.equal(ports.writes[1], ORIGINAL);
});

test('forbidden patch → rejected before anything touches disk (I5)', () => {
  const { ledger, gateway, vaultRoot } = setup();
  const ports = recordingPorts(true);
  const outcome = runHeal(ledger, gateway, proposal({ patchedSource: FORBIDDEN_PATCH }), ports, clock, vaultRoot);

  assert.equal(outcome.status, 'rejected');
  if (outcome.status === 'rejected') assert.ok(outcome.violations.length > 0);
  assert.equal(ports.writes.length, 0, 'a refused patch is never applied');
  assert.equal(ledger.allRecords('evidence').length, 0);
});

test('a heal that changes a non-locator line is refused even if the re-run would pass', () => {
  const { ledger, gateway, vaultRoot } = setup();
  const ports = recordingPorts(true);
  const patched = ORIGINAL.replace('.click();', '.dblclick();');
  const outcome = runHeal(ledger, gateway, proposal({ patchedSource: patched }), ports, clock, vaultRoot);
  assert.equal(outcome.status, 'rejected');
  assert.equal(ports.writes.length, 0);
});

// ---- H2: heal integrity — real revert + crash-window journal ----

test('H2.1: a green heal receipt revert points at the vaulted original source', () => {
  const { ledger, gateway, vaultRoot } = setup();
  const outcome = runHeal(ledger, gateway, proposal(), recordingPorts(true), clock, vaultRoot);
  assert.equal(outcome.status, 'healed');

  const receipt = (ledger.allRecords('receipts') as Receipt[])[0];
  assert.ok(receipt, 'a healed receipt exists');
  // the revert names a real vault path
  const m = /vault (vault\/sha256\/[^\s]+)/.exec(receipt.revert);
  assert.ok(m, `revert must cite a vault path, got: ${receipt.revert}`);
  const vaultPath = m[1]!;
  // and that blob is byte-for-byte the ORIGINAL source (not the patched one)
  assert.equal(vaultRead(vaultRoot, vaultPath).toString('utf8'), ORIGINAL);
});

test('H2.2a: a crash during re-run leaves a journal that recovers the original', () => {
  const { ledger, gateway, vaultRoot } = setup();
  const crashingPorts: HealPorts = {
    applyPatch: () => {},
    rerun: () => { throw new Error('runner died mid-heal'); },
  };
  assert.throws(() => runHeal(ledger, gateway, proposal(), crashingPorts, clock, vaultRoot), /runner died/);

  const journal = readHealJournal(vaultRoot);
  assert.ok(journal, 'a crashed heal leaves an in-flight journal');
  assert.equal(journal!.file, 'tests/checkout.spec.ts');
  // the journal's vault path restores the exact original source
  assert.equal(vaultRead(vaultRoot, journal!.vaultPath).toString('utf8'), ORIGINAL);
});

test('H2.2b: a leftover journal blocks the next heal — no patch applied', () => {
  const { ledger, gateway, vaultRoot } = setup();
  // simulate a prior crash: an original vaulted + a journal on disk
  const ref = vaultWrite(vaultRoot, ORIGINAL);
  writeFileSync(join(vaultRoot, HEAL_JOURNAL), JSON.stringify({
    file: 'tests/checkout.spec.ts', testId: 'x', behaviorId: 'BHV-0001', vaultPath: ref.vault_path, startedAt: '2026-06-11T00:00:00Z',
  }), 'utf8');

  const ports = recordingPorts(true);
  const outcome = runHeal(ledger, gateway, proposal(), ports, clock, vaultRoot);
  assert.equal(outcome.status, 'interrupted');
  assert.equal(ports.writes.length, 0, 'a blocked heal never touches disk');
  assert.equal(ledger.allRecords('evidence').length, 0);
});

test('H2.2c: green and reverted heals both leave no journal behind', () => {
  const green = setup();
  runHeal(green.ledger, green.gateway, proposal(), recordingPorts(true), clock, green.vaultRoot);
  assert.equal(existsSync(join(green.vaultRoot, HEAL_JOURNAL)), false, 'green heal cleans its journal');

  const red = setup();
  runHeal(red.ledger, red.gateway, proposal(), recordingPorts(false), clock, red.vaultRoot);
  assert.equal(existsSync(join(red.vaultRoot, HEAL_JOURNAL)), false, 'reverted heal cleans its journal');
});
