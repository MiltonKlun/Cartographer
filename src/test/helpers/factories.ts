// Record factories for tests — one place to build valid Behavior/Evidence/
// Question/Session/Receipt records, so a schema change touches one file
// instead of a dozen inline literals. Every factory returns a valid record
// (passes assertValid); pass overrides to vary one field.
import type { Behavior, Evidence, Question, Receipt, Session } from '../../types.js';

let seq = 0;
/** Monotonic id helper for tests that need several distinct ids. */
export function nextSeq(): number {
  return ++seq;
}

export function makeBehavior(over: Partial<Behavior> = {}): Behavior {
  return {
    id: 'BHV-0001',
    statement: 'A viewer-role user cannot bulk-delete records',
    area: 'permissions/records',
    criticality: 'red',
    links: {},
    confirmed_by: { person: 'ana', at: '2026-06-01T00:00:00Z' },
    created_by: 'interview',
    status: 'active',
    ...over,
  };
}

/** A behavior with no confirmed_by — an unconfirmed proposal (I3). */
export function makeProposal(over: Partial<Behavior> = {}): Behavior {
  const b = makeBehavior({ created_by: 'import', ...over });
  delete b.confirmed_by;
  return b;
}

export function makeEvidence(over: Partial<Evidence> = {}): Evidence {
  return {
    id: 'EV-0001',
    behavior_ids: ['BHV-0001'],
    kind: 'test_run',
    outcome: 'supports',
    observed_at: '2026-06-10T00:00:00Z',
    source: { type: 'ci', ref: 'run 1' },
    redaction: { status: 'clean', rules_hit: [] },
    link_confidence: 'high',
    ingested_by: 'ingest:playwright-json@1',
    ...over,
  };
}

export function makeQuestion(over: Partial<Question> = {}): Question {
  return {
    id: 'Q-0001',
    behavior_id: null,
    prompt: 'Should viewer role be able to export records?',
    why_asked: 'gap: PR #412 adds /export endpoint; no behavior matches src/records/export.ts',
    status: 'open',
    ...over,
  };
}

export function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: 'SES-0001',
    engineer: 'ana',
    started_at: '2026-06-11T14:00:00Z',
    ended_at: null,
    observations: [],
    proposals: { behaviors: [], tests: [], questions: [] },
    status: 'open',
    ...over,
  };
}

export function makeReceipt(over: Partial<Receipt> = {}): Receipt {
  return {
    id: 'ACT-0001',
    class: 'selector_heal',
    target: 'tests/checkout.spec.ts::applies coupon',
    summary: "locator '#apply' → getByRole('button', {name: 'Apply'})",
    evidence_basis: ['EV-9388 (failing)', 'EV-9391 (green re-run)'],
    revert: 'git apply -R receipts/ACT-0001.patch',
    performed_at: '2026-06-09T03:20:00Z',
    performed_by: 'cartographer@0.1',
    ...over,
  };
}

/** Days before a reference ISO timestamp, in the ledger's second-precision form. */
export function daysBefore(iso: string, days: number): string {
  return new Date(Date.parse(iso) - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
