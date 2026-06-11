// ingest:session@1 (CG-8.3, SPEC §6, decision 0001) — the ET-Kit seam.
// Parses an ET-Kit session sheet (markdown) and lands its findings in the
// ledger, mapping per the SPEC §6 contract:
//   BUG/ISSUE  → EV(kind: manual_observation, outcome: violates)
//   QUESTION   → draft Q record
//   IDEA       → session proposal (text, for human review)
// Referenced evidence files pass through the SAME redaction stage before
// vaulting (I10). Native cart-session stop payloads share the same back end.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { type Clock, isoNow } from './clock.js';
import type { Ledger } from './db.js';
import type { AutonomyGateway } from './autonomy.js';
import { redactText, scanBuffer, type RedactionRule } from './redaction.js';
import { vaultWrite } from './vault.js';
import type { Behavior, Evidence, Question, Session } from './types.js';

export type SheetTag = 'BUG' | 'ISSUE' | 'QUESTION' | 'IDEA';

export interface SheetObservation {
  time: string;
  tag: SheetTag;
  note: string;
  oracle?: string;
  evidenceRef?: string;
}

export interface ParsedSheet {
  sessionId?: string;
  engineer?: string;
  date?: string;
  observations: SheetObservation[];
}

const VALID_TAGS = new Set<SheetTag>(['BUG', 'ISSUE', 'QUESTION', 'IDEA']);
// observation log row: HH:MM | TAG | note | oracle | evidence-ref
// (oracle and evidence-ref are optional; markdown table pipes tolerated)
const ROW = /^\|?\s*(\d{1,2}:\d{2})\s*\|\s*([A-Z]+)\s*\|\s*([^|]+?)\s*(?:\|\s*([^|]*?)\s*)?(?:\|\s*([^|]*?)\s*)?\|?\s*$/;

const META = {
  sessionId: /(?:Session ID|session)\s*[:*]*\s*(ET-[\w-]+|SES-\d+)/i,
  engineer: /(?:Tester|engineer)\s*\(?(?:human)?\)?\s*[:*]*\s*([A-Za-z][\w .'-]*)/i,
  // "Date" then the first ISO date that follows (tolerates "Date / timebox:")
  date: /\bDate\b[^\n]*?(\d{4}-\d{2}-\d{2})/i,
};

export function parseSessionSheet(markdown: string): ParsedSheet {
  const sheet: ParsedSheet = { observations: [] };
  const sid = META.sessionId.exec(markdown);
  if (sid?.[1]) sheet.sessionId = sid[1];
  const eng = META.engineer.exec(markdown);
  if (eng?.[1]) sheet.engineer = eng[1].trim();
  const date = META.date.exec(markdown);
  if (date?.[1]) sheet.date = date[1];

  for (const line of markdown.split('\n')) {
    const m = ROW.exec(line.trim());
    if (!m) continue;
    const tag = (m[2] ?? '').toUpperCase();
    if (!VALID_TAGS.has(tag as SheetTag)) continue; // skip table headers / non-tag rows
    const note = (m[3] ?? '').trim();
    if (!note || /^-+$/.test(note)) continue;
    sheet.observations.push({
      time: m[1] ?? '',
      tag: tag as SheetTag,
      note,
      ...(m[4] && m[4].trim() && !/^-+$/.test(m[4].trim()) ? { oracle: m[4].trim() } : {}),
      ...(m[5] && m[5].trim() && !/^-+$/.test(m[5].trim()) ? { evidenceRef: m[5].trim() } : {}),
    });
  }
  return sheet;
}

export interface SessionImportOptions {
  vaultRoot: string;
  rules: RedactionRule[];
  /** Directory the sheet's evidence-ref paths are relative to. */
  baseDir: string;
  clock: Clock;
}

export interface SessionImportSummary {
  sessionId: string;
  evidenceCreated: string[];
  quarantined: string[];
  questionsQueued: string[];
  ideaProposals: string[];
  receiptId: string;
}

const DATE_AT = (date: string | undefined, time: string, clock: Clock): string => {
  if (date) return `${date}T${time.padStart(5, '0')}:00Z`;
  return isoNow(clock);
};

/**
 * Import a parsed sheet through the autonomy gateway as one ACT (receipt in
 * the same transaction). BUG/ISSUE become violating manual-observation
 * evidence (artifact redacted/vaulted if a readable evidence file is
 * referenced); QUESTION become open Q records; IDEA become session proposals.
 */
export function importSessionSheet(
  ledger: Ledger,
  gateway: AutonomyGateway,
  sheet: ParsedSheet,
  opts: SessionImportOptions,
): SessionImportSummary {
  const behaviors = ledger.allRecords('behaviors') as Behavior[];
  const engineer = sheet.engineer || 'et-kit';
  const summary: Omit<SessionImportSummary, 'receiptId'> = {
    sessionId: '',
    evidenceCreated: [],
    quarantined: [],
    questionsQueued: [],
    ideaProposals: [],
  };

  const result = gateway.perform({
    class: 'evidence_ingest',
    target: sheet.sessionId ?? 'et-kit session',
    summary: `import ET-Kit session sheet ${sheet.sessionId ?? '(unnamed)'}: ${sheet.observations.length} observation(s)`,
    evidence_basis: [],
    revert: 'none — evidence/questions are append-only; a re-import creates new ids',
    execute: () => {
      const session: Session = {
        id: ledger.nextId('session'),
        engineer,
        started_at: DATE_AT(sheet.date, sheet.observations[0]?.time ?? '00:00', opts.clock),
        ended_at: isoNow(opts.clock),
        observations: sheet.observations.map((o) => ({
          at: DATE_AT(sheet.date, o.time, opts.clock),
          note: `[${o.tag}] ${o.note}`,
          auto: false,
        })),
        proposals: { behaviors: [], tests: [], questions: [] },
        status: 'in_review',
      };
      summary.sessionId = session.id;

      const ideaProposals: string[] = [];
      const queuedQuestions: string[] = [];

      for (const obs of sheet.observations) {
        if (obs.tag === 'BUG' || obs.tag === 'ISSUE') {
          const evidence = sheetObservationToEvidence(ledger, behaviors, obs, sheet, opts);
          summary.evidenceCreated.push(evidence.id);
          if (evidence.redaction.status === 'quarantined') summary.quarantined.push(evidence.id);
        } else if (obs.tag === 'QUESTION') {
          const q: Question = {
            id: ledger.nextId('question'),
            behavior_id: null,
            prompt: obs.note.endsWith('?') ? obs.note : `${obs.note}?`,
            why_asked: `raised in ET-Kit session ${sheet.sessionId ?? session.id}${obs.oracle ? ` (oracle: ${obs.oracle})` : ''}`,
            status: 'open',
          };
          ledger.insertQuestion(q, engineer);
          summary.questionsQueued.push(q.id);
          queuedQuestions.push(q.id);
        } else {
          ideaProposals.push(`idea: ${obs.note}`);
          summary.ideaProposals.push(obs.note);
        }
      }

      session.proposals = { behaviors: [], tests: ideaProposals, questions: queuedQuestions };
      ledger.insertSession(session, engineer);
    },
  });

  if (result.tier !== 'ACT') throw new Error('session import must be ACT-tier');
  return { ...summary, receiptId: result.receipt.id };
}

function sheetObservationToEvidence(
  ledger: Ledger,
  behaviors: Behavior[],
  obs: SheetObservation,
  sheet: ParsedSheet,
  opts: SessionImportOptions,
): Evidence {
  // link via the oracle's BHV-id if present, else leave unlinked (I3)
  const bhv = /BHV-\d{4,}/.exec(`${obs.oracle ?? ''} ${obs.note}`)?.[0];
  const linked = bhv && behaviors.some((b) => b.id === bhv) ? [bhv] : [];

  let redaction: Evidence['redaction'] = { status: 'clean', rules_hit: [] };
  let artifact: Evidence['artifact'] | undefined;

  if (obs.evidenceRef) {
    const abs = isAbsolute(obs.evidenceRef) ? obs.evidenceRef : join(opts.baseDir, obs.evidenceRef);
    if (existsSync(abs)) {
      const buf = readFileSync(abs);
      const isText = /\.(txt|md|log|json|har|csv|html?)$/i.test(abs);
      if (isText) {
        const r = redactText(buf.toString('utf8'), opts.rules);
        redaction = { status: r.status, rules_hit: r.rules_hit };
        if (r.status !== 'quarantined') {
          const ref = vaultWrite(opts.vaultRoot, r.text);
          artifact = { vault_path: ref.vault_path, media_type: 'text/plain' };
        }
      } else {
        const scan = scanBuffer(buf, opts.rules);
        redaction = { status: scan.quarantined ? 'quarantined' : 'clean', rules_hit: scan.rules_hit };
        if (!scan.quarantined) {
          const ref = vaultWrite(opts.vaultRoot, buf);
          artifact = { vault_path: ref.vault_path, media_type: 'application/octet-stream' };
        }
      }
    }
  }

  const evidence: Evidence = {
    id: ledger.nextId('evidence'),
    behavior_ids: linked,
    kind: 'manual_observation',
    outcome: 'violates', // BUG/ISSUE per SPEC §6
    observed_at: DATE_AT(sheet.date, obs.time, opts.clock),
    source: { type: 'session', ref: sheet.sessionId ?? 'et-kit' },
    ...(artifact ? { artifact } : {}),
    redaction,
    link_confidence: 'low', // human-proposed link until confirmed (I3)
    ingested_by: 'ingest:session@1',
  };
  ledger.insertEvidence(evidence, 'ingest:session@1');
  return evidence;
}
