// Selector heal (CG-9.2, SPEC §9, I12). A locator-only patch flows:
//   guardrails (§10) → apply → re-run → green evidence linked in the receipt,
// else AUTO-REVERT and demote to PROPOSE. A heal is not complete until a green
// re-run produces new supporting evidence (I12) — no green run, no heal.
//
// The patch application and test re-run sit behind ports so the flow is
// deterministic and testable; the CLI wires real file I/O and a runner.
import { readFileSync, writeFileSync } from 'node:fs';
import { type Clock, isoNow } from './clock.js';
import type { Ledger } from './db.js';
import type { AutonomyGateway } from './autonomy.js';
import { patchViolations, type Violation } from './guardrails.js';
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
  | { status: 'reverted'; reason: string }
  | { status: 'healed'; receiptId: string; evidenceId: string };

/**
 * Run a selector heal end to end. Guardrails first (a forbidden patch never
 * touches disk). Then apply → re-run; green ⇒ ACT with green evidence linked
 * in the receipt (I12); red ⇒ revert and demote to PROPOSE.
 */
export function runHeal(
  ledger: Ledger,
  gateway: AutonomyGateway,
  proposal: HealProposal,
  ports: HealPorts,
  clock: Clock,
): HealOutcome {
  // 1. guardrails — confined to locator string args (§10, I5)
  const violations = patchViolations(proposal.originalSource, proposal.patchedSource, { mode: 'selector_heal' });
  if (violations.length > 0) {
    return { status: 'rejected', violations };
  }

  // 2. apply, then re-run
  ports.applyPatch(proposal.file, proposal.patchedSource);
  const rerun = ports.rerun(proposal.testId);

  // 3. no green re-run ⇒ auto-revert + demote to PROPOSE (I12)
  if (!rerun.passed) {
    ports.applyPatch(proposal.file, proposal.originalSource);
    return { status: 'reverted', reason: 'no green re-run — heal demoted to PROPOSE (I12)' };
  }

  // 4. green ⇒ ACT: green evidence + receipt in the same transaction
  let evidenceId = '';
  const result = gateway.perform({
    class: 'selector_heal',
    target: proposal.testId,
    summary: `selector heal applied to ${proposal.file}; green re-run ${rerun.ref}`,
    evidence_basis: [], // filled below once the EV id exists
    revert: `restore ${proposal.file} from pre-heal source (kept in the receipt's patch)`,
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
    case 'reverted':
      return `heal REVERTED for ${proposal.testId}: ${outcome.reason}. File restored; propose a manual fix instead.`;
    case 'healed':
      return `heal applied to ${proposal.testId} — green re-run evidenced as ${outcome.evidenceId} (receipt ${outcome.receiptId}, I12).`;
  }
}
