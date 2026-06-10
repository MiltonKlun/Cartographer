// CG-1.3 — end-to-end ingestion: real report fixtures become evidence,
// redacted, linked, receipted, and idempotent on re-ingest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from './db.js';
import { AutonomyGateway } from './autonomy.js';
import { ingestCandidates } from './ingest.js';
import { parsePlaywrightReport, PLAYWRIGHT_INGESTOR } from './ingest-playwright.js';
import { parseJunitReport, parseJunitXml } from './ingest-junit.js';
import { loadRedactionRules } from './redaction.js';
import { vaultRead } from './vault.js';
import { fixedClock } from './clock.js';
import { projectRoot } from './paths.js';
import type { Behavior, Evidence, Receipt } from './types.js';

const clock = fixedClock('2026-06-10T12:00:00Z');
const rules = loadRedactionRules();
const pwReport = join(projectRoot, 'testdata', 'playwright-report.json');
const junitReport = join(projectRoot, 'testdata', 'junit-report.xml');

function setup(): { ledger: Ledger; gateway: AutonomyGateway; vaultRoot: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cart-ingest-'));
  const ledger = new Ledger(join(dir, 'ledger.db'), { clock });
  const behaviors: Behavior[] = [
    {
      id: 'BHV-0001',
      statement: 'A viewer-role user cannot bulk-delete records',
      area: 'permissions/records',
      criticality: 'red',
      links: {},
      created_by: 'manual',
      status: 'active',
    },
    {
      id: 'BHV-0002',
      statement: 'Coupon applies before tax',
      area: 'checkout/coupons',
      criticality: 'high',
      links: { verified_by: [{ test_id: 'tests/checkout.spec.ts::coupon applies before tax', confidence: 'high' }] },
      created_by: 'manual',
      status: 'active',
    },
  ];
  for (const b of behaviors) ledger.insertBehavior(b, 'ana');
  return { ledger, gateway: new AutonomyGateway(ledger, { clock }), vaultRoot: join(dir, 'vault') };
}

test('playwright report → evidence: linked, scrubbed, quarantined, receipted', () => {
  const { ledger, gateway, vaultRoot } = setup();
  const candidates = parsePlaywrightReport(pwReport, { ref: 'run 8841', fallbackObservedAt: '2026-06-10T12:00:00Z' });
  assert.equal(candidates.length, 4);

  const summary = ingestCandidates(ledger, gateway, candidates, { vaultRoot, rules });
  assert.equal(summary.created.length, 4);
  assert.equal(summary.duplicates.length, 0);

  const evidence = ledger.allRecords('evidence') as Evidence[];
  const byTest = (needle: string): Evidence => {
    const hit = evidence.find((e) => {
      if (e.redaction.status === 'quarantined' || !e.artifact) return JSON.stringify(e).includes(needle);
      return vaultRead(vaultRoot, e.artifact.vault_path).toString('utf8').includes(needle);
    });
    assert.ok(hit, `no evidence for ${needle}`);
    return hit;
  };

  // @bhv annotation → BHV-0001, high
  const perm = byTest('viewer cannot bulk delete');
  assert.deepEqual(perm.behavior_ids, ['BHV-0001']);
  assert.equal(perm.link_confidence, 'high');
  assert.equal(perm.outcome, 'supports');
  assert.equal(perm.ingested_by, PLAYWRIGHT_INGESTOR);

  // test_id match → BHV-0002; secret scrubbed from the vault blob
  const coupon = byTest('coupon applies before tax');
  assert.deepEqual(coupon.behavior_ids, ['BHV-0002']);
  assert.equal(coupon.outcome, 'violates');
  assert.equal(coupon.redaction.status, 'redacted');
  assert.ok(coupon.artifact);
  const blob = vaultRead(vaultRoot, coupon.artifact.vault_path).toString('utf8');
  assert.ok(!blob.includes('hunter2secret9'), 'secret must not be in the vault');
  assert.match(blob, /\[REDACTED:password-assignment\]/);

  // AWS key → quarantined, metadata only, no artifact (I10)
  const quarantined = evidence.find((e) => e.redaction.status === 'quarantined');
  assert.ok(quarantined);
  assert.equal(quarantined.artifact, undefined);
  assert.ok(quarantined.redaction.rules_hit.includes('aws-access-key'));
  assert.ok(!JSON.stringify(ledger.allRecords('evidence')).includes('AKIAIOSFODNN7EXAMPLE'));

  // unmatched test → unlinked, never guessed (I3)
  const sort = evidence.find((e) => e.behavior_ids.length === 0 && e.redaction.status === 'clean');
  assert.ok(sort);

  // receipt written in the same transaction (I4)
  const receipts = ledger.allRecords('receipts') as Receipt[];
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.class, 'evidence_ingest');
  assert.equal(receipts[0]?.target, 'run 8841');
});

test('re-ingesting the same report creates no duplicates (idempotent)', () => {
  const { ledger, gateway, vaultRoot } = setup();
  const opts = { ref: 'run 8841', fallbackObservedAt: '2026-06-10T12:00:00Z' };
  const first = ingestCandidates(ledger, gateway, parsePlaywrightReport(pwReport, opts), { vaultRoot, rules });
  assert.equal(first.created.length, 4);
  const second = ingestCandidates(ledger, gateway, parsePlaywrightReport(pwReport, opts), { vaultRoot, rules });
  assert.equal(second.created.length, 0);
  assert.equal(second.duplicates.length, 4);
  assert.equal((ledger.allRecords('evidence') as Evidence[]).length, 4);
});

test('a different run ref is NOT a duplicate', () => {
  const { ledger, gateway, vaultRoot } = setup();
  ingestCandidates(ledger, gateway, parsePlaywrightReport(pwReport, { ref: 'run 8841', fallbackObservedAt: '2026-06-10T12:00:00Z' }), { vaultRoot, rules });
  const next = ingestCandidates(ledger, gateway, parsePlaywrightReport(pwReport, { ref: 'run 8842', fallbackObservedAt: '2026-06-10T12:00:00Z' }), { vaultRoot, rules });
  assert.equal(next.created.length, 4);
});

test('junit XML parses cases, outcomes and timestamp', () => {
  const { cases, timestamp } = parseJunitXml(
    '<testsuite timestamp="2026-06-10T04:00:00Z"><testcase classname="a.B" name="ok"/><testcase classname="a.B" name="bad"><failure message="x">boom</failure></testcase></testsuite>',
  );
  assert.equal(timestamp, '2026-06-10T04:00:00Z');
  assert.equal(cases.length, 2);
  assert.equal(cases[0]?.outcome, 'supports');
  assert.equal(cases[1]?.outcome, 'violates');
  assert.equal(cases[1]?.detail, 'boom');
});

test('junit report ingests: outcomes mapped, bearer token scrubbed, idempotent', () => {
  const { ledger, gateway, vaultRoot } = setup();
  const opts = { ref: 'api-run 17', fallbackObservedAt: '2026-06-10T12:00:00Z' };
  const summary = ingestCandidates(ledger, gateway, parseJunitReport(junitReport, opts), { vaultRoot, rules });
  assert.equal(summary.created.length, 3);

  const evidence = ledger.allRecords('evidence') as Evidence[];
  const outcomes = evidence.map((e) => e.outcome).sort();
  assert.deepEqual(outcomes, ['inconclusive', 'supports', 'violates']);

  const failed = evidence.find((e) => e.outcome === 'violates');
  assert.ok(failed?.artifact);
  const blob = vaultRead(vaultRoot, failed.artifact.vault_path).toString('utf8');
  assert.ok(!blob.includes('SflKxwRJ'), 'token must be scrubbed');

  const again = ingestCandidates(ledger, gateway, parseJunitReport(junitReport, opts), { vaultRoot, rules });
  assert.equal(again.created.length, 0);
  assert.equal(again.duplicates.length, 3);
});
