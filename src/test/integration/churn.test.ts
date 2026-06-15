// CG-2.2 — GitChurnIndex against a real temporary git repo. The Null/Static
// variants are unit-tested in decay; this pins the only path that actually
// shells out to `git log --numstat` (the integration the decay engine relies
// on for churn-based freshness).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { GitChurnIndex } from '../../churn.js';

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

/** A throwaway repo with deterministic identity and commit dates. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cart-churn-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

function commit(dir: string, relPath: string, body: string, isoDate: string): void {
  const abs = join(dir, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body);
  git(dir, 'add', '-A');
  const env = { ...process.env, GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate };
  const r = spawnSync('git', ['commit', '-q', '-m', `change ${relPath}`], { cwd: dir, encoding: 'utf8', env, windowsHide: true });
  if (r.status !== 0) throw new Error(`commit failed: ${r.stderr}`);
}

test('counts added+deleted lines under matching globs since a date', () => {
  const dir = makeRepo();
  // 3 lines added in src/records, on 2026-06-05
  commit(dir, 'src/records/delete.ts', 'line1\nline2\nline3\n', '2026-06-05T00:00:00');
  // 2 more lines in the same file, on 2026-06-08 (rewrite: +2/-0 net vs nothing... use append)
  commit(dir, 'src/records/delete.ts', 'line1\nline2\nline3\nline4\nline5\n', '2026-06-08T00:00:00');
  // a file outside the glob
  commit(dir, 'docs/readme.md', 'unrelated\n', '2026-06-08T00:00:00');

  const idx = new GitChurnIndex(dir);
  // since 2026-06-07 → only the second src/records commit counts (2 added lines)
  const recent = idx.linesChangedSince(['src/records/**'], '2026-06-07T00:00:00Z');
  assert.equal(recent, 2, 'only the post-cutoff change under the glob counts');

  // since 2026-06-01 → both src/records commits (3 + 2 = 5 lines)
  const all = idx.linesChangedSince(['src/records/**'], '2026-06-01T00:00:00Z');
  assert.equal(all, 5);
});

test('a glob matching nothing yields zero churn', () => {
  const dir = makeRepo();
  commit(dir, 'src/a.ts', 'x\n', '2026-06-05T00:00:00');
  const idx = new GitChurnIndex(dir);
  assert.equal(idx.linesChangedSince(['src/billing/**'], '2026-06-01T00:00:00Z'), 0);
});

test('empty glob list is zero (no work to attribute)', () => {
  const dir = makeRepo();
  commit(dir, 'src/a.ts', 'x\n', '2026-06-05T00:00:00');
  assert.equal(new GitChurnIndex(dir).linesChangedSince([], '2026-06-01T00:00:00Z'), 0);
});

test('results are cached per since-date (second query does not re-shell incorrectly)', () => {
  const dir = makeRepo();
  commit(dir, 'src/a.ts', 'a\nb\n', '2026-06-05T00:00:00');
  const idx = new GitChurnIndex(dir);
  const first = idx.linesChangedSince(['src/**'], '2026-06-01T00:00:00Z');
  const second = idx.linesChangedSince(['src/**'], '2026-06-01T00:00:00Z');
  assert.equal(first, second);
  assert.equal(first, 2);
});

test('throws on a non-repo directory (degradation is the caller’s choice)', () => {
  const notRepo = mkdtempSync(join(tmpdir(), 'cart-norepo-'));
  const idx = new GitChurnIndex(notRepo);
  assert.throws(() => idx.linesChangedSince(['src/**'], '2026-06-01T00:00:00Z'), /git log/);
});
