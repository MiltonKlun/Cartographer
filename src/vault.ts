// The evidence vault: content-addressed blobs under vault/sha256/<2>/<hash>.
// Blobs are never mutated — writing identical content is a no-op, and the
// only deletion path is `cart vault gc` through the autonomy gateway with a
// receipt (SPEC §5).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface VaultRef {
  /** Ledger-relative path, forward slashes — matches the evidence schema. */
  vault_path: string;
  sha256: string;
}

export function sha256Hex(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function absPathOf(vaultRoot: string, hash: string): string {
  return join(vaultRoot, 'sha256', hash.slice(0, 2), hash);
}

/** Content-addressed write. Existing blobs are left untouched (immutable). */
export function vaultWrite(vaultRoot: string, content: Buffer | string): VaultRef {
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const hash = sha256Hex(buf);
  const abs = absPathOf(vaultRoot, hash);
  if (!existsSync(abs)) {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, buf, { flag: 'wx' });
  }
  return { vault_path: `vault/sha256/${hash.slice(0, 2)}/${hash}`, sha256: hash };
}

export function vaultRead(vaultRoot: string, vaultPath: string): Buffer {
  const hash = vaultPath.split('/').at(-1) ?? '';
  return readFileSync(absPathOf(vaultRoot, hash));
}

/** All blob paths currently in the vault (ledger-relative form). */
export function vaultList(vaultRoot: string): string[] {
  const base = join(vaultRoot, 'sha256');
  if (!existsSync(base)) return [];
  const out: string[] = [];
  for (const shard of readdirSync(base)) {
    for (const hash of readdirSync(join(base, shard))) {
      out.push(`vault/sha256/${shard}/${hash}`);
    }
  }
  return out.sort();
}

/** Blobs not referenced by any evidence record — gc candidates. */
export function vaultOrphans(vaultRoot: string, referencedPaths: Set<string>): string[] {
  return vaultList(vaultRoot).filter((p) => !referencedPaths.has(p));
}

export function vaultAbsPath(vaultRoot: string, vaultPath: string): string {
  const hash = vaultPath.split('/').at(-1) ?? '';
  return absPathOf(vaultRoot, hash);
}
