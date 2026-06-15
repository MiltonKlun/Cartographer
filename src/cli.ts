// `cart` — Phase 0 CLI: init, behavior add/confirm/list, validate, claim
// (renderer demo), export. Every mutation flows through the validated ledger;
// every side effect through the autonomy gateway; every human-facing claim
// through the claims renderer. No bypass paths.
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname as dirnameOf } from 'node:path';
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
import {
  applyInterview,
  pendingProposals,
  nextQuestion,
  answerQuestion,
  type InterviewItem,
  type QuestionAnswer,
} from './interview.js';
import { assembleBrief, renderBrief } from './brief.js';
import { startSession, noteSession, stopSession, renderStop, openSessionFor } from './session.js';
import { parseSessionSheet, importSessionSheet } from './ingest-session.js';
import { runHeal, renderHealOutcome, type HealPorts, type RerunResult } from './heal.js';
import { patchViolations } from './guardrails.js';
import { runEval, renderEvalReport, type GoldenSet } from './eval.js';
import { shouldDecline } from './decline.js';
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
  cart brief [--quarantine F]                  the morning brief: one screen, ordered sections, health footer
  cart interview                               show the next open question with why_asked (single-question, §7.5)
  cart interview answer <Q-id> --person P --new-behavior "S" --area A
  cart interview answer <Q-id> --person P --confirm <BHV-id>
  cart interview answer <Q-id> --person P --dismiss [--reason R]
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
  cart export [--out export/ledger.jsonl] [--no-receipt]
                                              deterministic JSONL export (receipted ACT; --no-receipt = pure snapshot)
  cart ingest playwright <report.json> [--ref R]
  cart ingest junit <report.xml> [--ref R]     CI results → evidence (redacted, linked, deduped)
  cart ingest session <sheet.md>               ET-Kit session sheet → evidence/questions/proposals (§6)
  cart session start|note "<text>"|stop --engineer E
                                              ride-along: silent until stop (I8), then review-queue proposals
  cart heal <test-file> --patched F --behavior BHV-id --test "<test-id>"
       [--rerun-passed | --rerun-failed]      locator-only heal: guardrails → apply → re-run (I12)
  cart guardrails-check <orig-file> <patched-file> [--selector-heal]
                                              run §10 guardrails on a patch (no apply); exit 1 if violations
  cart eval [--golden <set.json>]              run the eval harness; exit 1 on any failure (CI-friendly)
  cart decline "<request>"                     I9: recommend raw prompting for one-off/no-regression work
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
      now: { type: 'string' },
    },
    allowPositionals: true,
  });
  const [format, file] = positionals;
  if (!format || !file) fail('usage: cart ingest <playwright|junit|session> <report|sheet> [--ref R]');
  if (!existsSync(file)) fail(`no such file: ${file}`);

  // ET-Kit session sheets have their own pipeline (evidence + Q + proposals)
  if (format === 'session') {
    const ledger = new Ledger(dbPath(values));
    try {
      const gateway = new AutonomyGateway(ledger, { clock: clockFrom(values) });
      const sheet = parseSessionSheet(readFileSync(file, 'utf8'));
      const summary = importSessionSheet(ledger, gateway, sheet, {
        vaultRoot: vaultRoot(values),
        rules: loadRedactionRules(),
        baseDir: dirnameOf(file),
        clock: clockFrom(values),
      });
      console.log(
        `imported ET-Kit sheet → session ${summary.sessionId}: ` +
          `${summary.evidenceCreated.length} evidence, ${summary.questionsQueued.length} question(s), ` +
          `${summary.ideaProposals.length} idea(s) — receipt ${summary.receiptId}`,
      );
      if (summary.evidenceCreated.length) console.log(`  evidence: ${summary.evidenceCreated.join(', ')}`);
      if (summary.questionsQueued.length) console.log(`  questions: ${summary.questionsQueued.join(', ')}`);
      if (summary.quarantined.length) console.log(`  quarantined (I10): ${summary.quarantined.join(', ')}`);
      console.log('  nothing merged into the map — review proposals + answer questions (I3)');
    } finally {
      ledger.close();
    }
    return;
  }

  const parseOpts = {
    ...(values.ref !== undefined ? { ref: values.ref } : {}),
    fallbackObservedAt: isoNow(systemClock),
  };
  let candidates;
  if (format === 'playwright') candidates = parsePlaywrightReport(file, parseOpts);
  else if (format === 'junit') candidates = parseJunitReport(file, parseOpts);
  else return fail(`unknown ingest format "${format}" — playwright, junit, or session`);

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
    // insert per-record so one malformed proposal (terse/parameterized real
    // test titles do occur) is skipped-and-reported, never aborting the batch
    let wrote = 0;
    const skipped: string[] = [];
    for (const d of drafts) {
      try {
        ledger.insertBehavior(d.behavior, who);
        wrote++;
      } catch (err) {
        skipped.push(`${d.source.testId}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
      }
    }
    console.log(`wrote ${wrote} unconfirmed proposal(s)${skipped.length ? `, skipped ${skipped.length} un-draftable` : ''}. Next: cart interview --batch 20`);
    for (const s of skipped.slice(0, 10)) console.log(`  skipped ${s}`);
    if (skipped.length > 10) console.log(`  … and ${skipped.length - 10} more skipped`);
  } finally {
    ledger.close();
  }
}

function cmdEval(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: { db: { type: 'string' }, repo: { type: 'string' }, golden: { type: 'string' }, now: { type: 'string' } },
  });
  const golden: GoldenSet = values.golden ? (JSON.parse(readFileSync(values.golden, 'utf8')) as GoldenSet) : {};
  const ledger = new Ledger(dbPath(values));
  try {
    const clock = clockFrom(values);
    const api = new QueryApi(ledger, { config: loadDecayConfig(), churn: churnFrom(values), clock });
    const report = runEval(ledger, api, golden);
    console.log(renderEvalReport(report));
    if (!report.ok) process.exit(1);
  } finally {
    ledger.close();
  }
}

function cmdDecline(args: string[]): void {
  const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
  const request = positionals.join(' ').trim();
  if (!request) fail('usage: cart decline "<request>"');
  const verdict = shouldDecline(request);
  console.log(verdict.decline ? `DECLINE — ${verdict.reason}` : `USE THE LEDGER — ${verdict.reason}`);
}

function cmdHeal(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: {
      db: { type: 'string' },
      patched: { type: 'string' },
      behavior: { type: 'string' },
      test: { type: 'string' },
      'rerun-passed': { type: 'boolean', default: false },
      'rerun-failed': { type: 'boolean', default: false },
      now: { type: 'string' },
    },
    allowPositionals: true,
  });
  const file = positionals[0];
  if (!file) fail('usage: cart heal <test-file> --patched <file> --behavior BHV-id --test "<id>"');
  if (!values.patched || !values.behavior || !values.test) {
    fail('cart heal requires --patched <file>, --behavior <BHV-id>, --test "<test-id>"');
  }
  if (!existsSync(file)) fail(`no such file: ${file}`);
  if (!existsSync(values.patched)) fail(`no such patched file: ${values.patched}`);

  const originalSource = readFileSync(file, 'utf8');
  const patchedSource = readFileSync(values.patched, 'utf8');
  const clock = clockFrom(values);

  // the re-run port: a real runner plugs in here; the flags drive the demo/CI
  const passed = values['rerun-passed'] || !values['rerun-failed'];
  const ports: HealPorts = {
    applyPatch: (target, source) => writeFileSync(target, source, 'utf8'),
    rerun: (): RerunResult => ({ passed, ref: `local-heal-${isoNow(clock)}` }),
  };

  const ledger = new Ledger(dbPath(values));
  try {
    const gateway = new AutonomyGateway(ledger, { clock });
    const proposal = { file, behaviorId: values.behavior, testId: values.test, originalSource, patchedSource };
    const outcome = runHeal(ledger, gateway, proposal, ports, clock);
    console.log(renderHealOutcome(proposal, outcome));
    if (outcome.status === 'rejected') process.exit(1);
  } finally {
    ledger.close();
  }
}

function cmdGuardrailsCheck(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: { 'selector-heal': { type: 'boolean', default: false } },
    allowPositionals: true,
  });
  const [orig, patched] = positionals;
  if (!orig || !patched) fail('usage: cart guardrails-check <orig-file> <patched-file> [--selector-heal]');
  const violations = patchViolations(
    readFileSync(orig, 'utf8'),
    readFileSync(patched, 'utf8'),
    values['selector-heal'] ? { mode: 'selector_heal' } : {},
  );
  if (violations.length === 0) {
    console.log('guardrails: clean — patch is allowed under §10');
    return;
  }
  console.error(`guardrails: ${violations.length} violation(s) — patch REFUSED (I5):`);
  for (const v of violations) console.error(`  ✗ ${v.kind}: ${v.detail}`);
  process.exit(1);
}

function cmdSession(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: {
      db: { type: 'string' },
      engineer: { type: 'string' },
      auto: { type: 'boolean', default: false },
      'evidence-id': { type: 'string' },
      now: { type: 'string' },
    },
    allowPositionals: true,
  });
  const sub = positionals[0];
  const engineer = values.engineer ?? process.env['CART_ENGINEER'];
  if (!engineer) fail('cart session requires --engineer <name> (attribution, I11)');
  const ledger = new Ledger(dbPath(values));
  const clock = clockFrom(values);
  try {
    switch (sub) {
      case 'start': {
        const s = startSession(ledger, engineer, clock);
        console.log(`session ${s.id} started for ${engineer} — observing silently until stop (I8)`);
        console.log('  add notes:  cart session note "<observation>" --engineer ' + engineer);
        return;
      }
      case 'note': {
        const note = positionals.slice(1).join(' ').trim();
        if (!note) fail('cart session note requires text');
        noteSession(
          ledger,
          engineer,
          { note, auto: values.auto, ...(values['evidence-id'] !== undefined ? { evidenceId: values['evidence-id'] } : {}) },
          clock,
        );
        // silent by design (I8): a bare confirmation, no analysis
        const open = openSessionFor(ledger, engineer);
        console.log(`noted (${open?.observations?.length ?? 0} so far). Silent until stop.`);
        return;
      }
      case 'stop': {
        const result = stopSession(ledger, engineer, clock);
        console.log(renderStop(result));
        return;
      }
      default:
        return fail('usage: cart session start|note "<text>"|stop --engineer <name>');
    }
  } finally {
    ledger.close();
  }
}

function cmdBrief(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      db: { type: 'string' },
      repo: { type: 'string' },
      quarantine: { type: 'string' },
      now: { type: 'string' },
      'no-snapshot': { type: 'boolean', default: false },
    },
  });
  const ledger = new Ledger(dbPath(values));
  try {
    const clock = clockFrom(values);
    const ctx = { config: loadDecayConfig(), churn: churnFrom(values), clock };
    const api = new QueryApi(ledger, ctx);
    const data = assembleBrief(ledger, api, ctx, {
      quarantinePath: quarantinePath(values),
      writeSnapshot: !values['no-snapshot'],
    });
    console.log(renderBrief(data));
  } finally {
    ledger.close();
  }
}

function cmdInterview(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: {
      db: { type: 'string' },
      batch: { type: 'string' },
      apply: { type: 'string' },
      person: { type: 'string' },
      now: { type: 'string' },
      'new-behavior': { type: 'string' },
      area: { type: 'string' },
      criticality: { type: 'string' },
      confirm: { type: 'string' },
      dismiss: { type: 'boolean', default: false },
      reason: { type: 'string' },
    },
    allowPositionals: true,
  });
  const ledger = new Ledger(dbPath(values));
  try {
    // single-question answer (CG-7.2)
    if (positionals[0] === 'answer') {
      const qId = positionals[1];
      if (!qId) fail('usage: cart interview answer <Q-id> --person P (--new-behavior … | --confirm BHV-id | --dismiss)');
      if (!values.person) fail('answering requires --person (the answer is the approval — I3/I11)');
      let answer: QuestionAnswer;
      if (values['new-behavior']) {
        if (!values.area) fail('--new-behavior requires --area');
        answer = {
          kind: 'new_behavior',
          statement: values['new-behavior'],
          area: values.area,
          ...(values.criticality ? { criticality: values.criticality as Criticality } : {}),
        };
      } else if (values.confirm) {
        answer = { kind: 'confirm_existing', behaviorId: values.confirm };
      } else if (values.dismiss) {
        answer = { kind: 'dismiss', ...(values.reason !== undefined ? { reason: values.reason } : {}) };
      } else {
        return fail('answer needs one of --new-behavior "S" --area A, --confirm BHV-id, or --dismiss');
      }
      const outcome = answerQuestion(ledger, qId, values.person, answer, clockFrom(values));
      console.log(`${qId} answered by ${values.person}`);
      for (const m of outcome.resultingMutations) console.log(`  → ${m}`);
      if (outcome.resultingMutations.length === 0) console.log('  → (no mutation — question closed)');
      return;
    }

    // batch apply (CG-4.2)
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

    // batch list (CG-4.2)
    if (values.batch) {
      const n = Number(values.batch);
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
      return;
    }

    // default: single-question mode (CG-7.2, SPEC §7.5) — one question, with why_asked
    const q = nextQuestion(ledger);
    if (!q) {
      console.log('no open questions — the map has no gaps queued for human meaning');
      return;
    }
    console.log(`${q.id}: ${q.prompt}`);
    console.log(`  why asked: ${q.why_asked}`);
    console.log('\nAnswer it (the answer IS the approval — I3):');
    console.log(`  cart interview answer ${q.id} --person <you> --new-behavior "<statement>" --area <area>`);
    console.log(`  cart interview answer ${q.id} --person <you> --confirm <BHV-id>`);
    console.log(`  cart interview answer ${q.id} --person <you> --dismiss [--reason "<why>"]`);
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
    options: {
      db: { type: 'string' },
      out: { type: 'string' },
      'no-receipt': { type: 'boolean', default: false },
    },
  });
  const outPath = values.out ?? join(process.cwd(), 'export', 'ledger.jsonl');
  const ledger = new Ledger(dbPath(values));
  try {
    // --no-receipt: a pure read-only snapshot. The export does NOT write its
    // own receipt/mutation, so two snapshots of an unchanged ledger are
    // byte-identical (the determinism guarantee, SPEC §5). Use for diffing,
    // review, and reproducible backups. The default (receipted) path keeps the
    // export in the audit trail (I4) — at the cost that back-to-back receipted
    // exports differ by exactly that one receipt.
    if (values['no-receipt']) {
      const { records } = exportLedgerToFile(ledger, outPath);
      console.log(`exported ${records} records to ${outPath} (no receipt — pure snapshot)`);
      return;
    }
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
      case 'session':
        return cmdSession(argv.slice(1));
      case 'heal':
        return cmdHeal(argv.slice(1));
      case 'guardrails-check':
        return cmdGuardrailsCheck(argv.slice(1));
      case 'eval':
        return cmdEval(argv.slice(1));
      case 'decline':
        return cmdDecline(argv.slice(1));
      case 'brief':
        return cmdBrief(argv.slice(1));
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
