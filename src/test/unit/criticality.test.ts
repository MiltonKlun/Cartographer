// CG-4.3 — red-domain criticality guesser. Guesses are proposals only;
// `red` reserved for money/permissions/security/compliance/data-integrity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessCriticality } from '../../criticality.js';

const redCases: [string, string][] = [
  ['viewer cannot bulk-delete records', 'permissions/records'],
  ['payment is charged once per order', 'checkout/payment'],
  ['coupon applies before tax', 'checkout/coupons'],
  ['admin role can access the dashboard', 'auth/roles'],
  ['passwords are stored encrypted', 'security'],
  ['GDPR consent is recorded', 'compliance'],
  ['data migration preserves all rows', 'data/migration'],
];

for (const [statement, area] of redCases) {
  test(`red domain: "${statement}"`, () => {
    const g = guessCriticality(`${statement} ${area}`);
    assert.equal(g.criticality, 'red', `expected red, got ${g.criticality} (matched ${g.matched})`);
    assert.ok(g.matched, 'a red guess must name the keyword that triggered it');
  });
}

test('high domain: checkout/order/export flows without red keywords', () => {
  assert.equal(guessCriticality('order summary lists all items').criticality, 'high');
  assert.equal(guessCriticality('user can publish an article').criticality, 'high');
});

test('normal default: no domain keyword', () => {
  const g = guessCriticality('tooltip appears on hover over the help icon');
  assert.equal(g.criticality, 'normal');
  assert.equal(g.matched, null);
});

test('guess is deterministic and case-insensitive', () => {
  assert.deepEqual(guessCriticality('PAYMENT fails'), guessCriticality('payment fails'));
});
