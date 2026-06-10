// Ingestion orchestrator (SPEC §6): parse → REDACT → validate → link → write.
// Ingestors are the only write path into the vault and ledger (I10). The
// whole batch runs as one ACT through the autonomy gateway, so a receipt is
// written in the same transaction as the evidence rows (I4). Idempotent:
// dedupe key = source ref + artifact hash.
import type { Ledger } from './db.js';
import type { AutonomyGateway } from './autonomy.js';
import { linkEvidence, type TestRef } from './linking.js';
import { redactText, scanBuffer, type RedactionRule } from './redaction.js';
import { vaultWrite, sha256Hex } from './vault.js';
import type { Behavior, Evidence } from './types.js';

export interface EvidenceCandidate {
  testRef: TestRef;
  kind: Evidence['kind'];
  outcome: Evidence['outcome'];
  observed_at: string;
  source: Evidence['source'];
  /** Raw artifact content; strings are scrubbed, Buffers can only be quarantined whole. */
  content: string | Buffer;
  media_type: string;
  ingested_by: string;
}

export interface IngestSummary {
  created: string[];
  duplicates: string[];
  quarantined: string[];
  linked: number;
  unlinked: number;
  receiptId: string;
}

export interface IngestOptions {
  vaultRoot: string;
  rules: RedactionRule[];
}

export function ingestCandidates(
  ledger: Ledger,
  gateway: AutonomyGateway,
  candidates: EvidenceCandidate[],
  opts: IngestOptions,
): IngestSummary {
  const behaviors = ledger.allRecords('behaviors') as Behavior[];
  const summary: Omit<IngestSummary, 'receiptId'> = {
    created: [],
    duplicates: [],
    quarantined: [],
    linked: 0,
    unlinked: 0,
  };

  const sourceRef = candidates[0]?.source.ref ?? 'empty';
  const result = gateway.perform({
    class: 'evidence_ingest',
    target: sourceRef,
    summary: `ingest ${candidates.length} result(s) from ${sourceRef}`,
    evidence_basis: [],
    revert: 'none needed — evidence is append-only and re-ingest is deduplicated',
    execute: () => {
      for (const c of candidates) {
        // idempotence first: source ref + hash of the ORIGINAL artifact (SPEC §6)
        const dedupeKey = `${c.source.ref}|${c.testRef.testId}|${sha256Hex(c.content)}`;
        const existing = ledger.findEvidenceIdByDedupeKey(dedupeKey);
        if (existing) {
          summary.duplicates.push(existing);
          continue;
        }

        // redaction stage — non-optional (I10)
        let redaction: Evidence['redaction'];
        let artifact: Evidence['artifact'] | undefined;
        if (typeof c.content === 'string') {
          const r = redactText(c.content, opts.rules);
          redaction = { status: r.status, rules_hit: r.rules_hit };
          if (r.status !== 'quarantined') {
            const ref = vaultWrite(opts.vaultRoot, r.text);
            artifact = { vault_path: ref.vault_path, media_type: c.media_type };
          }
        } else {
          const scan = scanBuffer(c.content, opts.rules);
          redaction = {
            status: scan.quarantined ? 'quarantined' : 'clean',
            rules_hit: scan.rules_hit,
          };
          if (!scan.quarantined) {
            const ref = vaultWrite(opts.vaultRoot, c.content);
            artifact = { vault_path: ref.vault_path, media_type: c.media_type };
          }
        }

        const link = linkEvidence(behaviors, c.testRef);
        const evidence: Evidence = {
          id: ledger.nextId('evidence'),
          behavior_ids: link.behavior_ids,
          kind: c.kind,
          outcome: c.outcome,
          observed_at: c.observed_at,
          source: c.source,
          ...(artifact ? { artifact } : {}),
          redaction,
          link_confidence: link.link_confidence,
          ingested_by: c.ingested_by,
        };
        ledger.insertEvidence(evidence, c.ingested_by, dedupeKey);

        summary.created.push(evidence.id);
        if (redaction.status === 'quarantined') summary.quarantined.push(evidence.id);
        if (link.behavior_ids.length > 0) summary.linked++;
        else summary.unlinked++;
      }
    },
  });

  if (result.tier !== 'ACT') throw new Error('evidence_ingest must be ACT-tier (SPEC §9)');
  return { ...summary, receiptId: result.receipt.id };
}
