// `cart session start|note|stop` (CG-8.1/8.2, SPEC §7.6) — ride-along.
// Capture, don't interrupt (I8): start opens a session, note appends a
// timestamped observation, and NOTHING analytical is emitted until stop.
// stop drafts proposals (behaviors, candidate tests, questions) into the
// review queue — nothing merges without human review (I3).
import { type Clock, isoNow } from './clock.js';
import type { Ledger } from './db.js';
import type { Session } from './types.js';

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionError';
  }
}

/** The single open session for an engineer, if any. */
export function openSessionFor(ledger: Ledger, engineer: string): Session | undefined {
  return (ledger.allRecords('sessions') as Session[]).find(
    (s) => s.engineer === engineer && s.status === 'open',
  );
}

export function startSession(ledger: Ledger, engineer: string, clock: Clock): Session {
  if (openSessionFor(ledger, engineer)) {
    throw new SessionError(`${engineer} already has an open session — stop it before starting another`);
  }
  const session: Session = {
    id: ledger.nextId('session'),
    engineer,
    started_at: isoNow(clock),
    ended_at: null,
    observations: [],
    proposals: { behaviors: [], tests: [], questions: [] },
    status: 'open',
  };
  ledger.insertSession(session, engineer);
  return session;
}

export interface NoteInput {
  note: string;
  /** Set by automated capture (Playwright events); false for manual notes. */
  auto?: boolean;
  evidenceId?: string;
}

/** Append a silent observation. Returns nothing analytical (I8). */
export function noteSession(ledger: Ledger, engineer: string, input: NoteInput, clock: Clock): Session {
  const session = openSessionFor(ledger, engineer);
  if (!session) throw new SessionError(`${engineer} has no open session — start one first`);
  const observation = {
    at: isoNow(clock),
    note: input.note,
    auto: input.auto ?? false,
    ...(input.evidenceId !== undefined ? { evidence_id: input.evidenceId } : {}),
  };
  return ledger.updateSession(
    session.id,
    (s) => ({ ...s, observations: [...(s.observations ?? []), observation] }),
    engineer,
  );
}

// ---- stop → proposals ----

// lightweight tagging of free-text notes; the human reviews everything at stop
const BUG_HINT = /\b(bug|broken|fails?|error|crash|wrong|incorrect|exception|double|duplicate|leak)\b/i;
const QUESTION_HINT = /\?|\b(should|unclear|unsure|expected|supposed to|spec|why does)\b/i;

export interface SessionProposals {
  behaviors: string[];
  tests: string[];
  questions: string[];
}

/** Draft proposals from observations. Pure: derives the lists, writes nothing. */
export function draftProposals(session: Session): SessionProposals {
  const behaviors: string[] = [];
  const tests: string[] = [];
  const questions: string[] = [];
  for (const obs of session.observations ?? []) {
    // a note phrased as a question is a QUESTION even if it mentions "error"
    if (QUESTION_HINT.test(obs.note)) {
      questions.push(obs.note.replace(/\s+/g, ' ').trim());
    } else if (BUG_HINT.test(obs.note)) {
      behaviors.push(`behavior to consider: the product should NOT "${obs.note}"`);
      tests.push(`regression test draft: reproduce "${obs.note}"`);
    } else {
      behaviors.push(`behavior to consider: "${obs.note}"`);
    }
  }
  return { behaviors, tests, questions };
}

export interface StopResult {
  session: Session;
  proposals: SessionProposals;
  queuedQuestionIds: string[];
}

/**
 * Stop the session: draft proposals, queue the QUESTION observations as real
 * Q records (so they enter the same review queue cart ask/pr feed), and move
 * the session to in_review. Behavior/test proposals stay as text on the
 * session for human review — nothing is merged into the map here (I3).
 */
export function stopSession(ledger: Ledger, engineer: string, clock: Clock): StopResult {
  const session = openSessionFor(ledger, engineer);
  if (!session) throw new SessionError(`${engineer} has no open session to stop`);
  const proposals = draftProposals(session);
  const queuedQuestionIds: string[] = [];

  const updated = ledger.transaction(() => {
    for (const prompt of proposals.questions) {
      const q = {
        id: ledger.nextId('question'),
        behavior_id: null,
        prompt,
        why_asked: `raised during exploratory session ${session.id} by ${engineer}`,
        status: 'open' as const,
      };
      ledger.insertQuestion(q, engineer);
      queuedQuestionIds.push(q.id);
    }
    return ledger.updateSession(
      session.id,
      (s) => ({
        ...s,
        ended_at: isoNow(clock),
        status: 'in_review',
        proposals: { behaviors: proposals.behaviors, tests: proposals.tests, questions: queuedQuestionIds },
      }),
      engineer,
    );
  });

  return { session: updated, proposals, queuedQuestionIds };
}

export function renderStop(result: StopResult): string {
  const { session, proposals } = result;
  const lines = [`session ${session.id} stopped (${session.observations?.length ?? 0} observation(s)) → review queue`];
  lines.push('', `behavior proposals (${proposals.behaviors.length}) — review before they enter the map (I3):`);
  for (const b of proposals.behaviors) lines.push(`  · ${b}`);
  lines.push('', `candidate regression tests (${proposals.tests.length}):`);
  for (const t of proposals.tests) lines.push(`  · ${t}`);
  lines.push('', `questions queued (${result.queuedQuestionIds.length}): ${result.queuedQuestionIds.join(', ') || 'none'}`);
  lines.push('', 'nothing merged — confirm behaviors via `cart interview`, answer questions, keep or drop test drafts.');
  return lines.join('\n');
}
