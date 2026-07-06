// CG-1.4 — deterministic linking order: annotation → test_id → path overlap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkEvidence, globMatch, type TestRef } from '../../linking.js';
import type { Behavior } from '../../types.js';

function behavior(id: string, extra: Partial<Behavior> = {}): Behavior {
  return {
    id,
    statement: 'A viewer-role user cannot bulk-delete records',
    area: 'permissions/records',
    criticality: 'red',
    links: {},
    created_by: 'manual',
    status: 'active',
    ...extra,
  };
}

const ref = (over: Partial<TestRef> = {}): TestRef => ({
  testId: 'tests/perm.spec.ts::viewer cannot bulk delete',
  title: 'viewer cannot bulk delete',
  annotations: [],
  file: 'tests/perm.spec.ts',
  ...over,
});

test('globMatch: ** crosses directories, * does not', () => {
  assert.equal(globMatch('src/records/**', 'src/records/a/b.ts'), true);
  assert.equal(globMatch('src/*.ts', 'src/roles.ts'), true);
  assert.equal(globMatch('src/*.ts', 'src/auth/roles.ts'), false);
  assert.equal(globMatch('tests/inventory/**', 'tests/inventory/sort.spec.ts'), true);
});

test('@bhv annotation wins, links only to behaviors that exist, high confidence', () => {
  const behaviors = [behavior('BHV-0001')];
  const r = linkEvidence(behaviors, ref({ annotations: ['bhv BHV-0001', 'bhv BHV-9999'] }));
  assert.deepEqual(r, { behavior_ids: ['BHV-0001'], link_confidence: 'high', method: 'annotation' });
});

test('@bhv in the title also counts', () => {
  const r = linkEvidence([behavior('BHV-0001')], ref({ title: 'viewer cannot bulk delete @bhv BHV-0001' }));
  assert.equal(r.method, 'annotation');
});

test('exact test_id match against verified_by, high confidence', () => {
  const b = behavior('BHV-0002', {
    links: { verified_by: [{ test_id: 'tests/perm.spec.ts::viewer cannot bulk delete', confidence: 'high' }] },
  });
  const r = linkEvidence([b], ref());
  assert.deepEqual(r, { behavior_ids: ['BHV-0002'], link_confidence: 'high', method: 'test_id' });
});

test('path overlap with implemented_in globs, medium confidence', () => {
  const b = behavior('BHV-0003', { links: { implemented_in: ['tests/perm.spec.ts'] } });
  const r = linkEvidence([b], ref());
  assert.deepEqual(r, { behavior_ids: ['BHV-0003'], link_confidence: 'medium', method: 'path_overlap' });
});

test('annotation outranks test_id; test_id outranks path overlap', () => {
  const byAnnotation = behavior('BHV-0001');
  const byTestId = behavior('BHV-0002', {
    links: { verified_by: [{ test_id: 'tests/perm.spec.ts::viewer cannot bulk delete', confidence: 'high' }] },
  });
  const withAnnotation = linkEvidence([byAnnotation, byTestId], ref({ annotations: ['bhv BHV-0001'] }));
  assert.deepEqual(withAnnotation.behavior_ids, ['BHV-0001']);
  const withoutAnnotation = linkEvidence([byAnnotation, byTestId], ref());
  assert.deepEqual(withoutAnnotation.behavior_ids, ['BHV-0002']);
});

test('no match → unlinked at low confidence, never a guessed link (I3)', () => {
  const r = linkEvidence([behavior('BHV-0001', { links: { implemented_in: ['src/billing/**'] } })], ref({ file: 'tests/new-feature.spec.ts', testId: 'tests/new-feature.spec.ts::works' }));
  assert.deepEqual(r, { behavior_ids: [], link_confidence: 'low', method: 'none' });
});

// ---- H8: derived title-suffix match (node:test JUnit has no file identity) ----

// node:test's JUnit reporter emits classname="test", so the junit ingestor
// builds testId `test::<title>` — the file half is lost. Bootstrap test_ids
// are `<file>::<title>`, so we match on the shared title half at MEDIUM.
const junitRef = (title: string): TestRef => ({
  testId: `test::${title}`,   // classname="test" + name=title (node:test shape)
  title,
  annotations: [],
  file: '',                    // no file attr from node:test junit
});

test('H8: a node:test junit ref links by title suffix at medium confidence', () => {
  const b = behavior('BHV-0002', {
    links: { verified_by: [{ test_id: 'diff.test.ts::parses numstat lines into added/deleted/path', confidence: 'high' }] },
  });
  const r = linkEvidence([b], junitRef('parses numstat lines into added/deleted/path'));
  assert.deepEqual(r, { behavior_ids: ['BHV-0002'], link_confidence: 'medium', method: 'title_suffix' });
});

test('H8: exact test_id still wins over the derived suffix match', () => {
  const b = behavior('BHV-0002', {
    links: { verified_by: [{ test_id: 'test::viewer cannot bulk delete', confidence: 'high' }] },
  });
  // ref.testId is `test::viewer cannot bulk delete` — an EXACT match here
  const r = linkEvidence([b], junitRef('viewer cannot bulk delete'));
  assert.equal(r.method, 'test_id');
  assert.equal(r.link_confidence, 'high');
});

test('H8: an ambiguous title (same name in two files) is NOT mislinked', () => {
  const b1 = behavior('BHV-0001', { links: { verified_by: [{ test_id: 'a.test.ts::works', confidence: 'high' }] } });
  const b2 = behavior('BHV-0002', { links: { verified_by: [{ test_id: 'b.test.ts::works', confidence: 'high' }] } });
  const r = linkEvidence([b1, b2], junitRef('works'));
  // two candidates share the title → skip the inference, fall through to none
  assert.equal(r.method, 'none');
  assert.deepEqual(r.behavior_ids, []);
});

test('H8: title suffix does not override a path-overlap when it is ambiguous', () => {
  // ambiguous suffix, but one behavior also matches by path → path wins (medium)
  const b1 = behavior('BHV-0001', { links: { verified_by: [{ test_id: 'a.test.ts::works', confidence: 'high' }] } });
  const b2 = behavior('BHV-0002', { links: { verified_by: [{ test_id: 'b.test.ts::works', confidence: 'high' }], implemented_in: ['tests/x/**'] } });
  const r = linkEvidence([b1, b2], { testId: 'test::works', title: 'works', annotations: [], file: 'tests/x/y.spec.ts' });
  assert.equal(r.method, 'path_overlap');
  assert.deepEqual(r.behavior_ids, ['BHV-0002']);
});
