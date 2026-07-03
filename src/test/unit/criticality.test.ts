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

// ---- H4.3: word boundaries — short tokens must not prefix-match ----

test('H4.3: "payload" is not money (was red via "pay")', () => {
  const g = guessCriticality('Parses the response payload correctly');
  assert.equal(g.criticality, 'normal', `payload should be normal, matched: ${g.matched}`);
});

test('H4.3: "Taxi" is not money (was red via "tax")', () => {
  const g = guessCriticality('Taxi fare screen renders');
  assert.equal(g.criticality, 'normal', `Taxi should be normal, matched: ${g.matched}`);
});

test('H4.3: real "tax" and "payment" still classify red', () => {
  assert.equal(guessCriticality('Tax is applied at checkout').criticality, 'red');
  assert.equal(guessCriticality('Payment succeeds with a saved card').criticality, 'red');
});

test('H4.3: "author" is not auth (was red via "auth")', () => {
  const g = guessCriticality('The author byline renders on the post');
  assert.equal(g.criticality, 'normal', `author should be normal, matched: ${g.matched}`);
});

test('H4.3: real auth words still classify red', () => {
  assert.equal(guessCriticality('authorization header is validated').criticality, 'red');
  assert.equal(guessCriticality('authentication rejects a bad token').criticality, 'red');
  assert.equal(guessCriticality('auth flow redirects to login').criticality, 'red');
});

test('H4.3: "Cartesian" / "Cartographer" are not the high "cart" flow', () => {
  assert.notEqual(guessCriticality('Cartesian grid renders').criticality, 'high');
  assert.notEqual(guessCriticality('Cartographer maps the coverage').criticality, 'high');
});

test('H4.3: deliberate stems still catch inflections (invoice, subscription)', () => {
  assert.equal(guessCriticality('invoice total is correct').criticality, 'red');
  assert.equal(guessCriticality('subscription renews monthly').criticality, 'red');
});
