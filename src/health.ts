// Health (CG-2.3, I6): a stale map is worse than no map. Ingestion failures
// degrade LOUDLY — computeHealth feeds the renderer's banner on every
// surface. Per-ingestor last-success comes from the mutations log (the
// ingestor is the mutation actor), so health needs no extra bookkeeping.
//
// Realism (H3): an ingestor used once and never again must not degrade the
// map forever — that trains users to ignore the banner. After
// `retirement_hours` an unlisted ingestor goes `inactive` and stops counting
// against health. An ingestor listed in `expected_ingestors` is a deliberate
// feed: it NEVER retires — it degrades health until it ingests again, however
// long that takes (that is the whole point of listing it).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Clock } from './clock.js';
import type { Ledger } from './db.js';
import { configDir } from './paths.js';
import type { Health } from './renderer.js';
import { computeVerdict, type VerdictContext } from './decay.js';
import type { Behavior, Evidence, Question, Verdict, VerdictState } from './types.js';

/** fresh = within SLA; stale = past SLA (degrades); inactive = past retirement
 *  (an unlisted feed we assume was one-off — no longer counted). */
export type IngestorState = 'fresh' | 'stale' | 'inactive';

export interface IngestorStatus {
  ingestor: string;
  lastSuccess: string;
  staleHours: number;
  state: IngestorState;
  /** Retained for existing callers/tests: true iff state === 'fresh'. */
  withinSla: boolean;
}

export interface StatusReport {
  health: Health;
  ingestors: IngestorStatus[];
  counts: { behaviors: number; confirmed: number; evidence: number; questionsOpen: number; quarantined: number; receipts: number };
  verdictHistogram: Record<VerdictState, number>;
}

export const DEFAULT_SLA_HOURS = 26; // daily CI + slack; tune at adoption
export const DEFAULT_RETIREMENT_HOURS = 336; // 14 days — a one-off feed goes quiet

const MS_PER_HOUR = 3_600_000;

export interface HealthConfig {
  sla_hours: number;
  retirement_hours: number;
  /** Ingestors that must keep degrading health when quiet — never retire. */
  expected_ingestors: string[];
}

/** Load config/health.json if present; a missing/partial file ⇒ defaults.
 *  Never throws on absence — health must work with zero config (H3.2). */
export function loadHealthConfig(path?: string): HealthConfig {
  const file = path ?? join(configDir, 'health.json');
  let raw: Partial<HealthConfig> = {};
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<HealthConfig>;
  } catch {
    raw = {}; // absent or unreadable → all defaults (H3.2)
  }
  return {
    sla_hours: raw.sla_hours ?? DEFAULT_SLA_HOURS,
    retirement_hours: raw.retirement_hours ?? DEFAULT_RETIREMENT_HOURS,
    expected_ingestors: raw.expected_ingestors ?? [],
  };
}

/** Loaded config with selective overrides (e.g. the CLI's `--sla` flag). */
export function healthConfig(over?: Partial<HealthConfig>): HealthConfig {
  const base = loadHealthConfig();
  return {
    sla_hours: over?.sla_hours ?? base.sla_hours,
    retirement_hours: over?.retirement_hours ?? base.retirement_hours,
    expected_ingestors: over?.expected_ingestors ?? base.expected_ingestors,
  };
}

export function computeHealth(
  ledger: Ledger,
  clock: Clock,
  cfg: HealthConfig = loadHealthConfig(),
): { health: Health; ingestors: IngestorStatus[] } {
  const lastByIngestor = new Map<string, string>();
  for (const m of ledger.allMutations()) {
    if (!m.actor.startsWith('ingest:')) continue;
    const prev = lastByIngestor.get(m.actor);
    if (!prev || m.at > prev) lastByIngestor.set(m.actor, m.at);
  }

  const now = clock().getTime();
  const expected = new Set(cfg.expected_ingestors);
  const ingestors: IngestorStatus[] = [...lastByIngestor.entries()]
    .map(([ingestor, lastSuccess]) => {
      const staleHours = (now - new Date(lastSuccess).getTime()) / MS_PER_HOUR;
      let state: IngestorState;
      if (staleHours <= cfg.sla_hours) {
        state = 'fresh';
      } else if (staleHours > cfg.retirement_hours && !expected.has(ingestor)) {
        // past retirement AND not a deliberate feed ⇒ assume one-off, excuse it
        state = 'inactive';
      } else {
        state = 'stale';
      }
      return { ingestor, lastSuccess, staleHours, state, withinSla: state === 'fresh' };
    })
    .sort((a, b) => a.ingestor.localeCompare(b.ingestor));

  // Only `stale` ingestors degrade health — `inactive` ones are excused (H3.1).
  const stale = ingestors.filter((i) => i.state === 'stale');
  if (stale.length === 0) return { health: { degraded: false }, ingestors };
  const worst = stale.reduce((a, b) => (a.staleHours > b.staleHours ? a : b));
  return {
    health: {
      degraded: true,
      reason: `${worst.ingestor} has not ingested for ${Math.floor(worst.staleHours)}h (SLA ${cfg.sla_hours}h)`,
      since: worst.lastSuccess,
    },
    ingestors,
  };
}

export function computeStatus(ledger: Ledger, ctx: VerdictContext, cfg: HealthConfig = loadHealthConfig()): StatusReport {
  const { health, ingestors } = computeHealth(ledger, ctx.clock, cfg);

  const behaviors = ledger.allRecords('behaviors') as Behavior[];
  const evidence = ledger.allRecords('evidence') as Evidence[];
  const questions = ledger.allRecords('questions') as Question[];

  const verdictHistogram: Record<VerdictState, number> = {
    VERIFIED: 0,
    STALE: 0,
    ASSERTED: 0,
    UNKNOWN: 0,
    FAILING: 0,
  };
  for (const b of behaviors.filter((x) => x.status === 'active')) {
    const v: Verdict = computeVerdict(b, evidence, ctx);
    verdictHistogram[v.state]++;
  }

  return {
    health,
    ingestors,
    counts: {
      behaviors: behaviors.length,
      confirmed: behaviors.filter((b) => b.confirmed_by !== undefined).length,
      evidence: evidence.length,
      questionsOpen: questions.filter((q) => q.status === 'open').length,
      quarantined: evidence.filter((e) => e.redaction.status === 'quarantined').length,
      receipts: ledger.allRecords('receipts').length,
    },
    verdictHistogram,
  };
}
