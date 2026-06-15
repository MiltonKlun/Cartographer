// CG-9.1 — the one-source-of-truth guardrail (SPEC §10, I5). The same
// patchViolations function the gateway runs is exercised here directly.
// Forbidden edits must be REJECTED; legitimate locator heals must pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patchViolations } from '../../guardrails.js';

const SUITE = `
import { test, expect } from '@playwright/test';

test('viewer cannot bulk delete', async ({ page }) => {
  await page.locator('#apply').click();
  expect(await page.locator('.total').innerText()).toBe('9.00');
});

test('coupon applies before tax', async ({ page }) => {
  await page.getByRole('button', { name: 'Apply' }).click();
  expect(result.status).toEqual(200);
});
`;

// ---- legitimate locator heals pass ----

test('locator-string heal on page.locator passes (general + selector_heal)', () => {
  const patched = SUITE.replace("page.locator('#apply')", "page.locator('button[name=apply]')");
  assert.deepEqual(patchViolations(SUITE, patched), []);
  assert.deepEqual(patchViolations(SUITE, patched, { mode: 'selector_heal' }), []);
});

test('getByRole locator-string change passes selector_heal', () => {
  const patched = SUITE.replace("name: 'Apply'", "name: 'Apply coupon'");
  assert.deepEqual(patchViolations(SUITE, patched, { mode: 'selector_heal' }), []);
});

test('an identical patch is a no-op (no violations)', () => {
  assert.deepEqual(patchViolations(SUITE, SUITE, { mode: 'selector_heal' }), []);
});

// ---- the NEVER list: forbidden edits are rejected ----

test('test deletion is rejected', () => {
  const patched = SUITE.replace(/test\('coupon applies before tax'[\s\S]*?\}\);\n/, '');
  const v = patchViolations(SUITE, patched);
  assert.ok(v.some((x) => x.kind === 'test_deletion'), JSON.stringify(v));
});

test('.skip introduced is rejected', () => {
  // build the forbidden token at runtime so the literal does not appear here
  const skip = `test.${'skip'}('coupon applies before tax'`;
  const patched = SUITE.replace("test('coupon applies before tax'", skip);
  assert.ok(patchViolations(SUITE, patched).some((x) => x.kind === 'skip_introduced'));
});

test('.only introduced is rejected', () => {
  const only = `test.${'only'}('viewer cannot bulk delete'`;
  const patched = SUITE.replace("test('viewer cannot bulk delete'", only);
  assert.ok(patchViolations(SUITE, patched).some((x) => x.kind === 'only_introduced'));
});

test('assertion weakening (toBe → toBeTruthy) is rejected', () => {
  const patched = SUITE.replace("toBe('9.00')", 'toBeTruthy()');
  assert.ok(patchViolations(SUITE, patched).some((x) => x.kind === 'assertion_weakened'));
});

test('expected-value change is rejected', () => {
  const patched = SUITE.replace("toBe('9.00')", "toBe('10.00')");
  assert.ok(patchViolations(SUITE, patched).some((x) => x.kind === 'expected_value_changed'));
});

test('numeric expected-value change is rejected', () => {
  const patched = SUITE.replace('toEqual(200)', 'toEqual(500)');
  assert.ok(patchViolations(SUITE, patched).some((x) => x.kind === 'expected_value_changed'));
});

test('snapshot introduction is rejected', () => {
  const patched = SUITE.replace("toBe('9.00')", 'toMatchSnapshot()');
  const v = patchViolations(SUITE, patched);
  assert.ok(v.some((x) => x.kind === 'snapshot_introduced' || x.kind === 'assertion_weakened'));
});

// ---- selector_heal mode: any non-locator change is a violation ----

test('selector_heal rejects a change outside a locator call', () => {
  const patched = SUITE.replace('toEqual(200)', 'toEqual(201)');
  const v = patchViolations(SUITE, patched, { mode: 'selector_heal' });
  assert.ok(v.some((x) => x.kind === 'non_locator_change' || x.kind === 'expected_value_changed'));
});

test('selector_heal rejects changing code structure even on a locator line', () => {
  // adds a .click() chain change, not just the locator string
  const patched = SUITE.replace("page.locator('#apply').click();", "page.locator('#apply').dblclick();");
  const v = patchViolations(SUITE, patched, { mode: 'selector_heal' });
  assert.ok(v.some((x) => x.kind === 'non_locator_change'), JSON.stringify(v));
});

test('general mode allows non-locator edits that are otherwise safe', () => {
  // adding a brand-new test is fine in general mode (test count goes up)
  const patched = SUITE + "\ntest('new case', async ({ page }) => { expect(1).toBe(1); });\n";
  assert.deepEqual(patchViolations(SUITE, patched), []);
});
