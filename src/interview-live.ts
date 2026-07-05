// Live interview loop (H6, SPEC §7.5) — confirm bootstrap proposals one
// keystroke at a time instead of one CLI invocation each or hand-authored
// JSON. IO is injected (an `InterviewIO`) so the loop is fully testable; the
// CLI wires `node:readline/promises` over stdin/stdout.
//
// Each decision is applied IMMEDIATELY via the existing `applyInterview` with
// a single-item list, so quitting mid-way never loses an answer already given
// (I3/I11 — the confirmation is the approval, and it's durable the moment it's
// made).
import { type Clock } from './clock.js';
import type { Ledger } from './db.js';
import { applyInterview, pendingProposals, type InterviewDecision } from './interview.js';
import type { Behavior } from './types.js';

export interface InterviewIO {
  /** Prompt the human and read a line (trimmed by the caller if desired). */
  ask: (prompt: string) => Promise<string>;
  /** Emit a line of output. */
  say: (line: string) => void;
}

export interface LiveSummary {
  confirmed: number;
  merged: number;
  discarded: number;
  skipped: number;
  /** Proposals still pending when the loop ended (quit or exhausted). */
  remaining: number;
}

function card(b: Behavior): string {
  const testId = b.links.verified_by?.[0]?.test_id ?? '(no test)';
  return [
    `${b.id}  [${b.criticality}]  ${b.statement}`,
    `      area: ${b.area} · from: ${testId} · drafted by: ${b.created_by}`,
  ].join('\n');
}

const MENU = '[y]es confirm · [e]dit · [m]erge into · [d]iscard · [s]kip · [q]uit';

/**
 * Drive the live interview. Returns a summary; every applied decision is
 * already persisted when this resolves (nothing is buffered).
 */
export async function runInterviewLoop(
  ledger: Ledger,
  io: InterviewIO,
  actor: string,
  clock: Clock,
): Promise<LiveSummary> {
  const summary: LiveSummary = { confirmed: 0, merged: 0, discarded: 0, skipped: 0, remaining: 0 };

  // Snapshot the pending set up front; we walk it in order. A decision may
  // retire the current proposal, but never the others, so the ids stay valid.
  const pending = pendingProposals(ledger);
  if (pending.length === 0) {
    io.say('no pending proposals — the map has no unconfirmed behaviors awaiting interview');
    return summary;
  }

  io.say(`${pending.length} proposal(s) awaiting your judgment. For each: ${MENU}`);

  let index = 0;
  for (; index < pending.length; index++) {
    const b = pending[index]!;
    io.say('');
    io.say(card(b));
    const choice = (await io.ask(`  ${MENU} > `)).trim().toLowerCase();

    if (choice === 'q') break;
    if (choice === '' || choice === 's') {
      summary.skipped++;
      continue;
    }

    let decision: InterviewDecision | undefined;
    switch (choice) {
      case 'y':
        decision = { kind: 'confirm' };
        break;
      case 'e': {
        const edited = (await io.ask('  new statement (empty = keep as-is) > ')).trim();
        decision = edited ? { kind: 'confirm', edit: { statement: edited } } : { kind: 'confirm' };
        break;
      }
      case 'm': {
        const into = (await io.ask('  merge into which BHV-id? > ')).trim();
        const target = into ? ledger.getBehavior(into) : undefined;
        if (!target || target.status !== 'active' || !target.confirmed_by) {
          io.say(`  ✗ "${into}" is not a confirmed active behavior — skipping this proposal`);
          summary.skipped++;
          continue;
        }
        decision = { kind: 'merge', into };
        break;
      }
      case 'd': {
        const reason = (await io.ask('  reason (optional) > ')).trim();
        decision = reason ? { kind: 'discard', reason } : { kind: 'discard' };
        break;
      }
      default:
        io.say(`  ? unrecognized "${choice}" — skipping (use ${MENU})`);
        summary.skipped++;
        continue;
    }

    // apply this ONE decision now — durable before we move on (I3/I11)
    const outcome = applyInterview(ledger, actor, [{ behaviorId: b.id, decision }], clock);
    if (outcome.confirmed.length) { summary.confirmed++; io.say(`  ✓ ${b.id} confirmed`); }
    if (outcome.merged.length) { summary.merged++; io.say(`  ⇒ ${b.id} merged into ${outcome.merged[0]!.into}`); }
    if (outcome.discarded.length) { summary.discarded++; io.say(`  ✗ ${b.id} discarded`); }
  }

  // anything we didn't reach (quit) plus anything skipped is still pending
  summary.remaining = pendingProposals(ledger).length;

  io.say('');
  io.say(
    `interview session by ${actor}: ${summary.confirmed} confirmed, ${summary.merged} merged, ` +
      `${summary.discarded} discarded, ${summary.skipped} skipped · ${summary.remaining} still pending`,
  );
  return summary;
}
