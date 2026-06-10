// Read-only query API (SPEC §8). The LLM rim and the surfaces call these
// verbs; they never get a database handle. Mutations go exclusively through
// the autonomy gateway. Forbidden query shape: any per-person aggregation —
// the map serves the engineer, not management (I7).
import type { Ledger } from './db.js';
import type { Behavior } from './types.js';

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
}

export interface GroupCount {
  key: string;
  count: number;
}

export class QueryApi {
  constructor(private readonly ledger: Ledger) {}

  findBehaviors(filter: FindBehaviorsFilter = {}): Behavior[] {
    const all = this.ledger.allRecords('behaviors') as Behavior[];
    return all.filter((b) => {
      if (filter.area && b.area !== filter.area && !b.area.startsWith(`${filter.area}/`)) return false;
      if (filter.text && !b.statement.toLowerCase().includes(filter.text.toLowerCase())) return false;
      return true;
    });
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
