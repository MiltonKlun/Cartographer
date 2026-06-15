// Ledger/clock setup for tests — replaces the tempDbPath()/fixedClock()
// boilerplate that was copy-pasted across 18 test files.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../../db.js';
import { fixedClock, type Clock } from '../../clock.js';
import { loadDecayConfig } from '../../decay.js';
import { NullChurnIndex } from '../../churn.js';
import type { VerdictContext } from '../../decay.js';

/** A canonical fixed clock for deterministic tests. */
export const TEST_NOW = '2026-06-11T12:00:00Z';
export const testClock: Clock = fixedClock(TEST_NOW);

/** A fresh temp-dir path for a ledger db (each test gets its own). */
export function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'cart-test-')), 'ledger.db');
}

/** A fresh temp-dir path for a vault root. */
export function tempVaultPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'cart-vault-')), 'vault');
}

/** A migrated Ledger on a fresh temp db, wired to the given (or test) clock. */
export function tempLedger(clock: Clock = testClock): Ledger {
  return new Ledger(tempDbPath(), { clock });
}

/** A verdict context with no churn, on the given (or test) clock. */
export function testCtx(clock: Clock = testClock): VerdictContext {
  return { config: loadDecayConfig(), churn: new NullChurnIndex(), clock };
}
