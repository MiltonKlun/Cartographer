// `cart` — Phase 0 CLI: init, behavior add/confirm/list, validate, claim
// (renderer demo), export. Every mutation flows through the validated ledger;
// every side effect through the autonomy gateway; every human-facing claim
// through the claims renderer. No bypass paths.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Ledger } from './db.js';
import { AutonomyGateway } from './autonomy.js';
import { QueryApi } from './query.js';
import { renderClaims, type Claim } from './renderer.js';
import { exportLedgerToFile } from './export.js';
import { isRecordType, validateRecord } from './validate.js';
import type { Behavior, Criticality } from './types.js';

const HEALTH_OK = { degraded: false } as const;

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
  cart behavior add --statement S --area A    add a behavior proposal
       [--criticality red|high|normal|low] [--implemented-in glob,glob] [--actor name]
  cart behavior confirm <BHV-id> --person P   confirm a behavior (I3)
  cart behavior list [--area A]               list behaviors (via claims renderer)
  cart validate <type> <file.json>            validate a record against its schema
  cart claim --text T [--cite ID,ID] [--inference] [--unknown]
                                              render a claim (refused without citations — I1)
  cart export [--out export/ledger.jsonl]     deterministic JSONL export (ACT, receipted)

  Global: --db <path> (default ./ledger.db or CART_DB)`;

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
      links: values['implemented-in']
        ? { implemented_in: values['implemented-in'].split(',').map((s) => s.trim()) }
        : {},
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
    const api = new QueryApi(ledger);
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
    console.log(renderClaims(claims, HEALTH_OK));
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
