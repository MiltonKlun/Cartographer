// Guardrails (CG-9.1, SPEC §10, I5) — ONE pure function applied to EVERY
// patch Cartographer produces (heals and test proposals alike). It is the
// one source of truth for the NEVER list at the patch level: the gateway runs
// it before applying anything, and the unit tests run the same function.
//
// Dependency policy (BUILD-PLAN rule 2) forbids a real AST parser, so this
// works at the source-line level with conservative pattern detection. When in
// doubt it flags a violation — a false positive blocks a heal (safe); a false
// negative would let a forbidden edit through (unsafe), so the patterns err
// toward rejection.

export type ViolationKind =
  | 'test_deletion'
  | 'skip_introduced'
  | 'only_introduced'
  | 'assertion_weakened'
  | 'expected_value_changed'
  | 'snapshot_introduced'
  | 'non_locator_change';

export interface Violation {
  kind: ViolationKind;
  detail: string;
}

export interface GuardrailOptions {
  /** 'selector_heal' adds the locator-only constraint (SPEC §10). */
  mode?: 'general' | 'selector_heal';
}

const TEST_DECL = /\b(?:it|test)(?:\.\w+)?\s*\(/g;
const SKIP_FIXME = /\b(?:it|test|describe)\.(?:skip|fixme)\b|\.(?:skip|fixme)\s*\(/;
const ONLY = /\b(?:it|test|describe)\.only\b|\.only\s*\(/;
const SNAPSHOT = /\.toMatch(?:Inline)?Snapshot\s*\(/;

// assertion-weakening: a strong matcher being replaced by a vacuous one
const WEAK_MATCHERS = /\b(toBeTruthy|toBeDefined|toBeUndefined|not\.toThrow|toBeNull|anything)\b/;
const STRONG_MATCHER = /\b(toBe|toEqual|toStrictEqual|toHaveBeenCalledWith|toHaveLength|toMatchObject|toContain)\b/;

// the locator allowlist (SPEC §10): only these calls' STRING args may change
const LOCATOR_CALL =
  /(?:page|frame|\w+)\.(?:locator)\s*\(|(?:page|frame|\w+)\.(?:getByRole|getByText|getByLabel|getByTestId|getByPlaceholder)\s*\(/;

function countMatches(s: string, re: RegExp): number {
  return (s.match(re) ?? []).length;
}

function splitLines(s: string): string[] {
  return s.replace(/\r\n/g, '\n').split('\n');
}

/** Lines present in `patched` that are not in `original` (added/changed). */
function addedLines(original: string, patched: string): string[] {
  const before = new Set(splitLines(original).map((l) => l.trim()));
  return splitLines(patched)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !before.has(l));
}

/** Lines present in `original` but gone from `patched` (removed/changed). */
function removedLines(original: string, patched: string): string[] {
  const after = new Set(splitLines(patched).map((l) => l.trim()));
  return splitLines(original)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !after.has(l));
}

/** Strip string/template literals so we can compare code structure only. */
function stripStringLiterals(line: string): string {
  return line
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

/** Blank ALL literals (strings + numbers/bools/null) for twin matching. */
function blankAllLiterals(line: string): string {
  return stripStringLiterals(line).replace(/\b(?:\d+(?:\.\d+)?|true|false|null|undefined)\b/g, '∎');
}

/** Numeric / boolean / null literals inside a line (for expected-value checks). */
function nonStringLiterals(line: string): string[] {
  return line.match(/\b(?:\d+(?:\.\d+)?|true|false|null|undefined)\b/g) ?? [];
}

/**
 * The single guardrail. Returns every violation found between `original` and
 * `patched`. An empty array means the patch is allowed under §10. Pure: no
 * I/O, no clock, deterministic.
 */
export function patchViolations(original: string, patched: string, opts: GuardrailOptions = {}): Violation[] {
  const violations: Violation[] = [];
  const added = addedLines(original, patched);
  const removed = removedLines(original, patched);

  // 1. test deletion — fewer test declarations than before (I5)
  const beforeTests = countMatches(original, TEST_DECL);
  const afterTests = countMatches(patched, TEST_DECL);
  if (afterTests < beforeTests) {
    violations.push({ kind: 'test_deletion', detail: `test count dropped ${beforeTests} → ${afterTests}` });
  }

  // 2. .skip / .fixme introduced (I5) — present in an added line, and not
  // merely carried over from a removed line
  if (added.some((l) => SKIP_FIXME.test(l)) && !removed.some((l) => SKIP_FIXME.test(l))) {
    violations.push({ kind: 'skip_introduced', detail: '.skip/.fixme introduced into test source' });
  }

  // 3. .only introduced (focuses the suite, hides other tests)
  if (added.some((l) => ONLY.test(l))) {
    violations.push({ kind: 'only_introduced', detail: '.only introduced into test source' });
  }

  // 4. snapshot introduced
  if (added.some((l) => SNAPSHOT.test(l)) && !removed.some((l) => SNAPSHOT.test(l))) {
    violations.push({ kind: 'snapshot_introduced', detail: 'snapshot matcher introduced' });
  }

  // 5. assertion weakening — a strong matcher removed, a weak one added nearby
  const weakAdded = added.some((l) => WEAK_MATCHERS.test(l));
  const strongRemoved = removed.some((l) => STRONG_MATCHER.test(l));
  if (weakAdded && strongRemoved) {
    violations.push({ kind: 'assertion_weakened', detail: 'a strong matcher was replaced by a vacuous one' });
  }

  // 6. expected-value / literal change inside an assertion call
  for (const line of added) {
    if (!/\bexpect\s*\(/.test(line) && !STRONG_MATCHER.test(line)) continue;
    // twin = a removed line with identical structure once ALL literals are
    // blanked, so a string- OR number-only change still pairs them up
    const struct = blankAllLiterals(line);
    const twin = removed.find((r) => blankAllLiterals(r) === struct && r !== line);
    if (twin) {
      const beforeLits = nonStringLiterals(twin).join(',');
      const afterLits = nonStringLiterals(line).join(',');
      const beforeStr = (twin.match(/'[^']*'|"[^"]*"/g) ?? []).join(',');
      const afterStr = (line.match(/'[^']*'|"[^"]*"/g) ?? []).join(',');
      if (beforeLits !== afterLits || beforeStr !== afterStr) {
        violations.push({ kind: 'expected_value_changed', detail: `expected value changed in assertion: ${twin.trim()} → ${line.trim()}` });
      }
    }
  }

  // 7. selector_heal: the diff must be confined to locator string arguments
  if (opts.mode === 'selector_heal') {
    for (const line of added) {
      // every changed line in a heal must contain a locator call from the allowlist
      if (!LOCATOR_CALL.test(line)) {
        violations.push({ kind: 'non_locator_change', detail: `heal changed a non-locator line: ${line}` });
        continue;
      }
      // the change must be in the STRING argument only: code structure must
      // match a removed line once string literals are blanked
      const struct = stripStringLiterals(line);
      const twin = removed.find((r) => stripStringLiterals(r) === struct);
      if (!twin) {
        violations.push({ kind: 'non_locator_change', detail: `heal changed code structure, not just a locator string: ${line}` });
      }
    }
  }

  return dedupe(violations);
}

function dedupe(violations: Violation[]): Violation[] {
  const seen = new Set<string>();
  return violations.filter((v) => {
    const key = `${v.kind}|${v.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
