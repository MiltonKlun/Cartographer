// V4.3 — cart doctor: environment-readiness checks. Pure functions over an
// injected environment, so each check is exercised in both directions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkNode, checkSqlite, checkGit, checkVaultWritable, checkConfig, runDoctor, renderDoctor } from '../../doctor.js';

test('checkNode passes on a supported version, fails on an old one', () => {
  assert.equal(checkNode({ node: '22.19.0' } as NodeJS.ProcessVersions).status, 'ok');
  assert.equal(checkNode({ node: '22.13.0' } as NodeJS.ProcessVersions).status, 'ok');
  assert.equal(checkNode({ node: '20.10.0' } as NodeJS.ProcessVersions).status, 'fail');
  assert.equal(checkNode({ node: '22.12.0' } as NodeJS.ProcessVersions).status, 'fail');
});

test('checkSqlite reports node:sqlite availability (ok on Node 22)', () => {
  // we run on Node 22 with node:sqlite, so this should be ok here
  assert.equal(checkSqlite().status, 'ok');
});

test('checkGit: present → ok, absent → warn (not fail — git is optional)', () => {
  const present = checkGit(() => ({ status: 0, stdout: 'git version 2.51.0' }));
  assert.equal(present.status, 'ok');
  assert.match(present.detail, /2\.51/);

  const absent = checkGit(() => ({ status: 127, stdout: '' }));
  assert.equal(absent.status, 'warn'); // optional dependency — degrades, not blocks
  assert.match(absent.detail, /churn/);
});

test('checkVaultWritable: ok in a temp dir, fail on a bogus path', () => {
  const good = checkVaultWritable(join(mkdtempSync(join(tmpdir(), 'cart-doc-')), 'vault'));
  assert.equal(good.status, 'ok');

  const bad = checkVaultWritable('/this/path/does/not/exist/vault');
  assert.equal(bad.status, 'fail');
});

test('checkConfig: ok on the real config dir, fail on a dir with bad json', () => {
  assert.equal(checkConfig().status, 'ok'); // the repo's real config/

  const dir = mkdtempSync(join(tmpdir(), 'cart-cfg-'));
  // no decay.json/redaction.json present → unreadable → fail
  assert.equal(checkConfig(dir).status, 'fail');
});

test('runDoctor is ready only when no check failed; renders a report', () => {
  const report = runDoctor({ vaultRoot: join(mkdtempSync(join(tmpdir(), 'cart-doc-')), 'vault') });
  // node + sqlite + config ok here; git may warn; vault ok → ready
  assert.equal(report.ready, true);
  const out = renderDoctor(report);
  assert.match(out, /cart doctor — environment readiness/);
  assert.match(out, /READY/);
});
