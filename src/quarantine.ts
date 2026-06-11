// Quarantine lane (CG-6.2/6.3, SPEC §7.3). An entry in quarantine.json routes
// a flaky test into a separate NON-BLOCKING CI lane. Test source is NEVER
// edited — no .skip/.fixme (I5); the lane is a data file CI consults.
// Creating an entry (with a ticket + expiry) is an ACT with a receipt (I4).
// Default expiry 7 days; expiry without resolution escalates in cart brief.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { type Clock, isoNow } from './clock.js';

export interface QuarantineEntry {
  test_id: string;
  ticket: string;
  entered_at: string;
  expires_at: string;
  reason?: string;
}

export interface QuarantineFile {
  version: 1;
  entries: QuarantineEntry[];
}

const DEFAULT_EXPIRY_DAYS = 7;
const MS_PER_DAY = 86_400_000;

export function loadQuarantine(path: string): QuarantineFile {
  if (!existsSync(path)) return { version: 1, entries: [] };
  const data = JSON.parse(readFileSync(path, 'utf8')) as QuarantineFile;
  return { version: 1, entries: data.entries ?? [] };
}

function writeQuarantine(path: string, file: QuarantineFile): void {
  // stable key order so the file diffs cleanly in review
  const sorted = {
    version: 1 as const,
    entries: [...file.entries].sort((a, b) => a.test_id.localeCompare(b.test_id)),
  };
  writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
}

export interface AddQuarantineInput {
  testId: string;
  ticket: string;
  reason?: string;
  expiryDays?: number;
}

/** Pure entry builder (the side effect — writing the file — is the caller's). */
export function buildEntry(input: AddQuarantineInput, clock: Clock): QuarantineEntry {
  const enteredMs = clock().getTime();
  const days = input.expiryDays ?? DEFAULT_EXPIRY_DAYS;
  return {
    test_id: input.testId,
    ticket: input.ticket,
    entered_at: isoNow(clock),
    expires_at: new Date(enteredMs + days * MS_PER_DAY).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  };
}

/** Upsert by test_id; returns the new file state and whether it replaced. */
export function upsertEntry(file: QuarantineFile, entry: QuarantineEntry): { file: QuarantineFile; replaced: boolean } {
  const existing = file.entries.findIndex((e) => e.test_id === entry.test_id);
  const entries = [...file.entries];
  const replaced = existing >= 0;
  if (replaced) entries[existing] = entry;
  else entries.push(entry);
  return { file: { version: 1, entries }, replaced };
}

export function removeEntry(file: QuarantineFile, testId: string): { file: QuarantineFile; removed: boolean } {
  const entries = file.entries.filter((e) => e.test_id !== testId);
  return { file: { version: 1, entries }, removed: entries.length !== file.entries.length };
}

/** Entries past their expiry as of `clock` — escalated in the brief (CG-6.3). */
export function expiredEntries(file: QuarantineFile, clock: Clock): QuarantineEntry[] {
  const now = clock().getTime();
  return file.entries
    .filter((e) => new Date(e.expires_at).getTime() < now)
    .sort((a, b) => a.expires_at.localeCompare(b.expires_at));
}

/** Whether a test_id is currently routed to the non-blocking lane (CI uses this). */
export function isQuarantined(file: QuarantineFile, testId: string, clock: Clock): boolean {
  const entry = file.entries.find((e) => e.test_id === testId);
  if (!entry) return false;
  return new Date(entry.expires_at).getTime() >= clock().getTime();
}

export { writeQuarantine, DEFAULT_EXPIRY_DAYS };
