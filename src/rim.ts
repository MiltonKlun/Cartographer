// The LLM rim adapter (Constitution §1): the LLM sits between the query API
// and the human. It receives STRUCTURED ROWS ONLY — the interface gives it
// no ledger, no database handle, no way to mutate. Prose is an enhancement
// over the rows, never a replacement: every surface must render fully
// without it (SPEC §12, CG-3.3).
import type { AskRow } from './ask.js';

export interface RimAdapter {
  available(): boolean;
  /** May return undefined (decline); the surface then stays rows-only. */
  proseOverRows(question: string, rows: AskRow[]): string | undefined;
}

/** Default for v1: no LLM configured — all surfaces run rows-only. */
export class NullRimAdapter implements RimAdapter {
  available(): boolean {
    return false;
  }
  proseOverRows(): undefined {
    return undefined;
  }
}
