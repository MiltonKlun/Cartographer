// The LLM rim adapter (Constitution §1): the LLM sits between the query API
// and the human. It receives STRUCTURED ROWS ONLY — the interface gives it
// no ledger, no database handle, no way to mutate. Prose is an enhancement
// over the rows, never a replacement: every surface must render fully
// without it (SPEC §12, CG-3.3).
//
// Dependency policy (BUILD-PLAN rule 2): the live adapter calls the Anthropic
// API through Node 22's built-in `fetch` — no SDK, no new dependency.
import type { AskRow } from './ask.js';

export interface RimAdapter {
  available(): boolean;
  /** May return undefined (decline / error / unavailable); surface stays rows-only. */
  proseOverRows(question: string, rows: AskRow[]): Promise<string | undefined>;
}

/** Default for v1: no LLM configured — all surfaces run rows-only. */
export class NullRimAdapter implements RimAdapter {
  available(): boolean {
    return false;
  }
  async proseOverRows(): Promise<undefined> {
    return undefined;
  }
}

/**
 * Prose-faithfulness guard (V3.3, I1). The LLM proposes; the core verifies.
 * A prose pass is accepted only if every ledger id it cites (BHV-/EV-/Q-/SES-/
 * ACT-) appears in the rows it was given. Any unknown id ⇒ the prose is
 * rejected and the surface stays rows-only — the LLM can never introduce a
 * citation the deterministic core didn't already produce.
 */
const ID_IN_PROSE = /\b(?:BHV|EV|Q|SES|ACT)-\d{4,}\b/g;

export function proseCitesOnlyKnownIds(prose: string, rows: AskRow[]): boolean {
  const known = new Set<string>();
  for (const r of rows) {
    known.add(r.behavior.id);
    if (r.verdict.newest_evidence_id) known.add(r.verdict.newest_evidence_id);
  }
  for (const id of prose.match(ID_IN_PROSE) ?? []) {
    if (!known.has(id)) return false;
  }
  return true;
}

/**
 * Verdict-contradiction guard (H7.4, I1/I2). The id guard alone lets a lie
 * like "BHV-0001 is fully verified" pass over a STALE row — every id is known,
 * but the *state claim* is a fabrication. This guard maps state-claim words in
 * the prose to the verdict state they assert; if the prose asserts a state
 * that NO row actually carries, the prose is contradictory and must be
 * discarded (rows stay the source of truth).
 *
 * Word-level, not an NLI checker (matches the project's regex-guard idiom).
 * Deliberately conservative: negations ("not verified") are also treated as a
 * verified-claim and discarded — safe, because the rows are always shown
 * anyway, so we lose an occasional true prose rather than risk a false one.
 */
const STATE_CLAIMS: { re: RegExp; state: string }[] = [
  { re: /\b(?:verified|passing|passes|green|safe to ship|safe to merge)\b/i, state: 'VERIFIED' },
  { re: /\b(?:failing|fails|broken|violated|regressed)\b/i, state: 'FAILING' },
  { re: /\bstale\b/i, state: 'STALE' },
];

export function proseContradictsVerdicts(prose: string, rows: AskRow[]): boolean {
  const present = new Set<string>(rows.map((r) => r.verdict.state));
  for (const { re, state } of STATE_CLAIMS) {
    if (re.test(prose) && !present.has(state)) {
      return true; // prose asserts a state no row carries → contradiction
    }
  }
  return false;
}

/** A compact, ledger-free projection of a row — all the LLM ever sees. */
interface RimRowView {
  behavior_id: string;
  statement: string;
  criticality: string;
  verdict_state: string;
  freshness: number;
  newest_evidence_id: string | null;
  evidence_source: string | null;
  observed_at: string | null;
}

/** Project AskRows to plain data — strips any object identity / handles. */
export function toRimRows(rows: AskRow[]): RimRowView[] {
  return rows.map((r) => ({
    behavior_id: r.behavior.id,
    statement: r.behavior.statement,
    criticality: r.behavior.criticality,
    verdict_state: r.verdict.state,
    freshness: Number(r.verdict.freshness.toFixed(2)),
    newest_evidence_id: r.verdict.newest_evidence_id,
    evidence_source: r.evidenceSource ? `${r.evidenceSource.type} ${r.evidenceSource.ref}` : null,
    observed_at: r.evidenceSource ? r.evidenceSource.observed_at : null,
  }));
}

const SYSTEM_PROMPT = [
  'You are the prose rim of Cartographer, a QA behavior ledger. You receive',
  'STRUCTURED ROWS (behaviors with their computed verdicts) and a question.',
  'Write a 1–3 sentence answer that summarizes ONLY what the rows say.',
  'Hard rules (the deterministic core enforces these; violating them gets your',
  'answer discarded):',
  '- Cite only behavior_ids and evidence_ids that appear in the rows. Never',
  '  invent an ID, a behavior, or a verdict.',
  '- Never upgrade a verdict (e.g. do not call a STALE behavior "verified").',
  '- Lead with FAILING behaviors if any are present.',
  '- If the rows do not answer the question, say so plainly.',
  'Return prose only — no markdown headers, no preamble like "Based on".',
].join('\n');

export interface AnthropicRimOptions {
  apiKey?: string;
  model?: string;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Live rim backed by the Anthropic Messages API via built-in fetch. Activates
 * only when ANTHROPIC_API_KEY is set; otherwise available() is false and the
 * surface falls back to rows-only (SPEC §12). proseOverRows never throws — any
 * API/network/refusal failure returns undefined, and the rows-only render
 * stands. The adapter is handed projected rows only: no ledger, no handles.
 */
export class AnthropicRimAdapter implements RimAdapter {
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AnthropicRimOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env['ANTHROPIC_API_KEY'];
    this.model = opts.model ?? process.env['CART_RIM_MODEL'] ?? 'claude-opus-4-8';
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  available(): boolean {
    return Boolean(this.apiKey);
  }

  async proseOverRows(question: string, rows: AskRow[]): Promise<string | undefined> {
    if (!this.apiKey) return undefined;
    const payload = {
      model: this.model,
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Question: ${question}\n\nRows (JSON):\n${JSON.stringify(toRimRows(rows), null, 2)}`,
        },
      ],
    };
    try {
      const res = await this.fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) return undefined; // 4xx/5xx → rows-only
      const data = (await res.json()) as {
        stop_reason?: string;
        content?: { type: string; text?: string }[];
      };
      // safety refusal (or any non-text stop) → rows-only, never fabricate
      if (data.stop_reason === 'refusal') return undefined;
      const text = (data.content ?? [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('')
        .trim();
      return text.length > 0 ? text : undefined;
    } catch {
      return undefined; // network error, bad JSON, timeout → rows-only
    }
  }
}
