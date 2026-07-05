// CLI surface tests — spawn the real `bin/cart.mjs` against a temp ledger.
// Closes the coverage gap on argument parsing, exit codes, and command
// wiring (the modules under it are unit-tested separately). Also pins the
// --no-receipt export determinism fix (Finding 1 from the system eval).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// compiled to dist/test/e2e/cli.test.js → repo root is three levels up
const BIN = fileURLToPath(new URL('../../../bin/cart.mjs', import.meta.url));

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function freshDb(): string {
  return join(mkdtempSync(join(tmpdir(), 'cart-cli-')), 'ledger.db');
}

function cart(db: string, ...args: string[]): RunResult {
  const r = spawnSync('node', [BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CART_DB: db },
    windowsHide: true,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Like `cart`, but feeds `input` on stdin (for the live interview loop). */
function cartStdin(db: string, input: string, ...args: string[]): RunResult {
  const r = spawnSync('node', [BIN, ...args], {
    encoding: 'utf8',
    input,
    env: { ...process.env, CART_DB: db, CART_VAULT: join(mkdtempSync(join(tmpdir(), 'cart-cli-v-')), 'vault') },
    windowsHide: true,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

test('init creates a ledger and exits 0', () => {
  const db = freshDb();
  const r = cart(db, 'init');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /created ledger|opened ledger/);
});

test('help (no args) exits 0', () => {
  const r = cart(freshDb(), 'help');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /cart — Cartographer behavior ledger/);
});

test('unknown command exits 1', () => {
  const r = cart(freshDb(), 'frobnicate');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown command/);
});

test('I1: a citation-less claim is refused with exit 1', () => {
  const r = cart(freshDb(), 'claim', '--text', 'everything is covered');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing citation-less claim \(I1\)/);
});

test('a cited claim renders and exits 0', () => {
  const r = cart(freshDb(), 'claim', '--text', 'viewer cannot bulk-delete', '--cite', 'BHV-0001');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\[BHV-0001\]/);
});

test('verdict on a missing behavior exits 1', () => {
  const db = freshDb();
  cart(db, 'init');
  const r = cart(db, 'verdict', 'BHV-9999');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no such behavior/);
});

test('behavior add → confirm → list round-trips through the CLI', () => {
  const db = freshDb();
  cart(db, 'init');
  const add = cart(db, 'behavior', 'add', '--statement', 'Coupon applies before tax', '--area', 'checkout', '--criticality', 'red', '--actor', 'eval');
  assert.equal(add.status, 0);
  assert.match(add.stdout, /BHV-0001 created/);
  const confirm = cart(db, 'behavior', 'confirm', 'BHV-0001', '--person', 'eval');
  assert.equal(confirm.status, 0);
  const list = cart(db, 'behavior', 'list');
  assert.match(list.stdout, /Coupon applies before tax/);
});

test('Finding 1: cart export --no-receipt is byte-identical on an unchanged ledger', () => {
  const db = freshDb();
  cart(db, 'init');
  cart(db, 'behavior', 'add', '--statement', 'x is true', '--area', 'a', '--actor', 'eval');
  const dir = mkdtempSync(join(tmpdir(), 'cart-cli-exp-'));
  const out1 = join(dir, 'a.jsonl');
  const out2 = join(dir, 'b.jsonl');

  const e1 = cart(db, 'export', '--no-receipt', '--out', out1);
  const e2 = cart(db, 'export', '--no-receipt', '--out', out2);
  assert.equal(e1.status, 0);
  assert.equal(e2.status, 0);
  assert.match(e1.stdout, /no receipt — pure snapshot/);
  assert.equal(
    readFileSync(out1, 'utf8'),
    readFileSync(out2, 'utf8'),
    '--no-receipt exports of an unchanged ledger must be byte-identical (SPEC §5)',
  );
});

test('the default (receipted) export records its own receipt — so it is NOT idempotent', () => {
  const db = freshDb();
  cart(db, 'init');
  cart(db, 'behavior', 'add', '--statement', 'x is true', '--area', 'a', '--actor', 'eval');
  const dir = mkdtempSync(join(tmpdir(), 'cart-cli-exp2-'));
  const out1 = join(dir, 'a.jsonl');
  const out2 = join(dir, 'b.jsonl');

  const e1 = cart(db, 'export', '--out', out1);
  cart(db, 'export', '--out', out2);
  assert.match(e1.stdout, /receipt ACT-/);
  // the second export contains the first export's receipt → they differ by design (I4)
  assert.notEqual(readFileSync(out1, 'utf8'), readFileSync(out2, 'utf8'));
});

test('guardrails-check exits 1 on a forbidden patch, 0 on a clean locator heal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cart-cli-gr-'));
  const orig = join(dir, 'orig.ts');
  const bad = join(dir, 'bad.ts');
  const good = join(dir, 'good.ts');
  const base = "test('t', async ({ page }) => {\n  await page.locator('#a').click();\n  expect(v).toBe('9.00');\n});\n";
  writeFileSync(orig, base);
  writeFileSync(bad, base.replace("toBe('9.00')", "toBe('10.00')"));
  writeFileSync(good, base.replace("'#a'", "'#better'"));

  assert.equal(cart(freshDb(), 'guardrails-check', orig, bad, '--selector-heal').status, 1);
  assert.equal(cart(freshDb(), 'guardrails-check', orig, good, '--selector-heal').status, 0);
});

// V4.2 — command/doc parity: every top-level command documented in `cart help`
// must be recognized by the dispatch switch (no doc-vs-code drift). A new
// documented command with no handler, or a renamed handler, fails here.
test('V4.2: every command in `cart help` is recognized by the dispatcher', () => {
  const help = cart(freshDb(), 'help').stdout;
  // grab the leading `cart <command>` token from each usage line
  const commands = new Set<string>();
  for (const m of help.matchAll(/^\s+cart ([a-z][a-z-]*)\b/gm)) {
    commands.add(m[1]!);
  }
  assert.ok(commands.size >= 10, `expected many documented commands, found ${commands.size}`);

  for (const cmd of commands) {
    // run the bare command with no args against a fresh db; a recognized
    // command never prints "unknown command" (it may usage-error, that's fine)
    const r = cart(freshDb(), cmd);
    assert.doesNotMatch(
      r.stderr + r.stdout,
      /unknown command/,
      `documented command "${cmd}" is not wired into the dispatch switch`,
    );
  }
});

test('V4.3: cart doctor reports readiness and exits 0 on a healthy env', () => {
  const r = cart(freshDb(), 'doctor');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /environment readiness/);
  assert.match(r.stdout, /node:|node:sqlite/);
  assert.match(r.stdout, /READY/);
});

// H6 — the live interview loop over real piped stdin. Bootstrap the got
// fixtures into unconfirmed proposals, then confirm one and quit; assert the
// confirm persisted and the rest are still pending (durable immediate-apply).
const REPO = fileURLToPath(new URL('../../../testdata/real', import.meta.url));

test('H6: cart interview --live confirms one via piped stdin, then quits', () => {
  const db = freshDb();
  cart(db, 'init');
  const boot = cart(db, 'bootstrap', 'import', REPO, '--apply', '--actor', 'eval');
  assert.equal(boot.status, 0);
  assert.match(boot.stdout, /behavior proposal/);

  // pipe: confirm the first proposal (y), then quit (q)
  const r = cartStdin(db, 'y\nq\n', 'interview', '--live', '--as', 'eval');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /✓ BHV-0001 confirmed/);
  assert.match(r.stdout, /1 confirmed/);
  assert.match(r.stdout, /still pending/);

  // exactly one is confirmed now; the rest remain proposals
  const list = cart(db, 'behavior', 'list');
  assert.match(list.stdout, /BHV-0001/);
  // a second live run still finds pending proposals (durable, not all-or-nothing)
  const again = cartStdin(db, 'q\n', 'interview', '--live', '--as', 'eval');
  assert.match(again.stdout, /proposal\(s\) awaiting your judgment/);
});

test('H6: cart interview --live without --as exits 1 (attribution required, I3)', () => {
  const db = freshDb();
  cart(db, 'init');
  const r = cartStdin(db, '', 'interview', '--live');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /requires --as/);
});
