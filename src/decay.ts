// The decay engine (SPEC §4) — the ONLY constructor of verdict objects (I2).
// Hard rule first: newest violating evidence newer than newest supporting
// ⇒ FAILING, regardless of freshness. Otherwise:
//
//   F = exp(-Δt_days / τ_time(criticality)) × exp(-churn / τ_churn) × W(link_confidence)
//
// All constants live in config/decay.json; changing them requires a decision
// note (Constitution §5). All time comes from the injected clock — no
// Date.now() anywhere in decay logic (BUILD-PLAN rule 5).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Clock, isoNow } from './clock.js';
import { configDir } from './paths.js';
import type { ChurnIndex } from './churn.js';
import type { Behavior, Confidence, Criticality, Evidence, Verdict } from './types.js';

export interface DecayConfig {
  tau_time_days: Record<Criticality, number>;
  tau_churn_lines: number;
  link_confidence_weight: Record<Confidence, number>;
  thresholds: { verified_min: number; stale_min: number };
}

export function loadDecayConfig(path?: string): DecayConfig {
  const file = path ?? join(configDir, 'decay.json');
  return JSON.parse(readFileSync(file, 'utf8')) as DecayConfig;
}

const MS_PER_DAY = 86_400_000;

/** Conclusive (supports/violates), non-superseded evidence for this behavior. */
function conclusiveEvidence(behavior: Behavior, evidence: Evidence[]): Evidence[] {
  const superseded = new Set(evidence.map((e) => e.supersedes).filter(Boolean));
  return evidence.filter(
    (e) =>
      e.behavior_ids.includes(behavior.id) &&
      !superseded.has(e.id) &&
      (e.outcome === 'supports' || e.outcome === 'violates'),
  );
}

function newest(evidence: Evidence[]): Evidence | undefined {
  return [...evidence].sort((a, b) => b.observed_at.localeCompare(a.observed_at))[0];
}

export interface VerdictContext {
  config: DecayConfig;
  churn: ChurnIndex;
  clock: Clock;
}

export function freshnessOf(
  behavior: Behavior,
  supporting: Evidence,
  ctx: VerdictContext,
): number {
  const ageMs = ctx.clock().getTime() - new Date(supporting.observed_at).getTime();
  const ageDays = Math.max(0, ageMs / MS_PER_DAY);
  const tauTime = ctx.config.tau_time_days[behavior.criticality];
  const timeFactor = Math.exp(-ageDays / tauTime);

  const globs = behavior.links.implemented_in ?? [];
  const churnLines = ctx.churn.linesChangedSince(globs, supporting.observed_at);
  const churnFactor = Math.exp(-churnLines / ctx.config.tau_churn_lines);

  const weight = ctx.config.link_confidence_weight[supporting.link_confidence];
  return timeFactor * churnFactor * weight;
}

/**
 * The single verdict constructor. Order of rules:
 *   1. unconfirmed behavior        → UNKNOWN (meaning is human, I3)
 *   2. newest violates > supports  → FAILING (hard rule, ignores freshness)
 *   3. zero conclusive evidence    → ASSERTED
 *   4. freshness thresholds        → VERIFIED / STALE / UNKNOWN
 */
export function computeVerdict(
  behavior: Behavior,
  evidence: Evidence[],
  ctx: VerdictContext,
): Verdict {
  const computed_at = isoNow(ctx.clock);
  const relevant = conclusiveEvidence(behavior, evidence);
  const newestAny = newest(relevant);

  if (!behavior.confirmed_by) {
    return { state: 'UNKNOWN', freshness: 0, computed_at, newest_evidence_id: newestAny?.id ?? null };
  }

  const newestSupports = newest(relevant.filter((e) => e.outcome === 'supports'));
  const newestViolates = newest(relevant.filter((e) => e.outcome === 'violates'));

  if (
    newestViolates &&
    (!newestSupports || newestViolates.observed_at > newestSupports.observed_at)
  ) {
    const freshness = freshnessOf(behavior, newestViolates, ctx);
    return { state: 'FAILING', freshness, computed_at, newest_evidence_id: newestViolates.id };
  }

  if (!newestSupports) {
    return { state: 'ASSERTED', freshness: 0, computed_at, newest_evidence_id: null };
  }

  const freshness = freshnessOf(behavior, newestSupports, ctx);
  const { verified_min, stale_min } = ctx.config.thresholds;
  const state = freshness >= verified_min ? 'VERIFIED' : freshness >= stale_min ? 'STALE' : 'UNKNOWN';
  return { state, freshness, computed_at, newest_evidence_id: newestSupports.id };
}
