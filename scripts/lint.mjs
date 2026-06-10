// Zero-dependency lint (dependency policy: BUILD-PLAN rule 2).
// Checks the things the guardrail philosophy cares about in our own code.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const rules = [
  { name: 'no-test-only', pattern: /\.only\s*\(/, message: '.only( left in source' },
  { name: 'no-test-skip', pattern: /\.skip\s*\(/, message: '.skip( left in source' },
  { name: 'no-ts-nocheck', pattern: /@ts-nocheck/, message: '@ts-nocheck forbidden' },
  { name: 'no-ts-ignore', pattern: /@ts-ignore/, message: '@ts-ignore forbidden (use @ts-expect-error with a reason if unavoidable)' },
  { name: 'no-debugger', pattern: /^\s*debugger\b/m, message: 'debugger statement left in source' },
  { name: 'no-eslint-disable', pattern: /eslint-disable/, message: 'stray eslint pragma (eslint is not in this stack)' },
];

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.name.endsWith('.ts')) yield p;
  }
}

let failures = 0;
for (const file of walk(SRC)) {
  const text = readFileSync(file, 'utf8');
  for (const rule of rules) {
    if (rule.pattern.test(text)) {
      console.error(`lint: ${file}: ${rule.message} [${rule.name}]`);
      failures++;
    }
  }
}

if (failures > 0) {
  console.error(`lint: ${failures} problem(s)`);
  process.exit(1);
}
console.log('lint: clean');
