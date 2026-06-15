// CG-1.1 — content-addressed vault: never mutated, dedupe by hash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vaultWrite, vaultRead, vaultList, vaultOrphans, vaultAbsPath, sha256Hex } from '../../vault.js';

function tempVault(): string {
  return join(mkdtempSync(join(tmpdir(), 'cart-vault-')), 'vault');
}

test('write is content-addressed and matches the evidence schema pattern', () => {
  const root = tempVault();
  const ref = vaultWrite(root, 'hello evidence');
  assert.match(ref.vault_path, /^vault\/sha256\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
  assert.equal(ref.sha256, sha256Hex('hello evidence'));
  assert.equal(vaultRead(root, ref.vault_path).toString('utf8'), 'hello evidence');
});

test('identical content twice → same blob, no error, no mutation', () => {
  const root = tempVault();
  const a = vaultWrite(root, 'same bytes');
  const b = vaultWrite(root, 'same bytes');
  assert.equal(a.vault_path, b.vault_path);
  assert.equal(vaultList(root).length, 1);
});

test('different content → different blobs', () => {
  const root = tempVault();
  vaultWrite(root, 'one');
  vaultWrite(root, 'two');
  assert.equal(vaultList(root).length, 2);
});

test('orphan detection: referenced blobs are kept out of the gc set', () => {
  const root = tempVault();
  const kept = vaultWrite(root, 'referenced by EV-0001');
  const orphan = vaultWrite(root, 'nothing references me');
  const orphans = vaultOrphans(root, new Set([kept.vault_path]));
  assert.deepEqual(orphans, [orphan.vault_path]);
  assert.ok(existsSync(vaultAbsPath(root, orphan.vault_path)));
  const blob = readFileSync(vaultAbsPath(root, kept.vault_path), 'utf8');
  assert.equal(blob, 'referenced by EV-0001');
});
