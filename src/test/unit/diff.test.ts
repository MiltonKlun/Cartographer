// CG-5.1 — diff parsing: numstat lines, binary files, new-file detection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNumstat, diffFromText } from '../../diff.js';

test('parses numstat lines into added/deleted/path', () => {
  const d = parseNumstat('182\t40\tsrc/records/delete.ts\n12\t3\tsrc/auth/roles.ts');
  assert.equal(d.files.length, 2);
  assert.deepEqual(d.files[0], { path: 'src/records/delete.ts', added: 182, deleted: 40, isNew: false });
  assert.equal(d.totalAdded, 194);
  assert.equal(d.totalDeleted, 43);
});

test('binary files (- / -) count as zero lines', () => {
  const d = parseNumstat('-\t-\tassets/logo.png');
  assert.deepEqual(d.files[0], { path: 'assets/logo.png', added: 0, deleted: 0, isNew: false });
});

test('create mode lines mark new files', () => {
  const d = parseNumstat('60\t0\tsrc/records/export.ts\n create mode 100644 src/records/export.ts');
  assert.equal(d.files[0]?.isNew, true);
});

test('a modified file is not new even with zero deletions', () => {
  const d = parseNumstat('5\t0\tsrc/existing.ts');
  assert.equal(d.files[0]?.isNew, false);
});

test('windows backslash paths normalize to forward slashes', () => {
  const d = diffFromText('1\t1\tsrc\\records\\x.ts');
  assert.equal(d.files[0]?.path, 'src/records/x.ts');
});

test('ignores non-numstat noise lines', () => {
  const d = parseNumstat('diff --git a/x b/x\n10\t2\tx.ts\nindex abc..def');
  assert.equal(d.files.length, 1);
});
