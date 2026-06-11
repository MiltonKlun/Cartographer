// Interview (CG-4.2 batch mode; CG-7.2 single-question mode lands in Phase 7).
// Each answer is applied through the validated ledger; confirming writes
// `confirmed_by` — the interview IS the approval (I3). Decisions arrive as
// structured actions so the loop is deterministic and testable; the CLI maps
// keystrokes / an answers file onto these actions.
import { type Clock, isoNow } from './clock.js';
import type { Ledger } from './db.js';
import type { Behavior } from './types.js';

export type InterviewDecision =
  | { kind: 'confirm'; edit?: Partial<Pick<Behavior, 'statement' | 'area' | 'criticality'>> }
  | { kind: 'merge'; into: string }
  | { kind: 'discard'; reason?: string };

export interface InterviewItem {
  behaviorId: string;
  decision: InterviewDecision;
}

export interface InterviewOutcome {
  confirmed: string[];
  merged: { from: string; into: string }[];
  discarded: string[];
}

/**
 * Apply a batch of decisions to drafted (unconfirmed) behaviors.
 * - confirm: write confirmed_by (+ optional inline edit), the approval (I3)
 * - merge:   retire this proposal, fold its verified_by into the target
 * - discard: retire the proposal (nothing is deleted — I11)
 */
export function applyInterview(
  ledger: Ledger,
  person: string,
  items: InterviewItem[],
  clock: Clock,
): InterviewOutcome {
  const outcome: InterviewOutcome = { confirmed: [], merged: [], discarded: [] };
  const at = isoNow(clock);

  ledger.transaction(() => {
    for (const item of items) {
      const behavior = ledger.getBehavior(item.behaviorId);
      if (!behavior) throw new Error(`no such behavior: ${item.behaviorId}`);
      if (behavior.confirmed_by) throw new Error(`${item.behaviorId} is already confirmed`);

      switch (item.decision.kind) {
        case 'confirm': {
          const edit = item.decision.edit ?? {};
          ledger.updateBehavior(
            item.behaviorId,
            (b) => ({ ...b, ...edit, confirmed_by: { person, at } }),
            person,
          );
          outcome.confirmed.push(item.behaviorId);
          break;
        }
        case 'merge': {
          const target = ledger.getBehavior(item.decision.into);
          if (!target) throw new Error(`merge target not found: ${item.decision.into}`);
          const incoming = behavior.links.verified_by ?? [];
          ledger.updateBehavior(
            item.decision.into,
            (b) => {
              const existing = b.links.verified_by ?? [];
              const seen = new Set(existing.map((v) => v.test_id));
              const merged = [...existing, ...incoming.filter((v) => !seen.has(v.test_id))];
              return { ...b, links: { ...b.links, verified_by: merged } };
            },
            person,
          );
          ledger.updateBehavior(
            item.behaviorId,
            (b) => ({ ...b, status: 'retired', notes: `${b.notes ?? ''} · merged into ${item.decision.kind === 'merge' ? item.decision.into : ''}`.trim() }),
            person,
          );
          outcome.merged.push({ from: item.behaviorId, into: item.decision.into });
          break;
        }
        case 'discard': {
          const reason = item.decision.reason;
          ledger.updateBehavior(
            item.behaviorId,
            (b) => ({ ...b, status: 'retired', notes: `${b.notes ?? ''} · discarded${reason ? `: ${reason}` : ''}`.trim() }),
            person,
          );
          outcome.discarded.push(item.behaviorId);
          break;
        }
      }
    }
  });

  return outcome;
}

/** Unconfirmed, active proposals awaiting interview, oldest id first. */
export function pendingProposals(ledger: Ledger, limit?: number): Behavior[] {
  const pending = (ledger.allRecords('behaviors') as Behavior[])
    .filter((b) => b.status === 'active' && !b.confirmed_by)
    .sort((a, b) => a.id.localeCompare(b.id));
  return limit ? pending.slice(0, limit) : pending;
}
