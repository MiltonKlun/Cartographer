// The claims renderer — the ONLY path from ledger rows to human-facing prose.
// I1: a claim renders only if it cites record IDs or is explicitly labeled
// `inference` or `unknown`. I2: a verdict renders only with state, freshness,
// computed_at and newest_evidence_id. I6: degraded health injects a banner.
// Surfaces cannot bypass this module; if a claim is refused, fix the claim.
import { TIMESTAMP_PATTERN } from './clock.js';
import type { Verdict, VerdictState } from './types.js';

const CITATION_PATTERN = /^(BHV|EV|Q|SES|ACT)-\d{4,}$/;
const VERDICT_STATES: VerdictState[] = ['VERIFIED', 'STALE', 'ASSERTED', 'UNKNOWN', 'VIOLATED'];

export type ClaimLabel = 'inference' | 'unknown';

export interface Claim {
  text: string;
  citations?: string[];
  label?: ClaimLabel;
  verdict?: Verdict;
}

export interface Health {
  degraded: boolean;
  reason?: string;
  since?: string;
}

export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderError';
  }
}

function assertRenderable(claim: Claim): void {
  if (!claim.text || claim.text.trim() === '') {
    throw new RenderError('claim has no text');
  }
  const cited = (claim.citations ?? []).length > 0;
  if (!cited && claim.label === undefined) {
    throw new RenderError(
      `refusing citation-less claim (I1): "${claim.text}" — cite record IDs or label it 'inference'/'unknown'`,
    );
  }
  for (const c of claim.citations ?? []) {
    if (!CITATION_PATTERN.test(c)) {
      throw new RenderError(`citation "${c}" is not a ledger record ID (I1)`);
    }
  }
  if (claim.verdict !== undefined) assertCompleteVerdict(claim.verdict, claim.text);
}

function assertCompleteVerdict(v: Verdict, context: string): void {
  if (!VERDICT_STATES.includes(v.state)) {
    throw new RenderError(`verdict for "${context}" has invalid state "${String(v.state)}" (I2)`);
  }
  if (typeof v.freshness !== 'number' || Number.isNaN(v.freshness) || v.freshness < 0 || v.freshness > 1) {
    throw new RenderError(`verdict for "${context}" lacks a freshness score in [0,1] (I2)`);
  }
  if (typeof v.computed_at !== 'string' || !TIMESTAMP_PATTERN.test(v.computed_at)) {
    throw new RenderError(`verdict for "${context}" lacks a valid computed_at timestamp (I2)`);
  }
  if (v.newest_evidence_id !== null && !CITATION_PATTERN.test(v.newest_evidence_id)) {
    throw new RenderError(`verdict for "${context}" has invalid newest_evidence_id (I2)`);
  }
}

function renderVerdict(v: Verdict): string {
  const evidence = v.newest_evidence_id ?? 'no evidence';
  return `${v.state}  F=${v.freshness.toFixed(2)}  (computed ${v.computed_at}, newest: ${evidence})`;
}

function renderClaim(claim: Claim): string {
  const parts: string[] = [];
  if (claim.label === 'inference') parts.push(`inference: ${claim.text}`);
  else if (claim.label === 'unknown') parts.push(`UNKNOWN: ${claim.text}`);
  else parts.push(claim.text);
  if (claim.verdict) parts.push(renderVerdict(claim.verdict));
  const cites = claim.citations ?? [];
  if (cites.length > 0) parts.push(`[${cites.join(', ')}]`);
  return parts.join('  ');
}

/**
 * Renders claims to terminal-facing lines. Throws RenderError on any
 * invariant violation — all claims are checked before any line is emitted,
 * so a bad claim never produces partial output.
 */
export function renderClaims(claims: Claim[], health: Health): string {
  for (const claim of claims) assertRenderable(claim);
  const lines: string[] = [];
  if (health.degraded) {
    const since = health.since ? ` since ${health.since}` : '';
    const reason = health.reason ?? 'ingestion unhealthy';
    lines.push(`!! HEALTH DEGRADED — ${reason}${since} — verdicts below may be unreliable (I6)`);
  }
  for (const claim of claims) lines.push(renderClaim(claim));
  return lines.join('\n');
}
