// Churn index (CG-2.2, SPEC §4/§6 ingest:diff): lines changed under a
// behavior's implemented_in globs since an evidence timestamp, from
// `git log --numstat`. Behind a small port so absence (no git, no repo)
// degrades the churn factor to zero — feature degrades, core stands (SPEC §2).
import { spawnSync } from 'node:child_process';
import { globMatch } from './linking.js';

export interface ChurnIndex {
  /** Total lines added+deleted in files matching `globs` since `sinceIso`. */
  linesChangedSince(globs: string[], sinceIso: string): number;
}

/** No repo available: churn factor contributes nothing (exp(0) = 1). */
export class NullChurnIndex implements ChurnIndex {
  linesChangedSince(): number {
    return 0;
  }
}

/** Fixed table for tests and demos — decay logic never shells out in tests. */
export class StaticChurnIndex implements ChurnIndex {
  constructor(private readonly linesByGlob: Record<string, number>) {}
  linesChangedSince(globs: string[]): number {
    return globs.reduce((sum, g) => sum + (this.linesByGlob[g] ?? 0), 0);
  }
}

interface FileChurn {
  path: string;
  lines: number;
}

export class GitChurnIndex implements ChurnIndex {
  private readonly cache = new Map<string, FileChurn[]>();

  constructor(private readonly repoDir: string) {}

  private numstatSince(sinceIso: string): FileChurn[] {
    const cached = this.cache.get(sinceIso);
    if (cached) return cached;
    const result = spawnSync(
      'git',
      ['log', `--since=${sinceIso}`, '--numstat', '--format='],
      { cwd: this.repoDir, encoding: 'utf8', windowsHide: true },
    );
    if (result.status !== 0) {
      throw new Error(`git log --numstat failed in ${this.repoDir}: ${result.stderr || result.error?.message || 'unknown'}`);
    }
    const files: FileChurn[] = [];
    for (const line of result.stdout.split('\n')) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (!m) continue;
      const added = m[1] === '-' ? 0 : Number(m[1]);
      const deleted = m[2] === '-' ? 0 : Number(m[2]);
      files.push({ path: (m[3] ?? '').trim(), lines: added + deleted });
    }
    this.cache.set(sinceIso, files);
    return files;
  }

  linesChangedSince(globs: string[], sinceIso: string): number {
    if (globs.length === 0) return 0;
    return this.numstatSince(sinceIso)
      .filter((f) => globs.some((g) => globMatch(g, f.path)))
      .reduce((sum, f) => sum + f.lines, 0);
  }
}
