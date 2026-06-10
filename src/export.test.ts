// CG-0.6 — deterministic export: identical DB state ⇒ byte-identical JSONL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from './db.js';
import { canonicalJson, exportLedger } from './export.js';
import { fixedClock } from './clock.js';
import type { Behavior } from './types.js';

const clock = fixedClock('2026-06-10T12:00:00Z');

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'cart-test-')), 'ledger.db');
}

test('canonicalJson sorts object keys recursively, arrays keep order', () => {
  const a = canonicalJson({ b: 1, a: { d: 4, c: 3 }, list: [{ z: 1, y: 2 }] });
  assert.equal(a, '{"a":{"c":3,"d":4},"b":1,"list":[{"y":2,"z":1}]}');
});

test('export is deterministic: same state, byte-identical output, key order independent of insertion shape', () => {
  const path = tempDbPath();
  const ledger = new Ledger(path, { clock });
  // intentionally scrambled literal key order
  const scrambled = {
    status: 'active',
    created_by: 'manual',
    links: {},
    criticality: 'normal',
    area: 'checkout/coupons',
    statement: 'Two coupons cannot be applied to one cart',
    id: 'BHV-0001',
  } as Behavior;
  ledger.insertBehavior(scrambled, 'ana');
  const first = exportLedger(ledger);
  const second = exportLedger(ledger);
  assert.equal(first, second);
  ledger.close();

  const reopened = new Ledger(path, { clock });
  assert.equal(exportLedger(reopened), first);
  reopened.close();

  const line = first.split('\n')[0] ?? '';
  const keys = Object.keys((JSON.parse(line) as { record: object }).record);
  assert.deepEqual(keys, [...keys].sort(), 'record keys are sorted');
});

test('export includes the mutations log (I11 inspectability)', () => {
  const ledger = new Ledger(tempDbPath(), { clock });
  ledger.insertBehavior(
    {
      id: 'BHV-0001',
      statement: 'Coupon applies before tax',
      area: 'checkout',
      criticality: 'high',
      links: {},
      created_by: 'manual',
      status: 'active',
    },
    'ana',
  );
  const lines = exportLedger(ledger).trimEnd().split('\n');
  assert.equal(lines.length, 2);
  const tables = lines.map((l) => (JSON.parse(l) as { table: string }).table);
  assert.deepEqual(tables, ['behaviors', 'mutations']);
});

test('empty ledger exports to empty output, not a lie', () => {
  const ledger = new Ledger(tempDbPath(), { clock });
  assert.equal(exportLedger(ledger), '');
});
