// CG-6.2/6.3 — quarantine lane: entries route to a non-blocking lane, never
// edit test source (I5); 7-day default expiry; expired entries escalate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEntry,
  upsertEntry,
  removeEntry,
  expiredEntries,
  isQuarantined,
  loadQuarantine,
  writeQuarantine,
  DEFAULT_EXPIRY_DAYS,
  type QuarantineFile,
} from './quarantine.js';
import { fixedClock } from './clock.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const clock = fixedClock('2026-06-11T00:00:00Z');
const empty: QuarantineFile = { version: 1, entries: [] };

test('buildEntry defaults to a 7-day expiry', () => {
  const e = buildEntry({ testId: 'tests/login.spec.ts::flaky', ticket: 'JIRA-99' }, clock);
  assert.equal(e.entered_at, '2026-06-11T00:00:00Z');
  assert.equal(e.expires_at, '2026-06-18T00:00:00Z');
  assert.equal(DEFAULT_EXPIRY_DAYS, 7);
});

test('custom expiry days honored', () => {
  const e = buildEntry({ testId: 't::x', ticket: 'K-1', expiryDays: 3 }, clock);
  assert.equal(e.expires_at, '2026-06-14T00:00:00Z');
});

test('upsert adds then replaces by test_id', () => {
  const e1 = buildEntry({ testId: 't::x', ticket: 'K-1' }, clock);
  const added = upsertEntry(empty, e1);
  assert.equal(added.replaced, false);
  assert.equal(added.file.entries.length, 1);

  const e2 = buildEntry({ testId: 't::x', ticket: 'K-2' }, clock);
  const replaced = upsertEntry(added.file, e2);
  assert.equal(replaced.replaced, true);
  assert.equal(replaced.file.entries.length, 1);
  assert.equal(replaced.file.entries[0]?.ticket, 'K-2');
});

test('isQuarantined is true before expiry, false after (CI lane check)', () => {
  const { file } = upsertEntry(empty, buildEntry({ testId: 't::x', ticket: 'K-1' }, clock));
  assert.equal(isQuarantined(file, 't::x', fixedClock('2026-06-15T00:00:00Z')), true);
  assert.equal(isQuarantined(file, 't::x', fixedClock('2026-06-20T00:00:00Z')), false);
  assert.equal(isQuarantined(file, 'other::y', clock), false);
});

test('expiredEntries surfaces the lapsed ones (CG-6.3 escalation)', () => {
  let file = empty;
  file = upsertEntry(file, buildEntry({ testId: 'a::1', ticket: 'K-1', expiryDays: 1 }, clock)).file;
  file = upsertEntry(file, buildEntry({ testId: 'b::2', ticket: 'K-2', expiryDays: 30 }, clock)).file;
  const expired = expiredEntries(file, fixedClock('2026-06-13T00:00:00Z'));
  assert.deepEqual(expired.map((e) => e.test_id), ['a::1']);
});

test('removeEntry drops by test_id', () => {
  const { file } = upsertEntry(empty, buildEntry({ testId: 't::x', ticket: 'K-1' }, clock));
  const { file: after, removed } = removeEntry(file, 't::x');
  assert.equal(removed, true);
  assert.equal(after.entries.length, 0);
  assert.equal(removeEntry(after, 't::x').removed, false);
});

test('round-trips to disk with stable key order, no test source touched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cart-q-'));
  const path = join(dir, 'quarantine.json');
  let file = empty;
  file = upsertEntry(file, buildEntry({ testId: 'z::last', ticket: 'K-2' }, clock)).file;
  file = upsertEntry(file, buildEntry({ testId: 'a::first', ticket: 'K-1' }, clock)).file;
  writeQuarantine(path, file);
  const reloaded = loadQuarantine(path);
  // sorted by test_id on write
  assert.deepEqual(reloaded.entries.map((e) => e.test_id), ['a::first', 'z::last']);
});

test('loadQuarantine returns an empty lane when the file is absent', () => {
  const lane = loadQuarantine(join(mkdtempSync(join(tmpdir(), 'cart-q-')), 'nope.json'));
  assert.deepEqual(lane, { version: 1, entries: [] });
});
