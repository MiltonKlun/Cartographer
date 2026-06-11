// Extract TestFailure records from runner reports for triage. Shares the
// report shapes with the evidence ingestors but keeps only failing results
// and their error detail (triage cares about failures, not passes).
import { readFileSync } from 'node:fs';
import { parseJunitXml } from './ingest-junit.js';
import type { TestFailure } from './triage.js';

interface PwResult {
  status: string;
  error?: { message?: string; stack?: string };
  errors?: { message?: string; stack?: string }[];
}
interface PwSpec { title: string; file?: string; tests?: { results?: PwResult[] }[] }
interface PwSuite { file?: string; specs?: PwSpec[]; suites?: PwSuite[] }
interface PwReport { suites?: PwSuite[] }

const FAILED = new Set(['failed', 'timedOut', 'interrupted']);

function* walkSpecs(suites: PwSuite[], inheritedFile?: string): Generator<{ spec: PwSpec; file: string }> {
  for (const suite of suites) {
    const file = suite.file ?? inheritedFile ?? 'unknown';
    for (const spec of suite.specs ?? []) yield { spec, file: spec.file ?? file };
    if (suite.suites) yield* walkSpecs(suite.suites, file);
  }
}

export function failuresFromPlaywright(reportPath: string): TestFailure[] {
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as PwReport;
  const failures: TestFailure[] = [];
  for (const { spec, file } of walkSpecs(report.suites ?? [])) {
    for (const test of spec.tests ?? []) {
      for (const result of test.results ?? []) {
        if (!FAILED.has(result.status)) continue;
        const err = result.error ?? result.errors?.[0];
        failures.push({
          testId: `${file}::${spec.title}`,
          file,
          errorMessage: err?.message ?? `test ${result.status}`,
          ...(err?.stack !== undefined ? { stack: err.stack } : {}),
        });
      }
    }
  }
  return failures;
}

export function failuresFromJunit(reportPath: string): TestFailure[] {
  const { cases } = parseJunitXml(readFileSync(reportPath, 'utf8'));
  return cases
    .filter((c) => c.outcome === 'violates')
    .map((c) => ({
      testId: `${c.classname}::${c.name}`,
      file: c.file ?? c.classname.replace(/\./g, '/'),
      errorMessage: c.detail || `${c.name} failed`,
    }));
}
