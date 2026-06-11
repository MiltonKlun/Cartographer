// Evaluation harness (CG-10.1) — keeps the surfaces honest over time. Four
// checks: golden-question set for `cart ask`; claim-citation audit (every
// citation a surface emits must resolve to a real ledger record — I1/I11);
// triage precision vs. human labels; decline-rule check (I9). Pure over an
// injected ledger/query API; the CLI runs it and prints the report.
import type { Ledger } from './db.js';
import type { QueryApi } from './query.js';
import { assembleAsk } from './ask.js';
import { clusterFailures, type TestFailure, type FailureClass } from './triage.js';
import { shouldDecline } from './decline.js';
import type { Behavior, Evidence, Question, Receipt } from './types.js';

export interface GoldenQuestion {
  question: string;
  /** Expected: at least one of these behavior ids appears in the answer. */
  expectBehaviors?: string[];
  /** Expected: the answer is UNKNOWN / unmapped (no confirmed behavior). */
  expectUnknown?: boolean;
}

export interface TriageLabel {
  failure: TestFailure;
  expected: FailureClass;
}

export interface DeclineCase {
  request: string;
  expectDecline: boolean;
}

export interface GoldenSet {
  ask?: GoldenQuestion[];
  triage?: TriageLabel[];
  decline?: DeclineCase[];
}

export interface CheckResult {
  name: string;
  passed: number;
  total: number;
  failures: string[];
}

export interface EvalReport {
  checks: CheckResult[];
  ok: boolean;
}

// ---- 1. golden questions for ask ----

function evalAsk(api: QueryApi, golden: GoldenQuestion[]): CheckResult {
  const failures: string[] = [];
  let passed = 0;
  for (const g of golden) {
    const result = assembleAsk(api, g.question);
    const answeredIds = result.rows.map((r) => r.behavior.id);
    let ok = true;
    if (g.expectUnknown && result.mapViable) {
      ok = false;
      failures.push(`"${g.question}": expected UNKNOWN, got ${answeredIds.join(', ')}`);
    }
    if (g.expectBehaviors) {
      const hit = g.expectBehaviors.some((id) => answeredIds.includes(id));
      if (!hit) {
        ok = false;
        failures.push(`"${g.question}": expected one of ${g.expectBehaviors.join(', ')}, got ${answeredIds.join(', ') || '(none)'}`);
      }
    }
    if (ok) passed++;
  }
  return { name: 'ask golden-question set', passed, total: golden.length, failures };
}

// ---- 2. claim-citation audit (every citation must resolve) ----

function evalCitations(ledger: Ledger): CheckResult {
  const ids = new Set<string>();
  for (const table of ['behaviors', 'evidence', 'questions', 'sessions', 'receipts'] as const) {
    for (const r of ledger.allRecords(table) as { id: string }[]) ids.add(r.id);
  }
  const failures: string[] = [];
  let checked = 0;
  let passed = 0;

  // every evidence behavior_id must resolve; every receipt evidence_basis id must resolve
  for (const e of ledger.allRecords('evidence') as Evidence[]) {
    for (const bid of e.behavior_ids) {
      checked++;
      if (ids.has(bid)) passed++;
      else failures.push(`${e.id} cites missing behavior ${bid}`);
    }
  }
  for (const r of ledger.allRecords('receipts') as Receipt[]) {
    for (const basis of r.evidence_basis) {
      const id = basis.split(/\s/)[0] ?? basis; // basis may be "EV-9388 (failing)"
      checked++;
      if (ids.has(id)) passed++;
      else failures.push(`${r.id} evidence_basis cites missing ${id}`);
    }
  }
  for (const q of ledger.allRecords('questions') as Question[]) {
    if (q.behavior_id) {
      checked++;
      if (ids.has(q.behavior_id)) passed++;
      else failures.push(`${q.id} cites missing behavior ${q.behavior_id}`);
    }
  }
  return { name: 'claim-citation audit', passed, total: checked, failures };
}

// ---- 3. triage precision vs. human labels ----

function evalTriage(ledger: Ledger, labels: TriageLabel[]): CheckResult {
  const behaviors = ledger.allRecords('behaviors') as Behavior[];
  const failures: string[] = [];
  let passed = 0;
  for (const { failure, expected } of labels) {
    const clusters = clusterFailures([failure], behaviors);
    const got = clusters[0]?.classification;
    if (got === expected) passed++;
    else failures.push(`"${failure.errorMessage.slice(0, 50)}": expected ${expected}, got ${got ?? '(none)'}`);
  }
  return { name: 'triage precision vs. labels', passed, total: labels.length, failures };
}

// ---- 4. decline-rule check (I9) ----

function evalDecline(cases: DeclineCase[]): CheckResult {
  const failures: string[] = [];
  let passed = 0;
  for (const c of cases) {
    const got = shouldDecline(c.request).decline;
    if (got === c.expectDecline) passed++;
    else failures.push(`"${c.request}": expected decline=${c.expectDecline}, got ${got}`);
  }
  return { name: 'decline-rule (I9)', passed, total: cases.length, failures };
}

export function runEval(ledger: Ledger, api: QueryApi, golden: GoldenSet): EvalReport {
  const checks: CheckResult[] = [evalCitations(ledger)];
  if (golden.ask) checks.push(evalAsk(api, golden.ask));
  if (golden.triage) checks.push(evalTriage(ledger, golden.triage));
  if (golden.decline) checks.push(evalDecline(golden.decline));
  return { checks, ok: checks.every((c) => c.passed === c.total) };
}

export function renderEvalReport(report: EvalReport): string {
  const lines = ['Cartographer eval report', ''];
  for (const c of report.checks) {
    const mark = c.passed === c.total ? '✓' : '✗';
    lines.push(`${mark} ${c.name}: ${c.passed}/${c.total}`);
    for (const f of c.failures) lines.push(`    - ${f}`);
  }
  lines.push('', report.ok ? 'RESULT: all checks pass' : 'RESULT: FAILURES present — do not trust the surfaces until fixed');
  return lines.join('\n');
}
