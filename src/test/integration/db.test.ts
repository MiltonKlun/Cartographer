// CG-0.3 — ledger storage: migrations, append-only mutations log (I11),
// SQL-level immutability of evidence/receipts, validation at the boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ledger } from '../../db.js';
import { fixedClock } from '../../clock.js';
import { SchemaError } from '../../validate.js';
import { projectRoot } from '../../paths.js';
import { tempDbPath } from '../helpers/ledger.js';
import { makeProposal } from '../helpers/factories.js';
import type { Behavior, Evidence } from '../../types.js';

const clock = fixedClock('2026-06-10T12:00:00Z');

// an unconfirmed proposal with a numbered id (these tests don't need confirmation)
function makeBehavior(n: number): Behavior {
  return makeProposal({ id: `BHV-${String(n).padStart(4, '0')}`, created_by: 'manual' });
}

function exampleEvidence(): Evidence {
  return JSON.parse(readFileSync(join(projectRoot, 'examples', 'evidence.json'), 'utf8')) as Evidence;
}

test('migrations apply once and are recorded; reopening is idempotent', () => {
  const path = tempDbPath();
  const first = new Ledger(path, { clock });
  first.close();
  const second = new Ledger(path, { clock });
  assert.equal(second.allRecords('behaviors').length, 0);
  second.close();
});

test('insert validates at the boundary: invalid behavior is refused', () => {
  const ledger = new Ledger(tempDbPath(), { clock });
  const bad = { ...makeBehavior(1), criticality: 'urgent' } as unknown as Behavior;
  assert.throws(() => ledger.insertBehavior(bad, 'ana'), SchemaError);
  assert.equal(ledger.allRecords('behaviors').length, 0);
  assert.equal(ledger.allMutations().length, 0);
});

test('I11: every insert logs a mutation with actor, time, table, id and diff', () => {
  const ledger = new Ledger(tempDbPath(), { clock });
  ledger.insertBehavior(makeBehavior(1), 'ana');
  const mutations = ledger.allMutations();
  assert.equal(mutations.length, 1);
  const m = mutations[0];
  assert.equal(m?.actor, 'ana');
  assert.equal(m?.at, '2026-06-10T12:00:00Z');
  assert.equal(m?.tbl, 'behaviors');
  assert.equal(m?.record_id, 'BHV-0001');
  assert.deepEqual(JSON.parse(m?.diff ?? '{}'), { new: makeBehavior(1) });
});

test('I11: updates log an old/new diff', () => {
  const ledger = new Ledger(tempDbPath(), { clock });
  ledger.insertBehavior(makeBehavior(1), 'ana');
  ledger.updateBehavior('BHV-0001', (b) => ({ ...b, status: 'retired' }), 'ana');
  const diff = JSON.parse(ledger.allMutations()[1]?.diff ?? '{}') as { old: Behavior; new: Behavior };
  assert.equal(diff.old.status, 'active');
  assert.equal(diff.new.status, 'retired');
});

test('I11: the mutations log is append-only at the SQL level', () => {
  const ledger = new Ledger(tempDbPath(), { clock });
  ledger.insertBehavior(makeBehavior(1), 'ana');
  assert.throws(() => ledger.rawExec("UPDATE mutations SET actor = 'mallory'"), /append-only/);
  assert.throws(() => ledger.rawExec('DELETE FROM mutations'), /append-only/);
});

test('I11: row-level triggers — DELETE on an EMPTY mutations table is a no-op (zero rows, zero firings)', () => {
  // documents the audit edge case: probing an empty table sees DELETE
  // "succeed" because nothing is deleted. The guarantee is per committed row.
  const ledger = new Ledger(tempDbPath(), { clock });
  assert.doesNotThrow(() => ledger.rawExec('DELETE FROM mutations')); // empty ⇒ no firing
  ledger.insertBehavior(makeBehavior(1), 'ana'); // now a row exists
  assert.throws(() => ledger.rawExec('DELETE FROM mutations'), /append-only/);
});

test('evidence is immutable at the SQL level (corrections supersede)', () => {
  const ledger = new Ledger(tempDbPath(), { clock });
  ledger.insertEvidence(exampleEvidence(), 'ingest:test');
  assert.throws(() => ledger.rawExec("UPDATE evidence SET outcome = 'supports'"), /immutable/);
  assert.throws(() => ledger.rawExec('DELETE FROM evidence'), /immutable/);
});

test('I11: behaviors cannot be deleted, only retired', () => {
  const ledger = new Ledger(tempDbPath(), { clock });
  ledger.insertBehavior(makeBehavior(1), 'ana');
  assert.throws(() => ledger.rawExec('DELETE FROM behaviors'), /retire/);
  const retired = ledger.updateBehavior('BHV-0001', (b) => ({ ...b, status: 'retired' }), 'ana');
  assert.equal(retired.status, 'retired');
});

test('nextId zero-pads and increments per record type', () => {
  const ledger = new Ledger(tempDbPath(), { clock });
  assert.equal(ledger.nextId('behavior'), 'BHV-0001');
  ledger.insertBehavior(makeBehavior(1), 'ana');
  assert.equal(ledger.nextId('behavior'), 'BHV-0002');
  assert.equal(ledger.nextId('evidence'), 'EV-0001');
});

test('verdict snapshots are append-only and diffable (migration 4)', () => {
  const ledger = new Ledger(tempDbPath(), { clock });
  ledger.writeVerdictSnapshot('2026-06-10T08:00:00Z', [{ behavior_id: 'BHV-0001', state: 'VERIFIED', freshness: 0.9 }]);
  ledger.writeVerdictSnapshot('2026-06-11T08:00:00Z', [{ behavior_id: 'BHV-0001', state: 'STALE', freshness: 0.3 }]);
  assert.equal(ledger.previousSnapshotAt('2026-06-11T08:00:00Z'), '2026-06-10T08:00:00Z');
  assert.equal(ledger.verdictSnapshot('2026-06-10T08:00:00Z').get('BHV-0001')?.state, 'VERIFIED');
  assert.throws(() => ledger.rawExec("UPDATE verdict_snapshots SET state = 'VIOLATED'"), /append-only/);
});
