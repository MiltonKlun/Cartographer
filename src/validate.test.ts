// CG-0.2 — generic AJV validator over schemas/, proven against examples/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { validateRecord, isRecordType } from './validate.js';
import { projectRoot } from './paths.js';
import type { RecordType } from './types.js';

const examplesDir = join(projectRoot, 'examples');

test('every example fixture validates against its schema', () => {
  const files = readdirSync(examplesDir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 5, 'expected fixtures for all five record types');
  for (const file of files) {
    const type = basename(file, '.json').split('.')[0] ?? '';
    assert.ok(isRecordType(type), `${file}: unknown record type`);
    const data: unknown = JSON.parse(readFileSync(join(examplesDir, file), 'utf8'));
    const problems = validateRecord(type as RecordType, data);
    assert.deepEqual(problems, [], `${file} should be valid`);
  }
});

test('behavior with two promises joined by stray fields is rejected (additionalProperties)', () => {
  const data = JSON.parse(readFileSync(join(examplesDir, 'behavior.json'), 'utf8')) as Record<string, unknown>;
  data['coverage'] = 'full';
  assert.ok(validateRecord('behavior', data).length > 0);
});

test('behavior with invalid criticality is rejected', () => {
  const data = JSON.parse(readFileSync(join(examplesDir, 'behavior.json'), 'utf8')) as Record<string, unknown>;
  data['criticality'] = 'urgent';
  assert.ok(validateRecord('behavior', data).length > 0);
});

test('I10: quarantined evidence carrying an artifact blob is rejected', () => {
  const data = JSON.parse(readFileSync(join(examplesDir, 'evidence.json'), 'utf8')) as Record<string, unknown>;
  (data['redaction'] as Record<string, unknown>)['status'] = 'quarantined';
  const problems = validateRecord('evidence', data);
  assert.ok(problems.length > 0, 'quarantined evidence must be metadata-only');
});

test('timestamps must be ISO 8601 UTC', () => {
  const data = JSON.parse(readFileSync(join(examplesDir, 'evidence.json'), 'utf8')) as Record<string, unknown>;
  data['observed_at'] = '08/06/2026 03:12';
  assert.ok(validateRecord('evidence', data).length > 0);
});

test('receipt without a revert path is rejected (I4)', () => {
  const data = JSON.parse(readFileSync(join(examplesDir, 'receipt.json'), 'utf8')) as Record<string, unknown>;
  delete data['revert'];
  assert.ok(validateRecord('receipt', data).length > 0);
});
