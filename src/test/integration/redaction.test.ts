// CG-1.2 — redaction with seeded secrets: scrub rewrites, quarantine drops
// the blob entirely (I10). Secrets never enter the ledger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRedactionRules, redactText, scanBuffer } from '../../redaction.js';

const rules = loadRedactionRules();

test('config/redaction.json loads and all patterns compile', () => {
  assert.ok(rules.length >= 5);
  assert.ok(rules.some((r) => r.action === 'quarantine'));
  assert.ok(rules.some((r) => r.action === 'scrub'));
});

test('scrub: seeded password is replaced, status redacted', () => {
  const r = redactText('request body had password=hunter2secret9 oops', rules);
  assert.equal(r.status, 'redacted');
  assert.ok(!r.text.includes('hunter2secret9'), 'secret must be gone');
  assert.match(r.text, /\[REDACTED:password-assignment\]/);
  assert.ok(r.rules_hit.includes('password-assignment'));
});

test('scrub: bearer token is replaced', () => {
  const r = redactText('Authorization used Bearer eyJhbGciOi.eyJzdWIi.SflKxwRJ here', rules);
  assert.equal(r.status, 'redacted');
  assert.ok(!r.text.includes('SflKxwRJ'));
});

test('quarantine: AWS access key drops the whole blob (I10)', () => {
  const r = redactText('dumped env AKIAIOSFODNN7EXAMPLE region us-east-1', rules);
  assert.equal(r.status, 'quarantined');
  assert.equal(r.text, '', 'quarantined content must not be returned for storage');
  assert.ok(r.rules_hit.includes('aws-access-key'));
});

test('clean text passes through untouched', () => {
  const r = redactText('expected total 9.00 but got 10.00', rules);
  assert.equal(r.status, 'clean');
  assert.equal(r.text, 'expected total 9.00 but got 10.00');
  assert.deepEqual(r.rules_hit, []);
});

test('binary scan: any rule hit quarantines (binaries cannot be scrubbed)', () => {
  const dirty = scanBuffer(Buffer.from('zip-ish bytes password=topsecret123 more bytes'), rules);
  assert.equal(dirty.quarantined, true);
  const clean = scanBuffer(Buffer.from('plain harmless bytes'), rules);
  assert.equal(clean.quarantined, false);
});
