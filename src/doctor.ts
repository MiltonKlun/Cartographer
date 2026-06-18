// `cart doctor` (V4.3) — environment-readiness report for a new adopter.
// Pure check functions over an injected environment so they're testable; the
// CLI wires the real process/fs/git. A failed check is actionable, never a
// silent surprise during the first real command.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { configDir } from './paths.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** ok unless any check failed (warns don't block). */
  ready: boolean;
}

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 13; // node:sqlite stabilized enough for our use

/** Node ≥ 22.13 (the engines floor; node:sqlite is the hard dependency). */
export function checkNode(versions: NodeJS.ProcessVersions = process.versions): DoctorCheck {
  const [major = 0, minor = 0] = versions.node.split('.').map(Number);
  const ok = major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR);
  return {
    name: 'node',
    status: ok ? 'ok' : 'fail',
    detail: ok
      ? `v${versions.node} (≥ ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR})`
      : `v${versions.node} — need ≥ ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} for node:sqlite`,
  };
}

/** node:sqlite must load (the ledger's only hard requirement). */
export function checkSqlite(): DoctorCheck {
  try {
    const req = createRequire(import.meta.url);
    req('node:sqlite');
    return { name: 'node:sqlite', status: 'ok', detail: 'available' };
  } catch (err) {
    return { name: 'node:sqlite', status: 'fail', detail: `unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** git is optional — its absence degrades churn-based decay, not the core. */
export function checkGit(runner: (cmd: string, args: string[]) => { status: number | null; stdout: string } = defaultRun): DoctorCheck {
  const r = runner('git', ['--version']);
  if (r.status === 0) {
    return { name: 'git', status: 'ok', detail: r.stdout.trim() || 'present' };
  }
  return { name: 'git', status: 'warn', detail: 'not found — churn-based decay (cart pr / GitChurnIndex) degrades to zero churn' };
}

/** The vault parent must be writable (evidence ingestion needs it). */
export function checkVaultWritable(vaultRoot: string): DoctorCheck {
  try {
    // probe by creating + removing a temp dir beside where the vault will live
    const dir = mkdtempSync(join(vaultRoot.replace(/[\\/]+vault[\\/]*$/, ''), '.cart-doctor-'));
    const probe = join(dir, 'probe');
    writeFileSync(probe, 'ok');
    rmSync(dir, { recursive: true, force: true });
    return { name: 'vault', status: 'ok', detail: `writable (${vaultRoot})` };
  } catch (err) {
    return { name: 'vault', status: 'fail', detail: `not writable at ${vaultRoot}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** config/decay.json + config/redaction.json must parse. */
export function checkConfig(dir: string = configDir): DoctorCheck {
  const files = ['decay.json', 'redaction.json'];
  const broken: string[] = [];
  for (const f of files) {
    try {
      JSON.parse(readFileSync(join(dir, f), 'utf8'));
    } catch (err) {
      broken.push(`${f} (${err instanceof Error ? err.message.split('\n')[0] : 'unreadable'})`);
    }
  }
  return broken.length === 0
    ? { name: 'config', status: 'ok', detail: 'decay.json + redaction.json valid' }
    : { name: 'config', status: 'fail', detail: `invalid: ${broken.join(', ')}` };
}

function defaultRun(cmd: string, args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
  return { status: r.status, stdout: r.stdout ?? '' };
}

export interface DoctorOptions {
  vaultRoot: string;
  configPath?: string;
}

export function runDoctor(opts: DoctorOptions): DoctorReport {
  const checks = [
    checkNode(),
    checkSqlite(),
    checkGit(),
    checkVaultWritable(opts.vaultRoot),
    checkConfig(opts.configPath),
  ];
  return { checks, ready: checks.every((c) => c.status !== 'fail') };
}

const MARK: Record<CheckStatus, string> = { ok: '✓', warn: '⚠', fail: '✗' };

export function renderDoctor(report: DoctorReport): string {
  const lines = ['cart doctor — environment readiness', ''];
  for (const c of report.checks) lines.push(`  ${MARK[c.status]} ${c.name}: ${c.detail}`);
  lines.push('', report.ready ? 'READY — you can `cart init` and start.' : 'NOT READY — fix the ✗ checks above first.');
  return lines.join('\n');
}
