// CG-4.1 — bootstrap import: discover tests, draft ONE unconfirmed behavior
// per test, area from path, criticality guessed only for red domains (I3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractTests,
  areaFromPath,
  statementFromTitle,
  draftBehaviors,
  discoverTestFiles,
  bootstrapRepo,
} from '../../bootstrap.js';

test('extractTests pulls it()/test() titles and nests describe context', () => {
  const src = `
    describe('coupons', () => {
      it('cannot stack two coupons', () => {});
      test('applies before tax', () => {});
    });
    it('@bhv BHV-0042 already linked', () => {});
  `;
  const tests = extractTests('tests/checkout.spec.ts', src);
  assert.equal(tests.length, 3);
  assert.equal(tests[0]?.title, 'coupons cannot stack two coupons');
  assert.equal(tests[0]?.testId, 'tests/checkout.spec.ts::coupons cannot stack two coupons');
  assert.equal(tests[2]?.existingBhv, 'BHV-0042');
});

test('areaFromPath strips test roots and filename suffixes', () => {
  assert.equal(areaFromPath('tests/checkout/coupons.spec.ts'), 'checkout/coupons');
  assert.equal(areaFromPath('src/auth/__tests__/roles.test.ts'), 'auth/roles');
  assert.equal(areaFromPath('login.spec.ts'), 'login');
});

test('statementFromTitle yields a falsifiable sentence', () => {
  assert.equal(statementFromTitle('should reject expired coupons'), 'Reject expired coupons');
  assert.equal(statementFromTitle('viewer cannot bulk delete'), 'Viewer cannot bulk delete');
});

test('draftBehaviors: one unconfirmed proposal per test, guessed criticality', () => {
  let n = 0;
  const nextId = (): string => `BHV-${String(++n).padStart(4, '0')}`;
  const drafts = draftBehaviors(
    [
      { testId: 'tests/perm.spec.ts::viewer cannot bulk delete', title: 'viewer cannot bulk delete', file: 'tests/perm.spec.ts', existingBhv: null },
      { testId: 'tests/ui.spec.ts::tooltip shows on hover', title: 'tooltip shows on hover', file: 'tests/ui.spec.ts', existingBhv: null },
    ],
    nextId,
  );
  assert.equal(drafts.length, 2);
  // none confirmed — bootstrap never confirms (I3)
  assert.ok(drafts.every((d) => d.behavior.confirmed_by === undefined));
  assert.ok(drafts.every((d) => d.behavior.created_by === 'import'));
  assert.equal(drafts[0]?.behavior.criticality, 'red'); // "delete" → data integrity
  assert.equal(drafts[1]?.behavior.criticality, 'normal');
  assert.equal(drafts[0]?.behavior.links.verified_by?.[0]?.test_id, 'tests/perm.spec.ts::viewer cannot bulk delete');
});

test('end-to-end against a temp repo of test files', () => {
  const repo = mkdtempSync(join(tmpdir(), 'cart-repo-'));
  mkdirSync(join(repo, 'tests', 'checkout'), { recursive: true });
  mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(
    join(repo, 'tests', 'checkout', 'coupons.spec.ts'),
    `describe('coupons', () => { it('cannot stack', () => {}); it('applies before tax', () => {}); });`,
  );
  writeFileSync(join(repo, 'tests', 'login.test.ts'), `test('rejects bad password', () => {});`);
  // must be ignored:
  writeFileSync(join(repo, 'node_modules', 'pkg', 'index.spec.ts'), `it('noise', () => {});`);

  let n = 0;
  const { drafts, filesScanned } = bootstrapRepo(repo, () => `BHV-${String(++n).padStart(4, '0')}`);
  assert.equal(filesScanned, 2, 'node_modules excluded');
  assert.equal(drafts.length, 3);
  const areas = drafts.map((d) => d.behavior.area).sort();
  assert.deepEqual(areas, ['checkout/coupons', 'checkout/coupons', 'login']);
  // login "rejects bad password" → red (auth keyword)
  assert.equal(drafts.find((d) => d.behavior.area === 'login')?.behavior.criticality, 'red');
});

test('discoverTestFiles finds spec and test files, sorted', () => {
  const repo = mkdtempSync(join(tmpdir(), 'cart-repo-'));
  writeFileSync(join(repo, 'a.spec.ts'), `it('x', () => {});`);
  writeFileSync(join(repo, 'b.test.js'), `test('y', () => {});`);
  writeFileSync(join(repo, 'readme.md'), `not a test`);
  assert.deepEqual(discoverTestFiles(repo), ['a.spec.ts', 'b.test.js']);
});
