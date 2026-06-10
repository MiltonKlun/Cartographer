// CG-0.5 — query API: read-only verbs; per-person aggregation refused (I7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from './db.js';
import { QueryApi, PersonAggregationError, assertNotPersonKey } from './query.js';
import { fixedClock } from './clock.js';
import type { Behavior } from './types.js';

const clock = fixedClock('2026-06-10T12:00:00Z');

function seededApi(): QueryApi {
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), 'cart-test-')), 'ledger.db'), { clock });
  const rows: [string, string, Behavior['criticality']][] = [
    ['Two coupons cannot be applied to one cart', 'checkout/coupons', 'high'],
    ['Coupon applies before tax', 'checkout/coupons', 'normal'],
    ['A viewer-role user cannot bulk-delete records', 'permissions/records', 'red'],
  ];
  rows.forEach(([statement, area, criticality], i) => {
    ledger.insertBehavior(
      {
        id: `BHV-${String(i + 1).padStart(4, '0')}`,
        statement,
        area,
        criticality,
        links: {},
        created_by: 'manual',
        status: 'active',
      },
      'ana',
    );
  });
  return new QueryApi(ledger);
}

test('findBehaviors filters by text and area (prefix match on area)', () => {
  const api = seededApi();
  assert.equal(api.findBehaviors({ text: 'coupon' }).length, 2);
  assert.equal(api.findBehaviors({ area: 'checkout' }).length, 2);
  assert.equal(api.findBehaviors({ area: 'permissions/records' }).length, 1);
  assert.equal(api.findBehaviors().length, 3);
});

test('I7: every person-shaped groupBy key is refused', () => {
  const api = seededApi();
  for (const key of ['person', 'engineer', 'confirmed_by.person', 'answer.by', 'performed_by', 'PERSON']) {
    assert.throws(() => api.countBehaviorsBy(key), PersonAggregationError, key);
  }
});

test('I7: assertNotPersonKey also catches nested person paths', () => {
  assert.throws(() => assertNotPersonKey('confirmed_by.person'), PersonAggregationError);
  assert.doesNotThrow(() => assertNotPersonKey('area'));
});

test('product-level aggregation works (area, criticality)', () => {
  const api = seededApi();
  assert.deepEqual(api.countBehaviorsBy('area'), [
    { key: 'checkout/coupons', count: 2 },
    { key: 'permissions/records', count: 1 },
  ]);
  assert.deepEqual(
    api.countBehaviorsBy('criticality').map((g) => g.key),
    ['high', 'normal', 'red'],
  );
});

test('arbitrary non-person keys are still rejected as unsupported', () => {
  const api = seededApi();
  assert.throws(() => api.countBehaviorsBy('statement'), /unsupported groupBy/);
});
