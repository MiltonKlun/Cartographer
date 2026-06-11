// `cart triage <run>` (CG-6.1, SPEC §7.3) — failure clustering. Cluster
// failures by signature (error class + normalized locator + stack hash),
// classify each cluster with DETERMINISTIC heuristics first
// (product_bug | test_brittleness | environment); whatever the heuristics
// can't decide is left `inference` for the LLM rim to label — it is never
// silently guessed (I1). Per cluster: affected behaviors, minimal-repro
// proposal, recommended action.
import { createHash } from 'node:crypto';
import { globMatch } from './linking.js';
import { renderClaims, type Claim, type Health } from './renderer.js';
import type { Behavior } from './types.js';

export interface TestFailure {
  testId: string;
  /** Source file of the test, for behavior linking. */
  file?: string;
  errorMessage: string;
  stack?: string;
}

export type FailureClass = 'product_bug' | 'test_brittleness' | 'environment' | 'inference';

export interface FailureSignature {
  errorClass: string;
  normalizedLocator: string | null;
  stackHash: string;
}

export interface Cluster {
  signature: FailureSignature;
  failures: TestFailure[];
  classification: FailureClass;
  /** Why the deterministic classifier decided — or why it deferred. */
  rationale: string;
  affectedBehaviors: string[];
  repro: string;
}

// ---- signature extraction ----

const ERROR_CLASS = /\b([A-Z]\w*(?:Error|Exception|TimeoutError|AssertionError))\b/;
const PW_TIMEOUT = /Timeout .* exceeded|waiting for|locator\.\w+: Timeout/i;
// only real selectors count as locators: PW query builders, locator() with a
// string arg, css/id selectors. Bare ".click"/"#42" must NOT match.
const LOCATOR =
  /getBy\w+\([^)]*\)|locator\(\s*['"`][^'"`]+['"`]\s*\)|page\.\w+\(\s*['"`][^'"`]+['"`]\s*\)|#[A-Za-z][\w-]*|\.[A-Za-z][\w-]+(?:\s*>\s*[\w.#-]+)+/;

function errorClassOf(message: string): string {
  const m = ERROR_CLASS.exec(message);
  if (m) return m[1] ?? 'Error';
  if (PW_TIMEOUT.test(message)) return 'TimeoutError';
  if (/expected .* (?:to|but)/i.test(message)) return 'AssertionError';
  return 'Error';
}

/** Strip volatile bits (ids, numbers, quotes) so equivalent failures group. */
function normalizeLocator(message: string): string | null {
  const m = LOCATOR.exec(message);
  if (!m) return null;
  return m[0]
    .replace(/['"`]/g, "'")
    .replace(/\b\d+\b/g, 'N')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Hash the first non-test stack frame so same-root failures cluster. */
function stackHashOf(failure: TestFailure): string {
  const frames = (failure.stack ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('at '));
  const root = frames.find((l) => !/\.(spec|test)\./.test(l)) ?? frames[0] ?? failure.errorMessage;
  // drop line:col numbers so cosmetic shifts don't fragment clusters
  const stable = root.replace(/:\d+:\d+/g, '').replace(/\b\d+\b/g, 'N');
  return createHash('sha256').update(stable).digest('hex').slice(0, 12);
}

export function signatureOf(failure: TestFailure): FailureSignature {
  return {
    errorClass: errorClassOf(failure.errorMessage),
    normalizedLocator: normalizeLocator(failure.errorMessage),
    stackHash: stackHashOf(failure),
  };
}

function signatureKey(sig: FailureSignature): string {
  return `${sig.errorClass}|${sig.normalizedLocator ?? '-'}|${sig.stackHash}`;
}

// ---- deterministic classification ----

const ENVIRONMENT_HINTS =
  /\b(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up|503|502|net::ERR|connection refused|DNS|getaddrinfo|out of memory|ENOSPC|disk)/i;
const BRITTLENESS_HINTS =
  /\b(locator|getBy\w+|selector|element is not (?:visible|attached|stable)|waiting for|detached from the DOM|strict mode violation)\b/i;
const PRODUCT_HINTS = /\b(expected .* (?:to (?:equal|be)|but)|received|AssertionError|status (?:4\d\d|5\d\d) but)/i;

/**
 * Decide a cluster's class from its shared signature + messages. Returns
 * `inference` (deferred to the LLM rim, surfaced labeled) only when the
 * deterministic signals are absent or conflicting.
 */
export function classifyCluster(failures: TestFailure[], signature: FailureSignature): { classification: FailureClass; rationale: string } {
  const corpus = failures.map((f) => `${f.errorMessage} ${f.stack ?? ''}`).join('\n');

  if (ENVIRONMENT_HINTS.test(corpus)) {
    return { classification: 'environment', rationale: 'infrastructure/network error signature (not the product, not the test)' };
  }
  const brittle = BRITTLENESS_HINTS.test(corpus) || signature.errorClass === 'TimeoutError';
  const product = PRODUCT_HINTS.test(corpus) && signature.errorClass === 'AssertionError';

  if (product && !brittle) {
    return { classification: 'product_bug', rationale: 'assertion on a value/status — the product produced the wrong result' };
  }
  if (brittle && !product) {
    return { classification: 'test_brittleness', rationale: 'locator/timeout signature — the test is fragile, not necessarily the product' };
  }
  return {
    classification: 'inference',
    rationale: 'deterministic signals absent or conflicting — defer to the LLM rim (surfaced as inference, never silently guessed)',
  };
}

// ---- assembly ----

function affectedBehaviors(failures: TestFailure[], behaviors: Behavior[]): string[] {
  const ids = new Set<string>();
  for (const f of failures) {
    for (const b of behaviors) {
      const byTestId = (b.links.verified_by ?? []).some((v) => v.test_id === f.testId);
      const byPath = f.file ? (b.links.implemented_in ?? []).some((g) => globMatch(g, f.file ?? '')) : false;
      if (byTestId || byPath) ids.add(b.id);
    }
  }
  return [...ids].sort();
}

function reproFor(cluster: { signature: FailureSignature; failures: TestFailure[]; classification: FailureClass }): string {
  const first = cluster.failures[0];
  if (!first) return 'no failures in cluster';
  switch (cluster.classification) {
    case 'environment':
      return `re-run ${first.testId} on a healthy runner; if it passes, the failure was environmental, not a regression`;
    case 'test_brittleness':
      return `run ${first.testId} in isolation with --repeat-each=5; flakiness confirms brittleness — quarantine + file a ticket`;
    case 'product_bug':
      return `reproduce ${first.testId} manually: the assertion "${first.errorMessage.slice(0, 80)}" should hold but does not`;
    default:
      return `inspect ${first.testId} (${cluster.failures.length} failure(s)) — signals were inconclusive`;
  }
}

export function clusterFailures(failures: TestFailure[], behaviors: Behavior[]): Cluster[] {
  const groups = new Map<string, TestFailure[]>();
  for (const f of failures) {
    const key = signatureKey(signatureOf(f));
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(f);
  }

  const clusters: Cluster[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (!first) continue;
    const signature = signatureOf(first);
    const { classification, rationale } = classifyCluster(group, signature);
    clusters.push({
      signature,
      failures: group,
      classification,
      rationale,
      affectedBehaviors: affectedBehaviors(group, behaviors),
      repro: reproFor({ signature, failures: group, classification }),
    });
  }

  // biggest / most actionable clusters first; product bugs lead
  const order: Record<FailureClass, number> = { product_bug: 0, test_brittleness: 1, environment: 2, inference: 3 };
  clusters.sort((a, b) => order[a.classification] - order[b.classification] || b.failures.length - a.failures.length);
  return clusters;
}

const CLASS_LABEL: Record<FailureClass, string> = {
  product_bug: 'PRODUCT BUG',
  test_brittleness: 'TEST BRITTLENESS',
  environment: 'ENVIRONMENT',
  inference: 'UNCLASSIFIED',
};

/** Render the triage report. Inference-class clusters are labeled, never
 *  presented as fact (I1); affected-behavior lines cite ledger ids. */
export function renderTriage(run: string, clusters: Cluster[], health: Health): string {
  const total = clusters.reduce((n, c) => n + c.failures.length, 0);
  const header = `cart triage — ${run}: ${total} failure(s) in ${clusters.length} cluster(s)`;
  if (clusters.length === 0) return `${header}\n(no failures — nothing to triage)`;

  const claims: Claim[] = [];
  clusters.forEach((c, i) => {
    const head = `[${i + 1}] ${CLASS_LABEL[c.classification]} ×${c.failures.length} — ${c.signature.errorClass}${c.signature.normalizedLocator ? ` @ ${c.signature.normalizedLocator}` : ''}`;
    if (c.classification === 'inference') {
      claims.push({ text: `${head} · ${c.rationale}`, label: 'inference' });
    } else {
      // cite the affected behaviors if any; else it's a labeled-but-uncited heuristic line
      const cites = c.affectedBehaviors;
      claims.push(cites.length > 0 ? { text: `${head} · ${c.rationale}`, citations: cites } : { text: `${head} · ${c.rationale}`, label: 'inference' });
    }
  });

  const lines = [header, renderClaims(claims, health)];
  clusters.forEach((c, i) => {
    lines.push(`  cluster ${i + 1} tests: ${c.failures.slice(0, 3).map((f) => f.testId).join(', ')}${c.failures.length > 3 ? ` (+${c.failures.length - 3})` : ''}`);
    if (c.affectedBehaviors.length > 0) lines.push(`    affected behaviors: ${c.affectedBehaviors.join(', ')}`);
    lines.push(`    repro: ${c.repro}`);
    if (c.classification === 'test_brittleness') lines.push(`    → quarantine candidate: cart quarantine add "${c.failures[0]?.testId}" --ticket <KEY>`);
  });
  return lines.join('\n');
}
