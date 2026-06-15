// Bootstrap import (CG-4.1, SPEC §11): a blank map helps nobody, a lying map
// is worse. Parse an existing test suite into ONE UNCONFIRMED behavior
// proposal per test — title → statement, area from path, criticality guessed
// only for red-domain keywords. Nothing is confirmed: the batch interview
// (CG-4.2) is where a human gives the proposals meaning (I3).
import { readFileSync, globSync } from 'node:fs';
import { guessCriticality } from './criticality.js';
import type { Behavior } from './types.js';

export interface DiscoveredTest {
  testId: string;
  title: string;
  file: string;
  /** @bhv BHV-xxxx already present in the title/annotation, if any. */
  existingBhv: string | null;
}

// it('…') / test('…') / it.each(…)('…') — first string arg is the title.
const TEST_TITLE = /\b(?:it|test)(?:\.\w+)?\s*(?:\([^)]*?)?\(\s*(['"`])((?:\\.|(?!\1).)*?)\1/g;
const DESCRIBE_TITLE = /\bdescribe\s*\(\s*(['"`])((?:\\.|(?!\1).)*?)\1/g;
const BHV_ID = /BHV-\d{4,}/;

const DEFAULT_GLOBS = [
  // suffix conventions (Jest/Vitest/Playwright/Mocha-with-suffix)
  '**/*.spec.ts',
  '**/*.spec.js',
  '**/*.test.ts',
  '**/*.test.js',
  '**/*.spec.tsx',
  '**/*.test.tsx',
  // dedicated test-directory conventions (AVA/Mocha/node:test with a test/
  // dir, where files are NOT suffixed — e.g. got's `test/cache.ts`)
  'test/**/*.ts',
  'test/**/*.js',
  'tests/**/*.ts',
  'tests/**/*.js',
  '__tests__/**/*.ts',
  '__tests__/**/*.js',
];

// non-test files that commonly live under a test/ dir (helpers, fixtures,
// setup) and should not become behaviors
const NON_TEST = /(?:^|\/)(?:helpers?|fixtures?|setup|__helpers__|__fixtures__|tsconfig|index)\b|\.d\.ts$/i;

/** Find test files under `repoDir`, skipping node_modules, dist, and helpers. */
export function discoverTestFiles(repoDir: string, globs: string[] = DEFAULT_GLOBS): string[] {
  const matches = new Set<string>();
  for (const pattern of globs) {
    for (const m of globSync(pattern, { cwd: repoDir })) {
      const p = m.replace(/\\/g, '/');
      if (p.includes('node_modules/') || p.startsWith('dist/')) continue;
      if (NON_TEST.test(p)) continue;
      matches.add(p);
    }
  }
  return [...matches].sort();
}

/** Extract one DiscoveredTest per test() / it() in the file's source. */
export function extractTests(relPath: string, source: string): DiscoveredTest[] {
  // nearest preceding describe() title gives context to bare test titles
  const describes: { index: number; title: string }[] = [];
  for (const m of source.matchAll(DESCRIBE_TITLE)) {
    describes.push({ index: m.index ?? 0, title: unescape(m[2] ?? '') });
  }
  const tests: DiscoveredTest[] = [];
  for (const m of source.matchAll(TEST_TITLE)) {
    const title = unescape(m[2] ?? '').trim();
    if (!title) continue;
    const at = m.index ?? 0;
    const ctx = describes.filter((d) => d.index < at).at(-1);
    const fullTitle = ctx ? `${ctx.title} ${title}` : title;
    tests.push({
      testId: `${relPath}::${ctx ? `${ctx.title} ` : ''}${title}`,
      title: fullTitle,
      file: relPath,
      existingBhv: BHV_ID.exec(`${title} ${ctx?.title ?? ''}`)?.[0] ?? null,
    });
  }
  return tests;
}

function unescape(s: string): string {
  return s.replace(/\\(['"`\\])/g, '$1');
}

/** Path → area: drop the test root + filename, keep meaningful dir segments. */
export function areaFromPath(relPath: string): string {
  const parts = relPath.replace(/\\/g, '/').split('/');
  const dirs = parts
    .slice(0, -1)
    .filter((p) => !/^(tests?|spec|specs|__tests__|src|e2e|integration|unit)$/i.test(p));
  // drop a .spec/.test suffix if present, then any remaining source extension
  const fileStem = (parts.at(-1) ?? '')
    .replace(/\.(spec|test)\.\w+$/, '')
    .replace(/\.(tsx?|jsx?|mjs|cjs)$/, '');
  const segments = [...dirs, fileStem].filter(Boolean);
  return segments.length > 0 ? segments.join('/') : 'uncategorized';
}

// the schema requires a statement of at least this many chars (behavior.schema)
const MIN_STATEMENT = 8;

/**
 * Title → falsifiable statement: strip leading "should", capitalize. Real
 * suites contain terse/parameterized titles ("blah", "[2]"); when a derived
 * statement is too short to be a valid behavior, qualify it with its `area`
 * so the proposal is still meaningful (and the human can fix or discard it in
 * the interview) rather than silently dropping the test.
 */
export function statementFromTitle(title: string, area?: string): string {
  let s = title.replace(/\s+/g, ' ').trim();
  s = s.replace(/^(should|it should|must|will|can|verifies that|checks that|ensures that)\s+/i, '');
  if (s.length === 0) s = title.trim();
  let out = s.length === 0 ? '' : s.charAt(0).toUpperCase() + s.slice(1);
  if (out.length < MIN_STATEMENT && area) {
    out = `${area} behavior: ${out}`.trim();
  }
  return out;
}

export interface BootstrapDraft {
  behavior: Behavior;
  source: DiscoveredTest;
}

/** Draft unconfirmed behavior proposals from discovered tests (no confirm). */
export function draftBehaviors(
  tests: DiscoveredTest[],
  nextId: () => string,
): BootstrapDraft[] {
  return tests.map((t) => {
    const area = areaFromPath(t.file);
    const statement = statementFromTitle(t.title, area);
    const guess = guessCriticality(`${statement} ${area}`);
    const behavior: Behavior = {
      id: nextId(),
      statement,
      area,
      criticality: guess.criticality,
      links: {
        verified_by: [{ test_id: t.testId, confidence: 'high' }],
        implemented_in: [],
      },
      created_by: 'import',
      status: 'active',
      notes: `bootstrap import from ${t.file}${guess.matched ? ` · criticality guessed from "${guess.matched}"` : ''}`,
    };
    return { behavior, source: t };
  });
}

export interface RepoBootstrap {
  drafts: BootstrapDraft[];
  filesScanned: number;
}

/** Full pipeline: discover → extract → draft. Reads the repo, writes nothing. */
export function bootstrapRepo(repoDir: string, nextId: () => string): RepoBootstrap {
  const files = discoverTestFiles(repoDir);
  const allTests: DiscoveredTest[] = [];
  for (const file of files) {
    const source = readFileSync(`${repoDir}/${file}`, 'utf8');
    allTests.push(...extractTests(file, source));
  }
  return { drafts: draftBehaviors(allTests, nextId), filesScanned: files.length };
}
