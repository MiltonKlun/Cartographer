// `cart export` — deterministic JSONL snapshot of the whole ledger (I11):
// one record per line, recursively sorted keys, fixed table order. Identical
// DB state ⇒ byte-identical output (tested).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Ledger, TableName } from './db.js';

const EXPORT_ORDER: TableName[] = ['behaviors', 'evidence', 'questions', 'sessions', 'receipts'];

/** JSON.stringify with object keys sorted recursively (arrays keep order). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function exportLedger(ledger: Ledger): string {
  const lines: string[] = [];
  for (const table of EXPORT_ORDER) {
    for (const record of ledger.allRecords(table)) {
      lines.push(canonicalJson({ table, record }));
    }
  }
  for (const m of ledger.allMutations()) {
    lines.push(canonicalJson({ table: 'mutations', record: m }));
  }
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

export function exportLedgerToFile(ledger: Ledger, outPath: string): { records: number } {
  const jsonl = exportLedger(ledger);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, jsonl, 'utf8');
  return { records: jsonl === '' ? 0 : jsonl.trimEnd().split('\n').length };
}
