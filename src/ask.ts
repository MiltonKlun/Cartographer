// `cart ask` (SPEC §7.1) — the 30-second answer. Deterministic data assembly
// → claims renderer → optional LLM prose pass over the rendered rows.
//
// Minimum-viable-map rule: ask answers only when ≥1 CONFIRMED behavior
// matches the question; otherwise it answers UNKNOWN and offers to queue an
// interview question — a cold map must not pretend (I1, I3, I6).
import type { QueryApi } from './query.js';
import type { Ledger } from './db.js';
import { isoNow, type Clock } from './clock.js';
import { renderClaims, type Claim, type Health } from './renderer.js';
import type { Behavior, Question, Verdict } from './types.js';

export interface AskRow {
  behavior: Behavior;
  verdict: Verdict;
  evidenceSource?: { type: string; ref: string; observed_at: string };
  score: number;
}

export interface AskResult {
  question: string;
  rows: AskRow[];
  /** ≥1 confirmed behavior matched (minimum-viable-map rule). */
  mapViable: boolean;
  /** Matches exist but none covers most of the question's terms. */
  partial: boolean;
  unconfirmedMatches: Behavior[];
  health: Health;
}

const MAX_ROWS = 5;

export function assembleAsk(api: QueryApi, question: string): AskResult {
  const matches = api.searchBehaviors(question).slice(0, MAX_ROWS);
  const confirmed = matches.filter((m) => m.behavior.confirmed_by !== undefined);
  const unconfirmed = matches.filter((m) => m.behavior.confirmed_by === undefined);

  const rows: AskRow[] = confirmed.map(({ behavior, score }) => {
    const verdict = api.verdict(behavior.id);
    const newest = verdict.newest_evidence_id ? api.getEvidence(verdict.newest_evidence_id) : undefined;
    return {
      behavior,
      verdict,
      ...(newest
        ? { evidenceSource: { type: newest.source.type, ref: newest.source.ref, observed_at: newest.observed_at } }
        : {}),
      score,
    };
  });
  // VIOLATED leads, always (SKILL.md claim phrasing), then by relevance
  rows.sort((a, b) => Number(b.verdict.state === 'VIOLATED') - Number(a.verdict.state === 'VIOLATED') || b.score - a.score);

  return {
    question,
    rows,
    mapViable: rows.length > 0,
    partial: rows.length > 0 && rows.every((r) => r.score < 0.5),
    unconfirmedMatches: unconfirmed.map((m) => m.behavior),
    health: api.health(),
  };
}

/** Renders the rows-only answer (works with or without an LLM, SPEC §12). */
export function renderAsk(result: AskResult): string {
  const claims: Claim[] = [];

  if (result.mapViable) {
    for (const row of result.rows) {
      const src = row.evidenceSource
        ? `  (${row.evidenceSource.type}, ${row.evidenceSource.observed_at.slice(0, 10)})`
        : '';
      claims.push({
        text: `${row.behavior.id} "${row.behavior.statement}"${src}`,
        citations: [row.behavior.id, ...(row.verdict.newest_evidence_id ? [row.verdict.newest_evidence_id] : [])],
        verdict: row.verdict,
      });
    }
  } else {
    claims.push({
      text: `no confirmed behavior covers "${result.question}" — the map cannot answer this`,
      label: 'unknown',
    });
  }

  for (const b of result.unconfirmedMatches) {
    claims.push({
      text: `${b.id} "${b.statement}" [unconfirmed proposal — confirm via interview before it counts]`,
      citations: [b.id],
    });
  }

  if (result.partial) {
    claims.push({
      text: `these rows cover only part of "${result.question}" — no confirmed behavior covers the rest`,
      label: 'inference',
    });
  }

  const lines = [renderClaims(claims, result.health)];
  if (!result.mapViable || result.partial) {
    lines.push('run again with --queue to file the gap as an interview question (I3)');
  }
  return lines.join('\n');
}

/** --queue: the gap becomes a Q record, never a guessed behavior (I3). */
export function queueGapQuestion(
  ledger: Ledger,
  question: string,
  actor: string,
  clock: Clock,
): Question {
  const q: Question = {
    id: ledger.nextId('question'),
    behavior_id: null,
    prompt: question,
    why_asked: `gap: cart ask found no confirmed behavior covering "${question}" (${isoNow(clock)})`,
    status: 'open',
  };
  ledger.insertQuestion(q, actor);
  return q;
}
