// Diff parsing (CG-5.1, SPEC §6 ingest:diff). Two sources, one shape:
//   - `git diff --numstat <range>` for a local ref range
//   - a unified-diff / numstat file pasted from a PR
// Produces the touched-file index that `cart pr` ranks behaviors against.
// Behind a small port so absence of git degrades the surface, not the core.
import { spawnSync } from 'node:child_process';

export interface FileChange {
  path: string;
  added: number;
  deleted: number;
  /** New file in this diff (no prior content). */
  isNew: boolean;
}

export interface DiffSummary {
  files: FileChange[];
  totalAdded: number;
  totalDeleted: number;
}

function summarize(files: FileChange[]): DiffSummary {
  return {
    files,
    totalAdded: files.reduce((s, f) => s + f.added, 0),
    totalDeleted: files.reduce((s, f) => s + f.deleted, 0),
  };
}

/**
 * Parse `git diff --numstat --diff-filter` style output. A numstat line is
 * `<added>\t<deleted>\t<path>`; binary files show `-\t-`. New-file detection
 * needs `--summary`-style "create mode" lines, parsed when present.
 */
export function parseNumstat(text: string): DiffSummary {
  const created = new Set<string>();
  for (const m of text.matchAll(/^\s*create mode \d+ (.+)$/gm)) {
    created.add((m[1] ?? '').trim());
  }
  const files: FileChange[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    const path = (m[3] ?? '').trim().replace(/\\/g, '/');
    const added = m[1] === '-' ? 0 : Number(m[1]);
    const deleted = m[2] === '-' ? 0 : Number(m[2]);
    files.push({ path, added, deleted, isNew: created.has(path) });
  }
  return summarize(files);
}

export interface DiffPort {
  diff(ref: string): DiffSummary;
}

/** Runs git locally. `ref` is any range git understands, e.g. `main...HEAD`. */
export class GitDiff implements DiffPort {
  constructor(private readonly repoDir: string) {}

  diff(ref: string): DiffSummary {
    const numstat = this.run(['diff', '--numstat', ref]);
    const summary = this.run(['diff', '--summary', ref]);
    return parseNumstat(`${numstat}\n${summary}`);
  }

  private run(args: string[]): string {
    const r = spawnSync('git', args, { cwd: this.repoDir, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.error?.message || 'unknown'}`);
    }
    return r.stdout;
  }
}

/** Parse a diff already captured to a file/string (PR webhook, paste). */
export function diffFromText(text: string): DiffSummary {
  return parseNumstat(text);
}
