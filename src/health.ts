// Health (CG-2.3, I6): a stale map is worse than no map. Ingestion failures
// degrade LOUDLY — computeHealth feeds the renderer's banner on every
// surface. Per-ingestor last-success comes from the mutations log (the
// ingestor is the mutation actor), so health needs no extra bookkeeping.
import { type Clock } from './clock.js';
import type { Ledger } from './db.js';
import type { Health } from './renderer.js';
import { computeVerdict, type VerdictContext } from './decay.js';
import type { Behavior, Evidence, Question, Verdict, VerdictState } from './types.js';

export interface IngestorStatus {
  ingestor: string;
  lastSuccess: string;
  staleHours: number;
  withinSla: boolean;
}

export interface StatusReport {
  health: Health;
  ingestors: IngestorStatus[];
  counts: { behaviors: number; confirmed: number; evidence: number; questionsOpen: number; quarantined: number; receipts: number };
  verdictHistogram: Record<VerdictState, number>;
}

export const DEFAULT_SLA_HOURS = 26; // daily CI + slack; tune at adoption

const MS_PER_HOUR = 3_600_000;

export function computeHealth(ledger: Ledger, clock: Clock, slaHours = DEFAULT_SLA_HOURS): { health: Health; ingestors: IngestorStatus[] } {
  const lastByIngestor = new Map<string, string>();
  for (const m of ledger.allMutations()) {
    if (!m.actor.startsWith('ingest:')) continue;
    const prev = lastByIngestor.get(m.actor);
    if (!prev || m.at > prev) lastByIngestor.set(m.actor, m.at);
  }

  const now = clock().getTime();
  const ingestors: IngestorStatus[] = [...lastByIngestor.entries()]
    .map(([ingestor, lastSuccess]) => {
      const staleHours = (now - new Date(lastSuccess).getTime()) / MS_PER_HOUR;
      return { ingestor, lastSuccess, staleHours, withinSla: staleHours <= slaHours };
    })
    .sort((a, b) => a.ingestor.localeCompare(b.ingestor));

  const stale = ingestors.filter((i) => !i.withinSla);
  if (stale.length === 0) return { health: { degraded: false }, ingestors };
  const worst = stale.reduce((a, b) => (a.staleHours > b.staleHours ? a : b));
  return {
    health: {
      degraded: true,
      reason: `${worst.ingestor} has not ingested for ${Math.floor(worst.staleHours)}h (SLA ${slaHours}h)`,
      since: worst.lastSuccess,
    },
    ingestors,
  };
}

export function computeStatus(ledger: Ledger, ctx: VerdictContext, slaHours = DEFAULT_SLA_HOURS): StatusReport {
  const { health, ingestors } = computeHealth(ledger, ctx.clock, slaHours);

  const behaviors = ledger.allRecords('behaviors') as Behavior[];
  const evidence = ledger.allRecords('evidence') as Evidence[];
  const questions = ledger.allRecords('questions') as Question[];

  const verdictHistogram: Record<VerdictState, number> = {
    VERIFIED: 0,
    STALE: 0,
    ASSERTED: 0,
    UNKNOWN: 0,
    VIOLATED: 0,
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
