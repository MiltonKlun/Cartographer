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
import { bootstrapRepo } from './bootstrap.js';
import { applyInterview, pendingProposals, type InterviewItem } from './interview.js';
import { GitDiff, diffFromText } from './diff.js';
import { assembleRiskNote, renderRiskNote, queueGaps } from './pr.js';
import { clusterFailures, renderTriage } from './triage.js';
import { failuresFromPlaywright, failuresFromJunit } from './triage-parse.js';
import {
  loadQuarantine,
  buildEntry,
  upsertEntry,
  removeEntry,
  writeQuarantine,
  expiredEntries,
} from './quarantine.js';
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
  cart pr <ref> [--repo D | --diff F] [--queue] [--post]
                                              risk note: behaviors this change exposes, ranked
  cart triage <report> [--format playwright|junit]
                                              cluster failures, classify, link behaviors, propose repro
  cart quarantine add <test_id> --ticket K [--reason R] [--days N]
  cart quarantine remove <test_id>            non-blocking lane (entry = ACT, receipt; never edits source — I5)
  cart quarantine list [--expired]
  cart bootstrap import <repo> [--apply]      draft one unconfirmed behavior per test (preview unless --apply)
  cart interview --batch N                     list N pending proposals to confirm/edit/merge/discard
  cart interview --apply <answers.json> --person P
                                              apply interview decisions (writes confirmed_by — I3)
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

function quarantinePath(values: { quarantine?: string }): string {
  return values.quarantine ?? process.env['CART_QUARANTINE'] ?? join(process.cwd(), 'quarantine.json');
}

function cmdTriage(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: {
      db: { type: 'string' },
      format: { type: 'string' },
      now: { type: 'string' },
    },
    allowPositionals: true,
  });
  const report = positionals[0];
  if (!report) fail('usage: cart triage <report.json|xml> [--format playwright|junit]');
  if (!existsSync(report)) fail(`no such report: ${report}`);

  const format = values.format ?? (report.endsWith('.xml') ? 'junit' : 'playwright');
  let failures;
  if (format === 'playwright') failures = failuresFromPlaywright(report);
  else if (format === 'junit') failures = failuresFromJunit(report);
  else return fail(`unknown format "${format}" — playwright or junit`);

  const ledger = new Ledger(dbPath(values));
  try {
    const clock = clockFrom(values);
    const behaviors = ledger.allRecords('behaviors') as Behavior[];
    const clusters = clusterFailures(failures, behaviors);
    console.log(renderTriage(report, clusters, computeHealth(ledger, clock).health));
  } finally {
    ledger.close();
  }
}

function cmdQuarantine(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: {
      db: { type: 'string' },
      quarantine: { type: 'string' },
      ticket: { type: 'string' },
      reason: { type: 'string' },
      days: { type: 'string' },
      expired: { type: 'boolean', default: false },
      now: { type: 'string' },
      actor: { type: 'string' },
    },
    allowPositionals: true,
  });
  const [sub, testId] = positionals;
  const qPath = quarantinePath(values);
  const clock = clockFrom(values);

  if (sub === 'list') {
    const file = loadQuarantine(qPath);
    const entries = values.expired ? expiredEntries(file, clock) : file.entries;
    if (entries.length === 0) {
      console.log(values.expired ? 'no expired quarantine entries' : 'quarantine lane is empty');
      return;
    }
    for (const e of entries) {
      const expired = new Date(e.expires_at).getTime() < clock().getTime();
      console.log(`  ${e.test_id}  ticket ${e.ticket}  expires ${e.expires_at}${expired ? '  ⚠ EXPIRED (escalate)' : ''}`);
    }
    return;
  }

  if (sub === 'add') {
    if (!testId) fail('quarantine add requires a test_id');
    if (!values.ticket) fail('quarantine add requires --ticket (entry+ticket = ACT, SPEC §7.3)');
    const ledger = new Ledger(dbPath(values));
    try {
      const gateway = new AutonomyGateway(ledger, { clock });
      const entry = buildEntry(
        {
          testId,
          ticket: values.ticket,
          ...(values.reason !== undefined ? { reason: values.reason } : {}),
          ...(values.days !== undefined ? { expiryDays: Number(values.days) } : {}),
        },
        clock,
      );
      const result = gateway.perform({
        class: 'flake_quarantine',
        target: testId,
        summary: `quarantine ${testId} → non-blocking lane until ${entry.expires_at} (ticket ${entry.ticket})`,
        evidence_basis: [],
        revert: `cart quarantine remove ${testId}`,
        execute: () => {
          const { file } = upsertEntry(loadQuarantine(qPath), entry);
          writeQuarantine(qPath, file);
        },
      });
      if (result.tier === 'ACT') {
        console.log(`quarantined ${testId} until ${entry.expires_at} (ticket ${entry.ticket}, receipt ${result.receipt.id})`);
        console.log('test source untouched — CI routes this test_id into the non-blocking lane (I5)');
      }
    } finally {
      ledger.close();
    }
    return;
  }

  if (sub === 'remove') {
    if (!testId) fail('quarantine remove requires a test_id');
    const { file, removed } = removeEntry(loadQuarantine(qPath), testId);
    if (!removed) {
      console.log(`${testId} is not in the quarantine lane`);
      return;
    }
    writeQuarantine(qPath, file);
    console.log(`removed ${testId} from the quarantine lane`);
    return;
  }

  fail(`unknown quarantine subcommand "${sub ?? ''}" — add | remove | list`);
}

function cmdPr(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: {
      db: { type: 'string' },
      repo: { type: 'string' },
      diff: { type: 'string' },
      ref: { type: 'string' },
      now: { type: 'string' },
      queue: { type: 'boolean', default: false },
      post: { type: 'boolean', default: false },
      'post-act': { type: 'boolean', default: false },
      actor: { type: 'string' },
    },
    allowPositionals: true,
  });
  const ref = positionals[0] ?? values.ref;
  if (!ref) fail('usage: cart pr <ref> [--repo <dir> | --diff <file>]');

  // diff source: an explicit captured diff, else git over a range
  let diff;
  if (values.diff) {
    diff = diffFromText(readFileSync(values.diff, 'utf8'));
  } else if (values.repo) {
    // ref may be a range (main...HEAD) or a single ref we diff against HEAD's base
    diff = new GitDiff(values.repo).diff(ref.includes('..') ? ref : `${ref}`);
  } else {
    fail('cart pr needs --repo <dir> (to run git diff) or --diff <file> (a captured diff)');
  }

  const ledger = new Ledger(dbPath(values));
  try {
    const clock = clockFrom(values);
    const api = new QueryApi(ledger, { config: loadDecayConfig(), churn: churnFrom(values), clock });
    const label = ref.includes('..') ? ref : `PR ${ref}`;
    const note = assembleRiskNote(api, label, diff, computeHealth(ledger, clock).health);

    if (values.queue && note.gaps.length > 0) {
      queueGaps(ledger, note, actor(values), clock);
    }
    console.log(renderRiskNote(note));

    // CG-5.2: posting the comment is PROPOSE by default; ACT only on opt-in
    if (values.post || values['post-act']) {
      const gateway = new AutonomyGateway(ledger, values['post-act'] ? { overrides: { pr_comment: 'ACT' } } : {});
      const result = gateway.perform({
        class: 'pr_comment',
        target: label,
        summary: `risk note: ${note.rows.length} behavior(s), ${note.gaps.length} gap(s)`,
        evidence_basis: note.rows.flatMap((r) => (r.verdict.newest_evidence_id ? [r.verdict.newest_evidence_id] : [])),
        revert: 'delete the posted comment',
        execute: () => {
          /* a real posting adapter (GitHub/GitLab) plugs in here — Phase 5 keeps it local */
        },
      });
      if (result.tier === 'PROPOSE') {
        console.log(`\n[comment is PROPOSE-tier: draft ready, not posted. Re-run with --post-act after the 2-week observation period to auto-post (SPEC §7.2).]`);
      } else {
        console.log(`\n[posted as ACT — receipt ${result.receipt.id}]`);
      }
    }
  } finally {
    ledger.close();
  }
}

function cmdBootstrap(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: {
      db: { type: 'string' },
      apply: { type: 'boolean', default: false },
      actor: { type: 'string' },
    },
    allowPositionals: true,
  });
  const [sub, repo] = positionals;
  if (sub !== 'import') return fail('usage: cart bootstrap import <repo> [--apply]');
  if (!repo) fail('bootstrap import requires a repo path');
  if (!existsSync(repo)) fail(`no such directory: ${repo}`);

  const ledger = new Ledger(dbPath(values));
  try {
    // ids are assigned eagerly off a running counter so a preview shows real ids
    let counter = parseInt((ledger.nextId('behavior').split('-')[1] ?? '1'), 10);
    const nextId = (): string => `BHV-${String(counter++).padStart(4, '0')}`;
    const { drafts, filesScanned } = bootstrapRepo(repo, nextId);

    console.log(`scanned ${filesScanned} test file(s) → ${drafts.length} behavior proposal(s) (all unconfirmed)`);
    const byCrit = new Map<string, number>();
    for (const d of drafts) byCrit.set(d.behavior.criticality, (byCrit.get(d.behavior.criticality) ?? 0) + 1);
    console.log(`criticality guesses: ${[...byCrit.entries()].map(([k, n]) => `${k} ${n}`).join(' · ') || '(none)'}`);

    if (!values.apply) {
      for (const d of drafts.slice(0, 12)) {
        console.log(`  ${d.behavior.id}  [${d.behavior.criticality}] ${d.behavior.statement}  (${d.behavior.area})`);
      }
      if (drafts.length > 12) console.log(`  … and ${drafts.length - 12} more`);
      console.log('preview only — re-run with --apply to write proposals, then `cart interview --batch 20`');
      return;
    }

    const who = actor(values);
    ledger.transaction(() => {
      for (const d of drafts) ledger.insertBehavior(d.behavior, who);
    });
    console.log(`wrote ${drafts.length} unconfirmed proposal(s). Next: cart interview --batch 20`);
  } finally {
    ledger.close();
  }
}

function cmdInterview(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      db: { type: 'string' },
      batch: { type: 'string' },
      apply: { type: 'string' },
      person: { type: 'string' },
      now: { type: 'string' },
    },
  });
  const ledger = new Ledger(dbPath(values));
  try {
    if (values.apply) {
      if (!values.person) fail('interview --apply requires --person (attribution, I3/I11)');
      const items = JSON.parse(readFileSync(values.apply, 'utf8')) as InterviewItem[];
      const outcome = applyInterview(ledger, values.person, items, clockFrom(values));
      console.log(
        `interview applied by ${values.person}: ${outcome.confirmed.length} confirmed, ` +
          `${outcome.merged.length} merged, ${outcome.discarded.length} discarded`,
      );
      for (const id of outcome.confirmed) console.log(`  ✓ ${id} confirmed`);
      for (const m of outcome.merged) console.log(`  ⇒ ${m.from} merged into ${m.into}`);
      for (const id of outcome.discarded) console.log(`  ✗ ${id} discarded`);
      return;
    }

    const n = values.batch ? Number(values.batch) : 20;
    const pending = pendingProposals(ledger, n);
    if (pending.length === 0) {
      console.log('no pending proposals — the map has no unconfirmed behaviors awaiting interview');
      return;
    }
    console.log(`${pending.length} proposal(s) awaiting your judgment (why: each was drafted from a test, unconfirmed):`);
    for (const b of pending) {
      const testId = b.links.verified_by?.[0]?.test_id ?? '(no test)';
      console.log(`  ${b.id}  [${b.criticality}] ${b.statement}`);
      console.log(`        area: ${b.area} · from: ${testId}`);
    }
    console.log('\nWrite decisions to an answers.json file, then:');
    console.log('  cart interview --apply answers.json --person <you>');
    console.log('Each item: {"behaviorId":"BHV-xxxx","decision":{"kind":"confirm"|"merge"|"discard", …}}');
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
      case 'pr':
        return cmdPr(argv.slice(1));
      case 'triage':
        return cmdTriage(argv.slice(1));
      case 'quarantine':
        return cmdQuarantine(argv.slice(1));
      case 'bootstrap':
        return cmdBootstrap(argv.slice(1));
      case 'interview':
        return cmdInterview(argv.slice(1));
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
