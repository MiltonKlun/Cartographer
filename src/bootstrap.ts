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
  '**/*.spec.ts',
  '**/*.spec.js',
  '**/*.test.ts',
  '**/*.test.js',
  '**/*.spec.tsx',
  '**/*.test.tsx',
];

/** Find test files under `repoDir`, skipping node_modules and dist. */
export function discoverTestFiles(repoDir: string, globs: string[] = DEFAULT_GLOBS): string[] {
  const matches = new Set<string>();
  for (const pattern of globs) {
    for (const m of globSync(pattern, { cwd: repoDir })) {
      const p = m.replace(/\\/g, '/');
      if (p.includes('node_modules/') || p.startsWith('dist/')) continue;
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
  const fileStem = (parts.at(-1) ?? '').replace(/\.(spec|test)\.\w+$/, '');
  const segments = [...dirs, fileStem].filter(Boolean);
  return segments.length > 0 ? segments.join('/') : 'uncategorized';
}

/** Title → falsifiable statement: strip leading "should", capitalize. */
export function statementFromTitle(title: string): string {
  let s = title.replace(/\s+/g, ' ').trim();
  s = s.replace(/^(should|it should|must|will|can|verifies that|checks that|ensures that)\s+/i, '');
  if (s.length === 0) return title;
  return s.charAt(0).toUpperCase() + s.slice(1);
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
    const statement = statementFromTitle(t.title);
    const area = areaFromPath(t.file);
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
