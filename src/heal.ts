// Selector heal (CG-9.2, SPEC §9, I12). A locator-only patch flows:
//   guardrails (§10) → vault the pre-heal source → journal intent → apply →
//   re-run → green evidence linked in the receipt, else AUTO-REVERT and demote
// to PROPOSE. A heal is not complete until a green re-run produces new
// supporting evidence (I12) — no green run, no heal.
//
// Integrity (H2): before the patch touches disk we (a) write the ORIGINAL
// source to the content-addressed vault so the receipt's revert instruction
// points at an artifact that actually exists, and (b) write an in-flight
// journal so a crash mid-re-run leaves a loud, recoverable trace rather than a
// silently-patched file with no receipt. The journal is deleted on every
// resolved exit; a leftover journal blocks the next heal (and cart doctor
// surfaces it, I6).
//
// The patch application and test re-run sit behind ports so the flow is
// deterministic and testable; the CLI wires real file I/O and a runner.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Clock, isoNow } from './clock.js';
import type { Ledger } from './db.js';
import type { AutonomyGateway } from './autonomy.js';
import { patchViolations, type Violation } from './guardrails.js';
import { vaultWrite } from './vault.js';
import type { Evidence } from './types.js';

export interface HealProposal {
  /** Test file to patch. */
  file: string;
  /** Behavior the test verifies (the heal's evidence links here). */
  behaviorId: string;
  /** Test id, for the re-run and the receipt target. */
  testId: string;
  originalSource: string;
  patchedSource: string;
}

export interface RerunResult {
  passed: boolean;
  /** Source ref for the green-run evidence (e.g. CI run id, local run stamp). */
  ref: string;
}

export interface HealPorts {
  /** Apply the patched source to disk (or a sandbox). */
  applyPatch: (file: string, source: string) => void;
  /** Re-run the single test and report pass/fail. */
  rerun: (testId: string) => RerunResult;
}

export type HealOutcome =
  | { status: 'rejected'; violations: Violation[] }
  | { status: 'interrupted'; journalPath: string; vaultPath: string; file: string }
  | { status: 'reverted'; reason: string }
  | { status: 'healed'; receiptId: string; evidenceId: string };

/** The in-flight journal file, relative to the vault root. */
export const HEAL_JOURNAL = 'heal-inflight.json';

export interface HealJournal {
  file: string;
  testId: string;
  behaviorId: string;
  /** Vault path of the ORIGINAL source, to restore from after a crash. */
  vaultPath: string;
  startedAt: string;
}

/** Read a leftover in-flight journal, if any (used by cart doctor, H2.3). */
export function readHealJournal(vaultRoot: string): HealJournal | undefined {
  const path = join(vaultRoot, HEAL_JOURNAL);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as HealJournal;
}

/**
 * Run a selector heal end to end. Guardrails first (a forbidden patch never
 * touches disk). Then vault the original + journal intent, apply → re-run;
 * green ⇒ ACT with green evidence linked in the receipt (I12); red ⇒ revert
 * and demote to PROPOSE. The receipt's revert points at the vaulted original.
 */
export function runHeal(
  ledger: Ledger,
  gateway: AutonomyGateway,
  proposal: HealProposal,
  ports: HealPorts,
  clock: Clock,
  vaultRoot: string,
): HealOutcome {
  // 0. a leftover journal means a previous heal crashed — refuse until the
  //    operator restores the file from the vaulted original (H2.2, I6).
  const existing = readHealJournal(vaultRoot);
  if (existing) {
    return { status: 'interrupted', journalPath: join(vaultRoot, HEAL_JOURNAL), vaultPath: existing.vaultPath, file: existing.file };
  }

  // 1. guardrails — confined to locator string args (§10, I5)
  const violations = patchViolations(proposal.originalSource, proposal.patchedSource, { mode: 'selector_heal' });
  if (violations.length > 0) {
    return { status: 'rejected', violations };
  }

  // 2. vault the ORIGINAL, then journal intent — both BEFORE the patch lands,
  //    so a crash from here on is fully recoverable (H2.1/H2.2).
  const originalRef = vaultWrite(vaultRoot, proposal.originalSource);
  const journalPath = join(vaultRoot, HEAL_JOURNAL);
  const journal: HealJournal = {
    file: proposal.file,
    testId: proposal.testId,
    behaviorId: proposal.behaviorId,
    vaultPath: originalRef.vault_path,
    startedAt: isoNow(clock),
  };
  writeFileSync(journalPath, JSON.stringify(journal, null, 2), 'utf8');

  // 3. apply, then re-run
  ports.applyPatch(proposal.file, proposal.patchedSource);
  const rerun = ports.rerun(proposal.testId);

  // 4. no green re-run ⇒ auto-revert + demote to PROPOSE (I12)
  if (!rerun.passed) {
    ports.applyPatch(proposal.file, proposal.originalSource);
    rmSync(journalPath, { force: true });
    return { status: 'reverted', reason: 'no green re-run — heal demoted to PROPOSE (I12)' };
  }

  // 5. green ⇒ ACT: green evidence + receipt in the same transaction
  let evidenceId = '';
  const result = gateway.perform({
    class: 'selector_heal',
    target: proposal.testId,
    summary: `selector heal applied to ${proposal.file}; green re-run ${rerun.ref}`,
    evidence_basis: [], // filled below once the EV id exists
    revert: `restore ${proposal.file} from vault ${originalRef.vault_path}`,
    execute: () => {
      const evidence: Evidence = {
        id: ledger.nextId('evidence'),
        behavior_ids: [proposal.behaviorId],
        kind: 'test_run',
        outcome: 'supports',
        observed_at: isoNow(clock),
        source: { type: 'ci', ref: rerun.ref },
        redaction: { status: 'clean', rules_hit: [] },
        link_confidence: 'high',
        ingested_by: 'heal:selector@1',
      };
      ledger.insertEvidence(evidence, 'heal:selector@1');
      evidenceId = evidence.id;
    },
  });

  if (result.tier !== 'ACT') throw new Error('selector_heal must be ACT-tier (SPEC §9)');
  // healed and receipted — the crash window is closed; drop the journal.
  rmSync(journalPath, { force: true });
  return { status: 'healed', receiptId: result.receipt.id, evidenceId };
}

export function renderHealOutcome(proposal: HealProposal, outcome: HealOutcome): string {
  switch (outcome.status) {
    case 'rejected':
      return [
        `heal REFUSED for ${proposal.testId} — guardrails (§10):`,
        ...outcome.violations.map((v) => `  ✗ ${v.kind}: ${v.detail}`),
        'the patch was never applied.',
      ].join('\n');
    case 'interrupted':
      return [
        `heal BLOCKED for ${proposal.testId} — a previous heal did not finish.`,
        `  in-flight journal: ${outcome.journalPath}`,
        `  restore ${outcome.file} from vault ${outcome.vaultPath}, then delete the journal to proceed.`,
      ].join('\n');
    case 'reverted':
      return `heal REVERTED for ${proposal.testId}: ${outcome.reason}. File restored; propose a manual fix instead.`;
    case 'healed':
      return `heal applied to ${proposal.testId} — green re-run evidenced as ${outcome.evidenceId} (receipt ${outcome.receiptId}, I12).`;
  }
}
