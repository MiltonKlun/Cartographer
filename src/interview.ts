// Interview (CG-4.2 batch mode; CG-7.2 single-question mode lands in Phase 7).
// Each answer is applied through the validated ledger; confirming writes
// `confirmed_by` — the interview IS the approval (I3). Decisions arrive as
// structured actions so the loop is deterministic and testable; the CLI maps
// keystrokes / an answers file onto these actions.
import { type Clock, isoNow } from './clock.js';
import type { Ledger } from './db.js';
import { guessCriticality } from './criticality.js';
import type { Behavior, Criticality, Question } from './types.js';

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
          const into = item.decision.into;
          ledger.updateBehavior(
            item.behaviorId,
            // record the merge on the retired side so the survivor inherits
            // this behavior's evidence via the alias chain in verdicts (H7).
            (b) => ({ ...b, status: 'retired', merged_into: into, notes: `${b.notes ?? ''} · merged into ${into}`.trim() }),
            person,
          );
          outcome.merged.push({ from: item.behaviorId, into });
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

// ---- single-question flow (CG-7.2, SPEC §7.5) ----

/** The next open question to put to a human (oldest id first). */
export function nextQuestion(ledger: Ledger): Question | undefined {
  return (ledger.allRecords('questions') as Question[])
    .filter((q) => q.status === 'open')
    .sort((a, b) => a.id.localeCompare(b.id))[0];
}

export type QuestionAnswer =
  | { kind: 'new_behavior'; statement: string; area: string; criticality?: Criticality }
  | { kind: 'confirm_existing'; behaviorId: string }
  | { kind: 'dismiss'; reason?: string };

export interface AnswerOutcome {
  questionId: string;
  resultingMutations: string[];
}

/**
 * Answer one open question. The answer IS the approval (I3): a new behavior is
 * created AND confirmed in the same step; the question is closed and records
 * its resulting mutations. Everything runs in one transaction.
 */
export function answerQuestion(
  ledger: Ledger,
  questionId: string,
  person: string,
  answer: QuestionAnswer,
  clock: Clock,
): AnswerOutcome {
  const at = isoNow(clock);
  const mutations: string[] = [];

  ledger.transaction(() => {
    const question = (ledger.allRecords('questions') as Question[]).find((q) => q.id === questionId);
    if (!question) throw new Error(`no such question: ${questionId}`);
    if (question.status !== 'open') throw new Error(`${questionId} is not open (status: ${question.status})`);

    let answerText: string;
    switch (answer.kind) {
      case 'new_behavior': {
        const criticality = answer.criticality ?? guessCriticality(`${answer.statement} ${answer.area}`).criticality;
        const behavior: Behavior = {
          id: ledger.nextId('behavior'),
          statement: answer.statement,
          area: answer.area,
          criticality,
          links: {},
          confirmed_by: { person, at }, // answering confirms (I3)
          created_by: 'interview',
          status: 'active',
          notes: `created from ${questionId}`,
        };
        ledger.insertBehavior(behavior, person);
        mutations.push(`${behavior.id} created`, `${behavior.id} confirmed`);
        answerText = `Yes — ${answer.statement} (${behavior.id})`;
        break;
      }
      case 'confirm_existing': {
        const existing = ledger.getBehavior(answer.behaviorId);
        if (!existing) throw new Error(`no such behavior: ${answer.behaviorId}`);
        if (!existing.confirmed_by) {
          ledger.updateBehavior(answer.behaviorId, (b) => ({ ...b, confirmed_by: { person, at } }), person);
          mutations.push(`${answer.behaviorId} confirmed`);
        }
        answerText = `Covered by ${answer.behaviorId}`;
        break;
      }
      case 'dismiss': {
        answerText = `Dismissed${answer.reason ? `: ${answer.reason}` : ''}`;
        break;
      }
    }

    const newStatus = answer.kind === 'dismiss' ? 'dismissed' : 'answered';
    const updated: Question = {
      ...question,
      status: newStatus,
      answer: { by: person, at, text: answerText },
      resulting_mutations: mutations,
    };
    ledger.updateQuestion(updated, person);
  });

  return { questionId, resultingMutations: mutations };
}
