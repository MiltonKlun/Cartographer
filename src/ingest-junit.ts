// ingest:junit@1 — parses JUnit XML into evidence candidates with a minimal
// zero-dependency parser (dependency policy, BUILD-PLAN rule 2). JUnit gives
// weaker identity guarantees than Playwright, so candidates that match only
// by path overlap stay at the linker's confidence; SPEC §6 notes the lower
// default trust in this format overall.
import { readFileSync } from 'node:fs';
import type { EvidenceCandidate } from './ingest.js';
import type { Evidence } from './types.js';

export const JUNIT_INGESTOR = 'ingest:junit@1';

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) {
    out[m[1] ?? ''] = unescapeXml(m[2] ?? '');
  }
  return out;
}

interface JUnitCase {
  classname: string;
  name: string;
  file?: string;
  outcome: Evidence['outcome'];
  detail: string;
}

export function parseJunitXml(xml: string): { timestamp?: string; cases: JUnitCase[] } {
  const suiteTag = xml.match(/<testsuite\b[^>]*>/)?.[0] ?? '';
  const timestamp = attrsOf(suiteTag)['timestamp'];
  const cases: JUnitCase[] = [];
  // matches <testcase .../> and <testcase ...>...</testcase>
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = attrsOf(m[1] ?? '');
    const body = m[3] ?? '';
    let outcome: Evidence['outcome'] = 'supports';
    if (/<(failure|error)\b/.test(body)) outcome = 'violates';
    else if (/<skipped\b/.test(body)) outcome = 'inconclusive';
    const detailMatch = body.match(/<(?:failure|error)\b[^>]*>([\s\S]*?)<\/(?:failure|error)>/);
    cases.push({
      classname: attrs['classname'] ?? '',
      name: attrs['name'] ?? '',
      ...(attrs['file'] !== undefined ? { file: attrs['file'] } : {}),
      outcome,
      detail: unescapeXml(detailMatch?.[1] ?? ''),
    });
  }
  return { ...(timestamp !== undefined ? { timestamp } : {}), cases };
}

export function parseJunitReport(
  reportPath: string,
  opts: { ref?: string; fallbackObservedAt: string },
): EvidenceCandidate[] {
  const xml = readFileSync(reportPath, 'utf8');
  const { timestamp, cases } = parseJunitXml(xml);
  const observedAt = timestamp ? new Date(timestamp).toISOString() : opts.fallbackObservedAt;
  const ref = opts.ref ?? `junit:${observedAt}`;

  return cases.map((c) => {
    const file = c.file ?? c.classname.replace(/\./g, '/');
    const testId = `${c.classname}::${c.name}`;
    return {
      testRef: { testId, title: c.name, annotations: [], file },
      kind: 'test_run' as const,
      outcome: c.outcome,
      observed_at: observedAt,
      source: { type: 'ci', ref },
      content: JSON.stringify({ test_id: testId, outcome: c.outcome, detail: c.detail || null }, null, 2),
      media_type: 'application/json',
      ingested_by: JUNIT_INGESTOR,
    };
  });
}
