// Record types mirroring schemas/ (SPEC §3). Field names are binding for v1.

export type Criticality = 'red' | 'high' | 'normal' | 'low';
export type Confidence = 'high' | 'medium' | 'low';

export interface Behavior {
  id: string;
  statement: string;
  area: string;
  criticality: Criticality;
  links: {
    demanded_by?: string[];
    verified_by?: { test_id: string; confidence: Confidence }[];
    implemented_in?: string[];
    violated_by?: string[];
  };
  confirmed_by?: { person: string; at: string };
  created_by: 'ingest:ci' | 'interview' | 'session' | 'import' | 'manual';
  status: 'active' | 'retired';
  notes?: string;
}

export interface Evidence {
  id: string;
  behavior_ids: string[];
  kind: 'test_run' | 'trace' | 'screenshot' | 'manual_observation' | 'crawl' | 'incident';
  outcome: 'supports' | 'violates' | 'inconclusive';
  observed_at: string;
  source: { type: string; ref: string; url?: string };
  artifact?: { vault_path: string; media_type: string };
  redaction: { status: 'clean' | 'redacted' | 'quarantined'; rules_hit: string[] };
  link_confidence: Confidence;
  ingested_by: string;
  supersedes?: string;
}

export interface Question {
  id: string;
  behavior_id: string | null;
  prompt: string;
  why_asked: string;
  status: 'open' | 'answered' | 'dismissed';
  answer?: { by: string; at: string; text: string };
  resulting_mutations?: string[];
}

export interface Session {
  id: string;
  engineer: string;
  started_at: string;
  ended_at?: string | null;
  observations?: { at: string; note: string; auto: boolean; evidence_id?: string }[];
  proposals?: { behaviors?: string[]; tests?: string[]; questions?: string[] };
  status: 'open' | 'in_review' | 'merged' | 'discarded';
}

export type ReceiptClass =
  | 'selector_heal'
  | 'flake_quarantine'
  | 'flake_ticket'
  | 'pr_comment'
  | 'verdict_recompute'
  | 'evidence_ingest'
  | 'export'
  | 'vault_gc';

export interface Receipt {
  id: string;
  class: ReceiptClass;
  target: string;
  summary: string;
  evidence_basis: string[];
  revert: string;
  performed_at: string;
  performed_by: string;
}

export type RecordType = 'behavior' | 'evidence' | 'question' | 'session' | 'receipt';

export type VerdictState = 'VERIFIED' | 'STALE' | 'ASSERTED' | 'UNKNOWN' | 'FAILING';

// Verdict objects always carry all four fields; the renderer rejects anything
// less (I2). From Phase 2 on, the decay engine is the only constructor.
export interface Verdict {
  state: VerdictState;
  freshness: number;
  computed_at: string;
  newest_evidence_id: string | null;
}
