// `cart pr <ref>` — risk note (CG-5.1/5.2, SPEC §7.2). Assembly:
//   diff → touched globs → behaviors via implemented_in overlap
//        → rank by criticality × (1 − F)
//        → uncovered new files become gap candidates (+ optionally queued Q).
// Every line cites ledger rows; the only inferred line is the recommendation,
// which is labeled. Posting the comment is PROPOSE by default (CG-5.2).
import type { QueryApi } from './query.js';
import type { Ledger } from './db.js';
import { type Clock, isoNow } from './clock.js';
import { globMatch } from './linking.js';
import { renderClaims, type Claim, type Health } from './renderer.js';
import type { Behavior, Criticality, Question, Verdict } from './types.js';
import type { DiffSummary, FileChange } from './diff.js';

const CRITICALITY_WEIGHT: Record<Criticality, number> = { red: 4, high: 3, normal: 2, low: 1 };

export interface RiskRow {
  behavior: Behavior;
  verdict: Verdict;
  /** criticality weight × (1 − freshness): higher = more exposed by this PR. */
  risk: number;
  touchedBy: string[];
}

export interface GapCandidate {
  path: string;
  /** Set once queued via --queue. */
  questionId?: string;
}

export interface RiskNote {
  ref: string;
  diff: DiffSummary;
  rows: RiskRow[];
  gaps: GapCandidate[];
  health: Health;
}

function isSourceFile(path: string): boolean {
  // gaps are about product code, not tests/config/docs
  return (
    /\.(ts|tsx|js|jsx|mjs|cjs|py|go|java|rb|rs|php|cs)$/.test(path) &&
    !/(\.spec\.|\.test\.|__tests__|\/tests?\/|\.d\.ts$)/.test(path)
  );
}

export function assembleRiskNote(api: QueryApi, ref: string, diff: DiffSummary, health: Health): RiskNote {
  const touchedPaths = diff.files.map((f) => f.path);

  // behaviors whose implemented_in globs overlap any touched path
  const behaviors = api.findBehaviors().filter((b) => b.status === 'active' && b.confirmed_by);
  const rows: RiskRow[] = [];
  for (const behavior of behaviors) {
    const globs = behavior.links.implemented_in ?? [];
    const touchedBy = touchedPaths.filter((p) => globs.some((g) => globMatch(g, p)));
    if (touchedBy.length === 0) continue;
    const verdict = api.verdict(behavior.id);
    const risk = CRITICALITY_WEIGHT[behavior.criticality] * (1 - verdict.freshness);
    rows.push({ behavior, verdict, risk, touchedBy });
  }
  rows.sort((a, b) => b.risk - a.risk || a.behavior.id.localeCompare(b.behavior.id));

  // new source files no behavior covers → gap candidates
  const coveredGlobs = behaviors.flatMap((b) => b.links.implemented_in ?? []);
  const gaps: GapCandidate[] = diff.files
    .filter((f: FileChange) => f.isNew && isSourceFile(f.path))
    .filter((f) => !coveredGlobs.some((g) => globMatch(g, f.path)))
    .map((f) => ({ path: f.path }));

  return { ref, diff, rows, gaps, health };
}

/** Queue a gap candidate as an interview question (I3); mutates note in place. */
export function queueGaps(ledger: Ledger, note: RiskNote, actor: string, clock: Clock): Question[] {
  const queued: Question[] = [];
  ledger.transaction(() => {
    for (const gap of note.gaps) {
      const q: Question = {
        id: ledger.nextId('question'),
        behavior_id: null,
        prompt: `What behavior should ${gap.path} guarantee? It is new in ${note.ref} and no behavior covers it.`,
        why_asked: `gap: ${note.ref} adds ${gap.path}; no behavior's implemented_in matches (${isoNow(clock)})`,
        status: 'open',
      };
      ledger.insertQuestion(q, actor);
      gap.questionId = q.id;
      queued.push(q);
    }
  });
  return queued;
}

export function renderRiskNote(note: RiskNote): string {
  const { diff } = note;
  const scope = topGlobs(note);
  const header = `Cartographer — risk note for ${note.ref} (+${diff.totalAdded}/−${diff.totalDeleted}${scope ? ` in ${scope}` : ''})`;

  if (note.rows.length === 0 && note.gaps.length === 0) {
    const claim: Claim = {
      text: `${note.ref} touches no code covered by a confirmed behavior, and adds no uncovered source files`,
      label: 'unknown',
    };
    return `${header}\n${renderClaims([claim], note.health)}`;
  }

  const claims: Claim[] = [];
  for (const row of note.rows) {
    claims.push({
      text: `${row.behavior.id} ${row.behavior.statement}  [${row.behavior.criticality}]`,
      citations: [row.behavior.id, ...(row.verdict.newest_evidence_id ? [row.verdict.newest_evidence_id] : [])],
      verdict: row.verdict,
    });
  }
  for (const gap of note.gaps) {
    const tail = gap.questionId ? `queued ${gap.questionId}` : 'no behavior covers it (run with --queue to file a question)';
    claims.push({ text: `${gap.path} is new — ${tail}`, label: 'unknown' });
  }

  const lines = [header, renderClaims(claims, note.health), renderRecommendation(note)];
  lines.push('Every behavior line cites ledger rows; only the recommendation is inferred.');
  return lines.filter(Boolean).join('\n');
}

function renderRecommendation(note: RiskNote): string {
  const steps: string[] = [];
  const topStale = note.rows.filter((r) => r.verdict.state === 'STALE' || r.verdict.state === 'VIOLATED' || r.verdict.state === 'UNKNOWN');
  if (topStale.length > 0) {
    const ids = topStale.slice(0, 3).map((r) => r.behavior.id).join(', ');
    steps.push(`re-run the suites covering ${ids} to refresh their evidence`);
  }
  const queued = note.gaps.filter((g) => g.questionId).map((g) => g.questionId);
  if (queued.length > 0) steps.push(`answer ${queued.join(', ')}`);
  else if (note.gaps.length > 0) steps.push(`decide what the ${note.gaps.length} new file(s) should guarantee`);
  if (steps.length === 0) return '';
  return `inference: before merging I'd: ${steps.map((s, i) => `${i + 1}) ${s}`).join('; ')}.`;
}

function topGlobs(note: RiskNote): string {
  // show the dominant directory of the diff for the header, like SPEC §7.2
  const dirs = new Map<string, number>();
  for (const f of note.diff.files) {
    const dir = f.path.includes('/') ? `${f.path.slice(0, f.path.lastIndexOf('/'))}/**` : f.path;
    dirs.set(dir, (dirs.get(dir) ?? 0) + f.added + f.deleted);
  }
  const top = [...dirs.entries()].sort((a, b) => b[1] - a[1])[0];
  return top?.[0] ?? '';
}
