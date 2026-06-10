// `cart` — Phase 0 CLI: init, behavior add/confirm/list, validate, claim
// (renderer demo), export. Every mutation flows through the validated ledger;
// every side effect through the autonomy gateway; every human-facing claim
// through the claims renderer. No bypass paths.
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Ledger } from './db.js';
import { AutonomyGateway } from './autonomy.js';
import { QueryApi } from './query.js';
import { renderClaims, type Claim } from './renderer.js';
import { exportLedgerToFile } from './export.js';
import { isRecordType, validateRecord } from './validate.js';
import { ingestCandidates } from './ingest.js';
import { parsePlaywrightReport } from './ingest-playwright.js';
import { parseJunitReport } from './ingest-junit.js';
import { loadRedactionRules } from './redaction.js';
import { vaultOrphans, vaultAbsPath } from './vault.js';
import { isoNow, systemClock, fixedClock, type Clock } from './clock.js';
import { computeVerdict, loadDecayConfig } from './decay.js';
import { GitChurnIndex, NullChurnIndex } from './churn.js';
import { computeHealth, computeStatus, DEFAULT_SLA_HOURS } from './health.js';
import { assembleAsk, renderAsk, queueGapQuestion } from './ask.js';
import type { Behavior, Criticality, Evidence } from './types.js';

const HEALTH_OK = { degraded: false } as const;

/** --now is a demo/test affordance (injected clock); production omits it. */
function clockFrom(values: { now?: string }): Clock {
  return values.now ? fixedClock(values.now) : systemClock;
}

function churnFrom(values: { repo?: string }): GitChurnIndex | NullChurnIndex {
  return values.repo ? new GitChurnIndex(values.repo) : new NullChurnIndex();
}

function dbPath(values: { db?: string }): string {
  return values.db ?? process.env['CART_DB'] ?? join(process.cwd(), 'ledger.db');
}

function actor(values: { actor?: string }): string {
  return values.actor ?? process.env['CART_ACTOR'] ?? 'manual';
}

function fail(message: string): never {
  console.error(`cart: ${message}`);
  process.exit(1);
}

const USAGE = `cart — Cartographer behavior ledger (Phase 0)

  cart init                                   create ledger.db (idempotent)
  cart ask "<question>" [--queue]             the 30-second answer, evidence-cited (UNKNOWN when unmapped)
  cart behavior add --statement S --area A    add a behavior proposal
       [--criticality red|high|normal|low] [--implemented-in glob,glob]
       [--verified-by test_id,test_id] [--actor name]
  cart behavior confirm <BHV-id> --person P   confirm a behavior (I3)
  cart behavior list [--area A]               list behaviors (via claims renderer)
  cart validate <type> <file.json>            validate a record against its schema
  cart claim --text T [--cite ID,ID] [--inference] [--unknown]
                                              render a claim (refused without citations — I1)
  cart export [--out export/ledger.jsonl]     deterministic JSONL export (ACT, receipted)
  cart ingest playwright <report.json> [--ref R]
  cart ingest junit <report.xml> [--ref R]     CI results → evidence (redacted, linked, deduped)
  cart vault gc [--apply]                      list orphan blobs; delete only with --apply (receipted)
  cart verdict <BHV-id> [--repo <dir>]         compute + render the decayed verdict (I2)
  cart status [--sla hours]                    ingestion health, counts, verdict histogram (I6)

  Global: --db <path> (default ./ledger.db or CART_DB), --vault <dir> (default ./vault or CART_VAULT)`;

function vaultRoot(values: { vault?: string }): string {
  return values.vault ?? process.env['CART_VAULT'] ?? join(process.cwd(), 'vault');
}

function cmdIngest(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: {
      db: { type: 'string' },
      vault: { type: 'string' },
      ref: { type: 'string' },
    },
    allowPositionals: true,
  });
  const [format, file] = positionals;
  if (!format || !file) fail('usage: cart ingest <playwright|junit> <report> [--ref R]');
  const parseOpts = {
    ...(values.ref !== undefined ? { ref: values.ref } : {}),
    fallbackObservedAt: isoNow(systemClock),
  };
  let candidates;
  if (format === 'playwright') candidates = parsePlaywrightReport(file, parseOpts);
  else if (format === 'junit') candidates = parseJunitReport(file, parseOpts);
  else return fail(`unknown ingest format "${format}" — playwright or junit`);

  const ledger = new Ledger(dbPath(values));
  try {
    const gateway = new AutonomyGateway(ledger);
    const summary = ingestCandidates(ledger, gateway, candidates, {
      vaultRoot: vaultRoot(values),
      rules: loadRedactionRules(),
    });
    console.log(
      `ingested ${summary.created.length} evidence record(s) ` +
        `(${summary.linked} linked, ${summary.unlinked} unlinked, ${summary.quarantined.length} quarantined), ` +
        `${summary.duplicates.length} duplicate(s) skipped — receipt ${summary.receiptId}`,
    );
    for (const id of summary.created) console.log(`  + ${id}`);
    if (summary.quarantined.length > 0) {
      console.log(`  quarantined (metadata-only, blob NOT stored — I10): ${summary.quarantined.join(', ')}`);
    }
  } finally {
    ledger.close();
  }
}

function cmdAsk(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: {
      db: { type: 'string' },
      repo: { type: 'string' },
      now: { type: 'string' },
      queue: { type: 'boolean', default: false },
      actor: { type: 'string' },
    },
    allowPositionals: true,
  });
  const question = positionals.join(' ').trim();
  if (!question) fail('usage: cart ask "<question>" [--queue]');
  const ledger = new Ledger(dbPath(values));
  try {
    const clock = clockFrom(values);
    const api = new QueryApi(ledger, { config: loadDecayConfig(), churn: churnFrom(values), clock });
    const result = assembleAsk(api, question);
    console.log(renderAsk(result));
    if ((!result.mapViable || result.partial) && values.queue) {
      const q = queueGapQuestion(ledger, question, actor(values), clock);
      console.log(`queued ${q.id}: "${q.prompt}" — answer it via the interview to grow the map`);
    }
  } finally {
    ledger.close();
  }
}

function cmdVerdict(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: {
      db: { type: 'string' },
      repo: { type: 'string' },
      now: { type: 'string' },
    },
    allowPositionals: true,
  });
  const id = positionals[0];
  if (!id) fail('usage: cart verdict <BHV-id> [--repo <dir>]');
  const ledger = new Ledger(dbPath(values));
  try {
    const behavior = ledger.getBehavior(id);
    if (!behavior) fail(`no such behavior: ${id}`);
    const clock = clockFrom(values);
    const ctx = { config: loadDecayConfig(), churn: churnFrom(values), clock };
    const verdict = computeVerdict(behavior, ledger.allRecords('evidence') as Evidence[], ctx);
    const { health } = computeHealth(ledger, clock);
    const citations = [behavior.id, ...(verdict.newest_evidence_id ? [verdict.newest_evidence_id] : [])];
    const claim: Claim = {
      text: `${behavior.statement}  [${behavior.criticality}]${behavior.confirmed_by ? '' : '  [unconfirmed]'}`,
      citations,
      verdict,
    };
    console.log(renderClaims([claim], health));
  } finally {
    ledger.close();
  }
}

function cmdStatus(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      db: { type: 'string' },
      repo: { type: 'string' },
      now: { type: 'string' },
      sla: { type: 'string' },
    },
  });
  const ledger = new Ledger(dbPath(values));
  try {
    const clock = clockFrom(values);
    const ctx = { config: loadDecayConfig(), churn: churnFrom(values), clock };
    const sla = values.sla ? Number(values.sla) : DEFAULT_SLA_HOURS;
    const report = computeStatus(ledger, ctx, sla);

    const lines: string[] = [];
    lines.push(`cart status — ${isoNow(clock)}`);
    lines.push(report.health.degraded ? `health: DEGRADED — ${report.health.reason}` : 'health: OK');
    lines.push('ingestors:');
    if (report.ingestors.length === 0) lines.push('  (none have run yet)');
    for (const i of report.ingestors) {
      lines.push(`  ${i.ingestor}  last success ${i.lastSuccess}  ${i.withinSla ? 'OK' : `STALE (${Math.floor(i.staleHours)}h > ${sla}h SLA)`}`);
    }
    const c = report.counts;
    lines.push(`records: ${c.behaviors} behaviors (${c.confirmed} confirmed) · ${c.evidence} evidence (${c.quarantined} quarantined) · ${c.questionsOpen} open questions · ${c.receipts} receipts`);
    const h = report.verdictHistogram;
    lines.push(`verdicts: VERIFIED ${h.VERIFIED} · STALE ${h.STALE} · ASSERTED ${h.ASSERTED} · UNKNOWN ${h.UNKNOWN} · VIOLATED ${h.VIOLATED}`);
    console.log(lines.join('\n'));
  } finally {
    ledger.close();
  }
}

function cmdVaultGc(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      db: { type: 'string' },
      vault: { type: 'string' },
      apply: { type: 'boolean', default: false },
    },
  });
  const root = vaultRoot(values);
  const ledger = new Ledger(dbPath(values));
  try {
    const referenced = new Set(
      (ledger.allRecords('evidence') as Evidence[])
        .map((e) => e.artifact?.vault_path)
        .filter((p): p is string => p !== undefined),
    );
    const orphans = vaultOrphans(root, referenced);
    if (orphans.length === 0) {
      console.log('vault gc: no orphan blobs');
      return;
    }
    if (!values.apply) {
      console.log(`vault gc (dry run): ${orphans.length} orphan blob(s) — pass --apply to delete with receipt`);
      for (const p of orphans) console.log(`  ${p}`);
      return;
    }
    const gateway = new AutonomyGateway(ledger);
    const result = gateway.perform({
      class: 'vault_gc',
      target: root,
      summary: `delete ${orphans.length} orphan blob(s): ${orphans.join(', ')}`,
      evidence_basis: [],
      revert: 'restore vault/ from backup; blobs are content-addressed so paths are reproducible',
      execute: () => {
        for (const p of orphans) unlinkSync(vaultAbsPath(root, p));
      },
    });
    if (result.tier === 'ACT') {
      console.log(`vault gc: deleted ${orphans.length} orphan blob(s) (receipt ${result.receipt.id})`);
    }
  } finally {
    ledger.close();
  }
}

function cmdInit(args: string[]): void {
  const { values } = parseArgs({ args, options: { db: { type: 'string' } } });
  const path = dbPath(values);
  const fresh = !existsSync(path);
  new Ledger(path).close();
  console.log(`${fresh ? 'created' : 'opened'} ledger at ${path} (migrations applied)`);
}

function cmdBehaviorAdd(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      db: { type: 'string' },
      statement: { type: 'string' },
      area: { type: 'string' },
      criticality: { type: 'string', default: 'normal' },
      'implemented-in': { type: 'string' },
      'verified-by': { type: 'string' },
      'created-by': { type: 'string', default: 'manual' },
      actor: { type: 'string' },
    },
  });
  if (!values.statement || !values.area) fail('behavior add requires --statement and --area');
  const ledger = new Ledger(dbPath(values));
  try {
    const behavior: Behavior = {
      id: ledger.nextId('behavior'),
      statement: values.statement,
      area: values.area,
      criticality: values.criticality as Criticality,
      links: {
        ...(values['implemented-in']
          ? { implemented_in: values['implemented-in'].split(',').map((s) => s.trim()) }
          : {}),
        ...(values['verified-by']
          ? {
              verified_by: values['verified-by']
                .split(',')
                .map((s) => ({ test_id: s.trim(), confidence: 'high' as const })),
            }
          : {}),
      },
      created_by: values['created-by'] as Behavior['created_by'],
      status: 'active',
    };
    ledger.insertBehavior(behavior, actor(values));
    console.log(`${behavior.id} created (unconfirmed proposal — confirm with: cart behavior confirm ${behavior.id} --person <you>)`);
  } finally {
    ledger.close();
  }
}

function cmdBehaviorConfirm(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: { db: { type: 'string' }, person: { type: 'string' } },
    allowPositionals: true,
  });
  const id = positionals[0];
  if (!id) fail('behavior confirm requires a BHV id');
  if (!values.person) fail('behavior confirm requires --person (attribution, I11)');
  const ledger = new Ledger(dbPath(values));
  try {
    const person = values.person;
    const updated = ledger.updateBehavior(
      id,
      (b) => ({ ...b, confirmed_by: { person, at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') } }),
      person,
    );
    console.log(`${updated.id} confirmed by ${person} at ${updated.confirmed_by?.at}`);
  } finally {
    ledger.close();
  }
}

function cmdBehaviorList(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: { db: { type: 'string' }, area: { type: 'string' } },
  });
  const ledger = new Ledger(dbPath(values));
  try {
    const api = new QueryApi(ledger, { config: loadDecayConfig(), churn: new NullChurnIndex(), clock: systemClock });
    const filter = values.area !== undefined ? { area: values.area } : {};
    const behaviors = api.findBehaviors(filter);
    if (behaviors.length === 0) {
      console.log('no behaviors in the map yet — a cold map says so instead of lying (I6)');
      return;
    }
    const claims: Claim[] = behaviors.map((b) => ({
      text: `${b.statement}  [${b.criticality}] (${b.area})${b.confirmed_by ? '' : '  [unconfirmed]'}`,
      citations: [b.id],
    }));
    const { health } = computeHealth(ledger, systemClock);
    console.log(renderClaims(claims, health));
  } finally {
    ledger.close();
  }
}

function cmdValidate(args: string[]): void {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
  const [type, file] = positionals;
  if (!type || !file) fail('usage: cart validate <behavior|evidence|question|session|receipt> <file.json>');
  if (!isRecordType(type)) fail(`unknown record type "${type}"`);
  const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const problems = validateRecord(type, data);
  if (problems.length === 0) {
    console.log(`VALID ${type}: ${file}`);
  } else {
    console.error(`INVALID ${type}: ${file}`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
}

function cmdClaim(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      text: { type: 'string' },
      cite: { type: 'string' },
      inference: { type: 'boolean', default: false },
      unknown: { type: 'boolean', default: false },
    },
  });
  if (!values.text) fail('claim requires --text');
  const claim: Claim = { text: values.text };
  if (values.cite) claim.citations = values.cite.split(',').map((s) => s.trim());
  if (values.inference) claim.label = 'inference';
  else if (values.unknown) claim.label = 'unknown';
  console.log(renderClaims([claim], HEALTH_OK));
}

function cmdExport(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: { db: { type: 'string' }, out: { type: 'string' } },
  });
  const outPath = values.out ?? join(process.cwd(), 'export', 'ledger.jsonl');
  const ledger = new Ledger(dbPath(values));
  try {
    const gateway = new AutonomyGateway(ledger);
    let records = 0;
    const result = gateway.perform({
      class: 'export',
      target: outPath,
      summary: 'deterministic JSONL export of the full ledger',
      evidence_basis: [],
      revert: `delete ${outPath}`,
      execute: () => {
        records = exportLedgerToFile(ledger, outPath).records;
      },
    });
    if (result.tier === 'ACT') {
      console.log(`exported ${records} records to ${outPath} (receipt ${result.receipt.id})`);
    }
  } finally {
    ledger.close();
  }
}

export function main(argv: string[]): void {
  const [command, sub, ...rest] = argv;
  try {
    switch (command) {
      case 'init':
        return cmdInit(argv.slice(1));
      case 'behavior':
        if (sub === 'add') return cmdBehaviorAdd(rest);
        if (sub === 'confirm') return cmdBehaviorConfirm(rest);
        if (sub === 'list') return cmdBehaviorList(rest);
        return fail(`unknown behavior subcommand "${sub ?? ''}"\n\n${USAGE}`);
      case 'validate':
        return cmdValidate(argv.slice(1));
      case 'claim':
        return cmdClaim(argv.slice(1));
      case 'export':
        return cmdExport(argv.slice(1));
      case 'ingest':
        return cmdIngest(argv.slice(1));
      case 'vault':
        if (sub === 'gc') return cmdVaultGc(rest);
        return fail(`unknown vault subcommand "${sub ?? ''}"\n\n${USAGE}`);
      case 'ask':
        return cmdAsk(argv.slice(1));
      case 'verdict':
        return cmdVerdict(argv.slice(1));
      case 'status':
        return cmdStatus(argv.slice(1));
      case undefined:
      case 'help':
      case '--help':
        console.log(USAGE);
        return;
      default:
        return fail(`unknown command "${command}"\n\n${USAGE}`);
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
