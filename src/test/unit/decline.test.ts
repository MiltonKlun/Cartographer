// CG-10.1 (I9) — decline detection: recommend raw prompting for one-off /
// no-regression work; use the ledger when there's a regression future.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldDecline } from '../../decline.js';

const declineCases = [
  'write a one-off script to rename these files',
  'quick throwaway spike to try the new API',
  'just trying something in a sandbox',
  'a disposable prototype, delete after the demo',
];

for (const req of declineCases) {
  test(`declines: "${req}"`, () => {
    const v = shouldDecline(req);
    assert.equal(v.decline, true);
    assert.match(v.reason, /cheaper to just prompt|evidence trail/);
  });
}

const keepCases = [
  'add a regression test for the coupon bug we ship Friday',
  'verify the checkout flow before release',
  'this runs in CI every deploy',
  'guard against the auth regression long-term',
];

for (const req of keepCases) {
  test(`uses the ledger: "${req}"`, () => {
    assert.equal(shouldDecline(req).decline, false);
  });
}

test('keep-signals override one-off signals (cheap insurance)', () => {
  // "spike" but also "ship to production" → do not decline
  assert.equal(shouldDecline('a quick spike that we will ship to production').decline, false);
});

test('neutral request defaults to using the ledger', () => {
  assert.equal(shouldDecline('check whether viewers can delete records').decline, false);
});
