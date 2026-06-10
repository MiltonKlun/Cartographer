// ingest:playwright-json@1 — parses a Playwright JSON report (+ optional
// trace zip attachments) into evidence candidates. test_id convention:
// "<file>::<spec title>" (matches links.verified_by.test_id, SPEC §3.1).
import { existsSync, readFileSync } from 'node:fs';
import type { EvidenceCandidate } from './ingest.js';
import type { Evidence } from './types.js';

export const PLAYWRIGHT_INGESTOR = 'ingest:playwright-json@1';

interface PwAnnotation {
  type: string;
  description?: string;
}

interface PwResult {
  status: string;
  startTime?: string;
  error?: { message?: string; stack?: string };
  errors?: { message?: string }[];
  attachments?: { name: string; path?: string; contentType: string }[];
}

interface PwTest {
  annotations?: PwAnnotation[];
  results?: PwResult[];
}

interface PwSpec {
  title: string;
  file?: string;
  tests?: PwTest[];
}

interface PwSuite {
  title?: string;
  file?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}

interface PwReport {
  suites?: PwSuite[];
  stats?: { startTime?: string };
}

function outcomeOf(status: string): Evidence['outcome'] {
  if (status === 'passed') return 'supports';
  if (status === 'failed' || status === 'timedOut' || status === 'interrupted') return 'violates';
  return 'inconclusive'; // skipped etc.
}

function isoOrUndefined(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function* walkSpecs(suites: PwSuite[], inheritedFile?: string): Generator<{ spec: PwSpec; file: string }> {
  for (const suite of suites) {
    const file = suite.file ?? inheritedFile ?? 'unknown';
    for (const spec of suite.specs ?? []) yield { spec, file: spec.file ?? file };
    if (suite.suites) yield* walkSpecs(suite.suites, file);
  }
}

/**
 * One candidate per test result. The artifact is the trace zip when present
 * (binary, quarantine-scanned), otherwise a JSON snippet of the result
 * (text, scrubbed by the redaction stage).
 */
export function parsePlaywrightReport(
  reportPath: string,
  opts: { ref?: string; fallbackObservedAt: string },
): EvidenceCandidate[] {
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as PwReport;
  const runStart = isoOrUndefined(report.stats?.startTime);
  const ref = opts.ref ?? `playwright:${runStart ?? opts.fallbackObservedAt}`;
  const candidates: EvidenceCandidate[] = [];

  for (const { spec, file } of walkSpecs(report.suites ?? [])) {
    const testId = `${file}::${spec.title}`;
    for (const test of spec.tests ?? []) {
      const annotations = (test.annotations ?? [])
        .map((a) => `${a.type} ${a.description ?? ''}`.trim());
      for (const result of test.results ?? []) {
        const observed =
          isoOrUndefined(result.startTime) ?? runStart ?? opts.fallbackObservedAt;
        const trace = (result.attachments ?? []).find(
          (a) => a.contentType === 'application/zip' && a.path && existsSync(a.path),
        );
        const base = {
          testRef: { testId, title: spec.title, annotations, file },
          kind: 'test_run' as const,
          outcome: outcomeOf(result.status),
          observed_at: observed,
          source: { type: 'ci', ref },
          ingested_by: PLAYWRIGHT_INGESTOR,
        };
        if (trace?.path) {
          candidates.push({ ...base, kind: 'trace', content: readFileSync(trace.path), media_type: 'application/zip' });
        } else {
          const snippet = { test_id: testId, status: result.status, error: result.error ?? result.errors ?? null };
          candidates.push({ ...base, content: JSON.stringify(snippet, null, 2), media_type: 'application/json' });
        }
      }
    }
  }
  return candidates;
}
