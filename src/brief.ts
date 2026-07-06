// `cart brief` (CG-7.1, SPEC §7.4) — the morning brief, one screen, hard
// limit. Sections in fixed order: overnight verdict transitions (→FAILING
// first, then VERIFIED→STALE); decayed red-criticality behaviors; open PRs ×
// stale exposure; quarantine expiries; top 3 open questions. Footer:
// ingestion health (I6). Every behavior line cites its row; the brief is
// assembled from the query API + decay engine, never invented.
import { type Clock, isoNow } from './clock.js';
import type { Ledger } from './db.js';
import { type QueryApi, mergedAliasesOf } from './query.js';
import { computeVerdict, type VerdictContext } from './decay.js';
import { expiredEntries, loadQuarantine, type QuarantineEntry } from './quarantine.js';
import type { Behavior, Evidence, Question, VerdictState } from './types.js';

export interface Transition {
  behaviorId: string;
  statement: string;
  from: VerdictState;
  to: VerdictState;
  criticality: Behavior['criticality'];
}

export interface BriefData {
  at: string;
  transitions: Transition[];
  decayedRed: { id: string; statement: string; state: VerdictState; freshness: number }[];
  quarantineExpiries: QuarantineEntry[];
  topQuestions: Question[];
  health: { degraded: boolean; reason?: string; since?: string };
  isFirstBrief: boolean;
}

const TOP_QUESTIONS = 3;
const MAX_TRANSITIONS = 6;
const MAX_DECAYED_RED = 5;

/** Transition priority: anything → FAILING first, then VERIFIED → worse. */
function transitionRank(t: Transition): number {
  if (t.to === 'FAILING') return 0;
  if (t.from === 'VERIFIED' && (t.to === 'STALE' || t.to === 'UNKNOWN')) return 1;
  return 2;
}

export interface AssembleBriefOptions {
  quarantinePath: string;
  /** Persist this run's verdicts as a snapshot for the next brief to diff. */
  writeSnapshot?: boolean;
}

export function assembleBrief(
  ledger: Ledger,
  api: QueryApi,
  ctx: VerdictContext,
  opts: AssembleBriefOptions,
): BriefData {
  const at = isoNow(ctx.clock);
  const allBehaviors = ledger.allRecords('behaviors') as Behavior[];
  const behaviors = allBehaviors.filter((b) => b.status === 'active');
  const evidence = ledger.allRecords('evidence') as Evidence[];

  // current verdicts — resolve merge aliases so a survivor inherits its
  // duplicates' evidence, consistent with cart ask / verdict (H7).
  const current = new Map<string, { state: VerdictState; freshness: number }>();
  for (const b of behaviors) {
    const v = computeVerdict(b, evidence, ctx, mergedAliasesOf(allBehaviors, b.id));
    current.set(b.id, { state: v.state, freshness: v.freshness });
  }

  // overnight transitions: diff against the most recent prior snapshot
  const prevAt = ledger.previousSnapshotAt(at);
  const isFirstBrief = prevAt === undefined;
  const previous = prevAt ? ledger.verdictSnapshot(prevAt) : new Map();
  const transitions: Transition[] = [];
  for (const b of behaviors) {
    const now = current.get(b.id);
    const before = previous.get(b.id);
    if (!now || !before || before.state === now.state) continue;
    transitions.push({
      behaviorId: b.id,
      statement: b.statement,
      from: before.state as VerdictState,
      to: now.state,
      criticality: b.criticality,
    });
  }
  transitions.sort((a, b) => transitionRank(a) - transitionRank(b) || a.behaviorId.localeCompare(b.behaviorId));

  // decayed red-criticality behaviors (confirmed, not currently VERIFIED)
  const decayedRed = behaviors
    .filter((b) => b.criticality === 'red' && b.confirmed_by)
    .map((b) => ({ id: b.id, statement: b.statement, ...current.get(b.id)! }))
    .filter((r) => r.state === 'STALE' || r.state === 'UNKNOWN' || r.state === 'FAILING')
    .sort((a, b) => a.freshness - b.freshness)
    .slice(0, MAX_DECAYED_RED);

  // quarantine expiries
  const quarantineExpiries = expiredEntries(loadQuarantine(opts.quarantinePath), ctx.clock);

  // top open questions
  const topQuestions = api.openQuestions().slice(0, TOP_QUESTIONS);

  if (opts.writeSnapshot) {
    ledger.writeVerdictSnapshot(
      at,
      [...current.entries()].map(([behavior_id, v]) => ({ behavior_id, state: v.state, freshness: v.freshness })),
    );
  }

  return {
    at,
    transitions: transitions.slice(0, MAX_TRANSITIONS),
    decayedRed,
    quarantineExpiries,
    topQuestions,
    health: api.health(),
    isFirstBrief,
  };
}

export function renderBrief(data: BriefData): string {
  const lines: string[] = [`☕ cart brief — ${data.at}`];

  lines.push('', 'Overnight transitions:');
  if (data.isFirstBrief) {
    lines.push('  (first brief — no prior snapshot to compare; transitions appear from tomorrow)');
  } else if (data.transitions.length === 0) {
    lines.push('  none');
  } else {
    for (const t of data.transitions) {
      const lead = t.to === 'FAILING' ? '🚨 ' : '';
      lines.push(`  ${lead}${t.behaviorId} [${t.criticality}] ${t.from} → ${t.to}  "${t.statement}"`);
    }
  }

  lines.push('', 'Decayed red-criticality behaviors:');
  if (data.decayedRed.length === 0) lines.push('  none — all red behaviors are fresh');
  else for (const r of data.decayedRed) lines.push(`  ${r.id} ${r.state} F=${r.freshness.toFixed(2)}  "${r.statement}"`);

  lines.push('', "Today's open PRs × stale exposure:");
  lines.push('  (no PR-tracker integration in v1 — run `cart pr <ref>` per PR; see SPEC §14)');

  lines.push('', 'Quarantine expiries:');
  if (data.quarantineExpiries.length === 0) lines.push('  none');
  else for (const e of data.quarantineExpiries) lines.push(`  ⚠ ${e.test_id} (ticket ${e.ticket}) expired ${e.expires_at} — resolve or re-quarantine`);

  lines.push('', `Top ${TOP_QUESTIONS} open questions:`);
  if (data.topQuestions.length === 0) lines.push('  none open');
  else for (const q of data.topQuestions) lines.push(`  ${q.id} ${q.prompt}`);

  lines.push('', data.health.degraded
    ? `⚠ ingestion health: DEGRADED — ${data.health.reason} (verdicts above may be unreliable, I6)`
    : 'ingestion health: OK');
  return lines.join('\n');
}
