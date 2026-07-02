// Read-only query API (SPEC §8). The LLM rim and the surfaces call these
// verbs; they never get a database handle. Mutations go exclusively through
// the autonomy gateway. Forbidden query shape: any per-person aggregation —
// the map serves the engineer, not management (I7).
import type { Ledger } from './db.js';
import { computeVerdict, type VerdictContext } from './decay.js';
import { computeHealth } from './health.js';
import { globMatch } from './linking.js';
import type { Health } from './renderer.js';
import type { Behavior, Evidence, Question, Verdict } from './types.js';

/**
 * Fields that identify people. Names appear solely for attribution of
 * decisions; grouping or aggregating by them is refused (I7, NEVER-tier).
 */
const PERSON_KEYS = ['person', 'engineer', 'by', 'author', 'user', 'confirmed_by', 'performed_by'];

export class PersonAggregationError extends Error {
  constructor(key: string) {
    super(
      `refusing per-person aggregation on "${key}" (I7): the map serves the engineer, not management. ` +
        'This is NEVER-tier and cannot be enabled by configuration.',
    );
    this.name = 'PersonAggregationError';
  }
}

export function assertNotPersonKey(groupBy: string): void {
  const normalized = groupBy.toLowerCase();
  for (const key of PERSON_KEYS) {
    if (normalized === key || normalized.endsWith(`.${key}`) || normalized.startsWith(`${key}.`)) {
      throw new PersonAggregationError(groupBy);
    }
  }
}

export interface FindBehaviorsFilter {
  text?: string;
  area?: string;
  /** Paths/globs that must overlap the behavior's implemented_in globs. */
  globs?: string[];
}

export interface GroupCount {
  key: string;
  count: number;
}

/** Question words and QA boilerplate that carry no matching signal. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'do', 'does', 'did', 'we', 'i', 'you', 'our', 'us', 'is', 'are', 'be',
  'have', 'has', 'it', 'this', 'that', 'of', 'in', 'on', 'for', 'to', 'with', 'and', 'or',
  'what', 'how', 'why', 'when', 'where', 'who', 'which', 'can', 'could', 'should', 'would',
  'must', 'any', 'there', 'about', 'covered', 'cover', 'coverage', 'test', 'tests', 'tested',
  'testing', 'verify', 'verified', 'check', 'checked',
]);

/** Lowercased, de-pluralized content tokens. */
export function tokenize(text: string): string[] {
  return [...new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 1 && !STOPWORDS.has(w))
      .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w)),
  )];
}

export class QueryApi {
  constructor(
    private readonly ledger: Ledger,
    private readonly ctx: VerdictContext,
  ) {}

  findBehaviors(filter: FindBehaviorsFilter = {}): Behavior[] {
    const all = this.ledger.allRecords('behaviors') as Behavior[];
    return all.filter((b) => {
      if (filter.area && b.area !== filter.area && !b.area.startsWith(`${filter.area}/`)) return false;
      if (filter.text && !b.statement.toLowerCase().includes(filter.text.toLowerCase())) return false;
      if (filter.globs && filter.globs.length > 0) {
        const own = b.links.implemented_in ?? [];
        const overlaps = filter.globs.some((path) => own.some((g) => globMatch(g, path)));
        if (!overlaps) return false;
      }
      return true;
    });
  }

  /** Relevance-ranked match for natural-language questions (deterministic). */
  searchBehaviors(question: string): { behavior: Behavior; score: number }[] {
    const qTokens = tokenize(question);
    if (qTokens.length === 0) return [];
    // Only active records are searchable — retired proposals (discarded or
    // merged away in the interview) must never resurface in ask (H1.1, I3).
    const all = (this.ledger.allRecords('behaviors') as Behavior[]).filter((b) => b.status === 'active');
    return all
      .map((behavior) => {
        const bTokens = new Set(tokenize(`${behavior.statement} ${behavior.area.replace(/\//g, ' ')}`));
        const hits = qTokens.filter((t) => bTokens.has(t)).length;
        return { behavior, score: hits / qTokens.length };
      })
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score || a.behavior.id.localeCompare(b.behavior.id));
  }

  /** The single verdict accessor — delegates to the decay engine (I2). */
  verdict(behaviorId: string): Verdict {
    const behavior = this.ledger.getBehavior(behaviorId);
    if (!behavior) throw new Error(`no such behavior: ${behaviorId}`);
    return computeVerdict(behavior, this.ledger.allRecords('evidence') as Evidence[], this.ctx);
  }

  evidenceFor(behaviorId: string, limit = 10): Evidence[] {
    return (this.ledger.allRecords('evidence') as Evidence[])
      .filter((e) => e.behavior_ids.includes(behaviorId))
      .sort((a, b) => b.observed_at.localeCompare(a.observed_at))
      .slice(0, limit);
  }

  getEvidence(id: string): Evidence | undefined {
    return (this.ledger.allRecords('evidence') as Evidence[]).find((e) => e.id === id);
  }

  /** Paths not covered by any behavior's implemented_in globs — gap candidates. */
  gapsFor(paths: string[]): string[] {
    const behaviors = this.ledger.allRecords('behaviors') as Behavior[];
    return paths.filter(
      (path) => !behaviors.some((b) => (b.links.implemented_in ?? []).some((g) => globMatch(g, path))),
    );
  }

  openQuestions(): Question[] {
    return (this.ledger.allRecords('questions') as Question[]).filter((q) => q.status === 'open');
  }

  health(): Health {
    return computeHealth(this.ledger, this.ctx.clock).health;
  }

  /** Product/area-level aggregation only; person keys are refused (I7). */
  countBehaviorsBy(groupBy: 'area' | 'criticality' | 'status' | string): GroupCount[] {
    assertNotPersonKey(groupBy);
    if (groupBy !== 'area' && groupBy !== 'criticality' && groupBy !== 'status') {
      throw new Error(`unsupported groupBy "${groupBy}" — allowed: area, criticality, status`);
    }
    const counts = new Map<string, number>();
    for (const b of this.ledger.allRecords('behaviors') as Behavior[]) {
      const key = b[groupBy];
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, count]) => ({ key, count }));
  }
}
