// H8 — dogfood linkage: node:test's JUnit reporter carries no file/class
// identity (classname="test", no file attr), so exact test_id matching against
// bootstrap test_ids (`<file>::<title>`) fails almost always (the V2 finding,
// ~98% unlinked). The derived title-suffix match (linking.ts step 3) recovers
// the link at medium confidence. This proves it against Cartographer's OWN
// source tree + a captured node:test JUnit sample.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../../db.js';
import { AutonomyGateway } from '../../autonomy.js';
import { bootstrapRepo } from '../../bootstrap.js';
import { ingestCandidates } from '../../ingest.js';
import { parseJunitReport } from '../../ingest-junit.js';
import { loadRedactionRules } from '../../redaction.js';
import { fixedClock } from '../../clock.js';
import { projectRoot } from '../../paths.js';
import type { Behavior, Evidence } from '../../types.js';

const clock = fixedClock('2026-06-10T12:00:00Z');
const SAMPLE = join(projectRoot, 'testdata', 'self', 'junit-sample.xml');

test('H8: node:test JUnit links to bootstrapped behaviors via title suffix', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cart-dogfood-'));
  const ledger = new Ledger(join(dir, 'ledger.db'), { clock });
  const gateway = new AutonomyGateway(ledger, { clock });

  // 1. bootstrap this repo's own tests → one behavior per test, test_ids are
  //    `<file>::<title>`.
  let n = 0;
  const nextId = () => `BHV-${String(++n).padStart(4, '0')}`;
  const { drafts } = bootstrapRepo(join(projectRoot, 'src', 'test'), nextId);
  assert.ok(drafts.length > 20, `bootstrap must find many tests (got ${drafts.length})`);
  for (const b of drafts.map((p) => p.behavior)) ledger.insertBehavior(b, 'import');

  // 2. ingest the captured node:test JUnit sample (classname="test", no file).
  const candidates = parseJunitReport(SAMPLE, { ref: 'ci-dogfood', fallbackObservedAt: '2026-06-10T12:00:00Z' });
  assert.ok(candidates.length > 0, 'sample must contain testcases (guards vacuous pass)');
  ingestCandidates(ledger, gateway, candidates, { vaultRoot: join(dir, 'vault'), rules: loadRedactionRules() });

  // 3. measure linkage: evidence with ≥1 behavior_id is linked.
  const evidence = ledger.allRecords('evidence') as Evidence[];
  assert.equal(evidence.length, candidates.length, 'every case became evidence');
  const linked = evidence.filter((e) => e.behavior_ids.length > 0);

  // The V2 finding was ~2% linkage on exact match. The sample has 4 cases,
  // 3 with resolvable titles + 1 template-literal title that can't link.
  assert.ok(linked.length > 0, 'linkage must be > 0 (the whole point of H8)');
  const rate = linked.length / evidence.length;
  assert.ok(rate >= 0.5, `linkage rate ${(rate * 100).toFixed(0)}% must clear 50% (was ~2%)`);

  // the derived links are MEDIUM confidence (it's an inference, not exact id)
  for (const e of linked) {
    assert.equal(e.link_confidence, 'medium', 'title-suffix links are medium, never asserted as high');
  }
});

test('H8: a resolvable title links to exactly the right behavior', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cart-dogfood-'));
  const ledger = new Ledger(join(dir, 'ledger.db'), { clock });
  const gateway = new AutonomyGateway(ledger, { clock });
  let n = 0;
  const nextId = () => `BHV-${String(++n).padStart(4, '0')}`;
  for (const b of bootstrapRepo(join(projectRoot, 'src', 'test'), nextId).drafts.map((p) => p.behavior)) {
    ledger.insertBehavior(b, 'import');
  }
  const candidates = parseJunitReport(SAMPLE, { ref: 'ci', fallbackObservedAt: '2026-06-10T12:00:00Z' });
  ingestCandidates(ledger, gateway, candidates, { vaultRoot: join(dir, 'vault'), rules: loadRedactionRules() });

  // "parses numstat lines into added/deleted/path" is a unique diff.test.ts title
  const evidence = ledger.allRecords('evidence') as Evidence[];
  const behaviors = ledger.allRecords('behaviors') as Behavior[];
  const target = behaviors.find((b) =>
    (b.links.verified_by ?? []).some((v) => v.test_id.endsWith('::parses numstat lines into added/deleted/path')),
  );
  assert.ok(target, 'the target behavior exists');
  const ev = evidence.find((e) => e.behavior_ids.includes(target!.id));
  assert.ok(ev, 'the numstat test evidence linked to its behavior');
});
