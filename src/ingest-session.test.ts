// CG-8.3 — ET-Kit session-sheet importer (decision 0001, SPEC §6 mapping).
// BUG/ISSUE → violating manual-observation evidence (redacted/vaulted);
// QUESTION → open Q; IDEA → session proposal. Secrets never enter the ledger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from './db.js';
import { AutonomyGateway } from './autonomy.js';
import { parseSessionSheet, importSessionSheet } from './ingest-session.js';
import { loadRedactionRules } from './redaction.js';
import { vaultRead } from './vault.js';
import { fixedClock } from './clock.js';
import { projectRoot } from './paths.js';
import { readFileSync } from 'node:fs';
import type { Behavior, Evidence, Question, Receipt, Session } from './types.js';

const clock = fixedClock('2026-06-11T20:00:00Z');
const rules = loadRedactionRules();
const sheetPath = join(projectRoot, 'testdata', 'et-session-sheet.md');
const sheetDir = join(projectRoot, 'testdata');

function setup(withBehavior = true): { ledger: Ledger; gateway: AutonomyGateway; vaultRoot: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cart-etk-'));
  const ledger = new Ledger(join(dir, 'ledger.db'), { clock });
  if (withBehavior) {
    ledger.insertBehavior(
      {
        id: 'BHV-0002',
        statement: 'Coupon applies before tax',
        area: 'checkout/coupons',
        criticality: 'red',
        links: {},
        confirmed_by: { person: 'ana', at: '2026-06-01T00:00:00Z' },
        created_by: 'interview',
        status: 'active',
      },
      'ana',
    );
  }
  return { ledger, gateway: new AutonomyGateway(ledger, { clock }), vaultRoot: join(dir, 'vault') };
}

test('parseSessionSheet reads metadata and tagged observation rows', () => {
  const sheet = parseSessionSheet(readFileSync(sheetPath, 'utf8'));
  assert.equal(sheet.sessionId, 'ET-20260611-01');
  assert.equal(sheet.engineer, 'ana');
  assert.equal(sheet.date, '2026-06-11');
  assert.equal(sheet.observations.length, 5);
  const tags = sheet.observations.map((o) => o.tag);
  assert.deepEqual(tags, ['BUG', 'ISSUE', 'QUESTION', 'IDEA', 'BUG']);
  assert.equal(sheet.observations[0]?.evidenceRef, 'evidence/double-cart.txt');
});

test('import maps tags per SPEC §6 and creates a review-queue session', () => {
  const { ledger, gateway, vaultRoot } = setup();
  const sheet = parseSessionSheet(readFileSync(sheetPath, 'utf8'));
  const summary = importSessionSheet(ledger, gateway, sheet, { vaultRoot, rules, baseDir: sheetDir, clock });

  // 3 BUG/ISSUE (two BUG + one ISSUE) → evidence; 1 QUESTION → Q; 1 IDEA → proposal
  assert.equal(summary.evidenceCreated.length, 3);
  assert.equal(summary.questionsQueued.length, 1);
  assert.equal(summary.ideaProposals.length, 1);

  const evidence = ledger.allRecords('evidence') as Evidence[];
  assert.ok(evidence.every((e) => e.outcome === 'violates' && e.kind === 'manual_observation'));
  assert.ok(evidence.every((e) => e.ingested_by === 'ingest:session@1'));

  // the ISSUE referenced BHV-0002 in its text → linked (low confidence, I3)
  const linked = evidence.find((e) => e.behavior_ids.includes('BHV-0002'));
  assert.ok(linked, 'oracle BHV-id should link the observation');
  assert.equal(linked.link_confidence, 'low');

  const questions = ledger.allRecords('questions') as Question[];
  assert.equal(questions[0]?.status, 'open');
  assert.match(questions[0]?.prompt ?? '', /expired coupons/);

  const sessions = ledger.allRecords('sessions') as Session[];
  assert.equal(sessions[0]?.status, 'in_review');
  assert.match(sessions[0]?.proposals?.tests?.[0] ?? '', /idea: add a money tour/);
});

test('referenced evidence file is redacted then vaulted (I10)', () => {
  const { ledger, gateway, vaultRoot } = setup();
  const sheet = parseSessionSheet(readFileSync(sheetPath, 'utf8'));
  importSessionSheet(ledger, gateway, sheet, { vaultRoot, rules, baseDir: sheetDir, clock });
  const evidence = ledger.allRecords('evidence') as Evidence[];

  // the clean double-cart.txt is vaulted
  const clean = evidence.find((e) => e.artifact && e.redaction.status === 'clean');
  assert.ok(clean?.artifact);
  assert.match(vaultRead(vaultRoot, clean.artifact.vault_path).toString('utf8'), /Two carts created/);

  // the console.log with a password is scrubbed before vaulting
  const scrubbed = evidence.find((e) => e.redaction.status === 'redacted');
  assert.ok(scrubbed?.artifact, 'console log should be redacted+vaulted, not dropped');
  const blob = vaultRead(vaultRoot, scrubbed.artifact.vault_path).toString('utf8');
  assert.ok(!blob.includes('hunter2secret9'), 'secret must be scrubbed');
});

test('secrets never reach the ledger or the vault', () => {
  const { ledger, gateway, vaultRoot } = setup();
  const sheet = parseSessionSheet(readFileSync(sheetPath, 'utf8'));
  importSessionSheet(ledger, gateway, sheet, { vaultRoot, rules, baseDir: sheetDir, clock });
  // not in the ledger rows
  assert.ok(!JSON.stringify(ledger.allRecords('evidence')).includes('hunter2secret9'));
  // not in any vaulted blob either (scrubbed before write, I10)
  const evidence = ledger.allRecords('evidence') as Evidence[];
  for (const e of evidence) {
    if (e.artifact) assert.ok(!vaultRead(vaultRoot, e.artifact.vault_path).toString('utf8').includes('hunter2secret9'));
  }
});

test('import is one ACT with a receipt (I4); nothing merged into the map (I3)', () => {
  const { ledger, gateway, vaultRoot } = setup();
  const sheet = parseSessionSheet(readFileSync(sheetPath, 'utf8'));
  importSessionSheet(ledger, gateway, sheet, { vaultRoot, rules, baseDir: sheetDir, clock });

  const receipts = ledger.allRecords('receipts') as Receipt[];
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.class, 'evidence_ingest');

  // only the seeded behavior exists — the sheet invented none (I3)
  assert.equal((ledger.allRecords('behaviors') as Behavior[]).length, 1);
});

test('a malformed/empty sheet imports cleanly with nothing created', () => {
  const { ledger, gateway, vaultRoot } = setup(false);
  const sheet = parseSessionSheet('# notes\n\njust prose, no observation table\n');
  const summary = importSessionSheet(ledger, gateway, sheet, { vaultRoot, rules, baseDir: sheetDir, clock });
  assert.equal(summary.evidenceCreated.length, 0);
  assert.equal(summary.questionsQueued.length, 0);
});
