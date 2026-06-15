// V3.1/V3.3 — the LLM rim: the faithfulness guard (the core verifying the
// LLM's prose), the ledger-free row projection, and the Anthropic adapter
// driven by a stubbed fetch (fully offline — no network, no key).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NullRimAdapter,
  AnthropicRimAdapter,
  proseCitesOnlyKnownIds,
  toRimRows,
} from '../../rim.js';
import type { AskRow } from '../../ask.js';
import type { Behavior, Verdict } from '../../types.js';

function row(id: string, evId: string | null, over: Partial<Behavior> = {}): AskRow {
  const behavior: Behavior = {
    id,
    statement: 'Coupon applies before tax',
    area: 'checkout/coupons',
    criticality: 'red',
    links: {},
    confirmed_by: { person: 'ana', at: '2026-06-01T00:00:00Z' },
    created_by: 'interview',
    status: 'active',
    ...over,
  };
  const verdict: Verdict = { state: 'VERIFIED', freshness: 0.84, computed_at: '2026-06-11T00:00:00Z', newest_evidence_id: evId };
  return {
    behavior,
    verdict,
    ...(evId ? { evidenceSource: { type: 'ci', ref: 'run 1', observed_at: '2026-06-10T00:00:00Z' } } : {}),
    score: 1,
  };
}

// ---- faithfulness guard (V3.3, I1) ----

test('guard accepts prose citing only ids present in the rows', () => {
  const rows = [row('BHV-0001', 'EV-0001')];
  assert.equal(proseCitesOnlyKnownIds('BHV-0001 is verified per EV-0001.', rows), true);
});

test('guard accepts prose with no ids at all', () => {
  assert.equal(proseCitesOnlyKnownIds('Coupons are well covered.', [row('BHV-0001', 'EV-0001')]), true);
});

test('guard REJECTS prose citing an unknown behavior id (hallucination)', () => {
  const rows = [row('BHV-0001', 'EV-0001')];
  assert.equal(proseCitesOnlyKnownIds('BHV-9999 covers gift cards.', rows), false);
});

test('guard REJECTS prose citing an unknown evidence id', () => {
  const rows = [row('BHV-0001', 'EV-0001')];
  assert.equal(proseCitesOnlyKnownIds('Verified per EV-7777.', rows), false);
});

test('guard handles all id prefixes', () => {
  const rows = [row('BHV-0001', 'EV-0001')];
  assert.equal(proseCitesOnlyKnownIds('See Q-0001', rows), false);
  assert.equal(proseCitesOnlyKnownIds('See ACT-0001', rows), false);
});

// ---- row projection (ledger-free) ----

test('toRimRows projects to plain JSON-serializable data', () => {
  const projected = toRimRows([row('BHV-0001', 'EV-0001')]);
  assert.deepEqual(JSON.parse(JSON.stringify(projected)), projected);
  assert.deepEqual(Object.keys(projected[0]!).sort(), [
    'behavior_id', 'criticality', 'evidence_source', 'freshness',
    'newest_evidence_id', 'observed_at', 'statement', 'verdict_state',
  ]);
  // no nested behavior/verdict object — the LLM can't see ledger structure
  assert.equal((projected[0] as unknown as Record<string, unknown>)['behavior'], undefined);
});

// ---- NullRimAdapter ----

test('NullRimAdapter is unavailable and returns undefined', async () => {
  const rim = new NullRimAdapter();
  assert.equal(rim.available(), false);
  assert.equal(await rim.proseOverRows(), undefined);
});

// ---- AnthropicRimAdapter with a stubbed fetch (offline) ----

function stubFetch(handler: (url: string, init: RequestInit) => unknown): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const body = handler(url, init);
    return { ok: true, json: async () => body } as Response;
  }) as unknown as typeof fetch;
}

test('adapter is unavailable without an API key', () => {
  const rim = new AnthropicRimAdapter({ fetchImpl: stubFetch(() => ({})) });
  // no key passed and (in CI) no env var → unavailable
  if (!process.env['ANTHROPIC_API_KEY']) assert.equal(rim.available(), false);
});

test('adapter returns the model text and sends rows-only (no ledger) to the API', async () => {
  let sentBody: unknown;
  const rim = new AnthropicRimAdapter({
    apiKey: 'test-key',
    fetchImpl: stubFetch((_url, init) => {
      sentBody = JSON.parse(String(init.body));
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Coupons are verified (BHV-0001).' }] };
    }),
  });
  assert.equal(rim.available(), true);
  const out = await rim.proseOverRows('do we test coupons?', [row('BHV-0001', 'EV-0001')]);
  assert.equal(out, 'Coupons are verified (BHV-0001).');

  // what we sent the API is the projected rows, not AskRow/ledger objects
  const payload = sentBody as { model: string; messages: { content: string }[] };
  assert.equal(payload.model, 'claude-opus-4-8');
  assert.match(payload.messages[0]!.content, /behavior_id/);
  assert.doesNotMatch(payload.messages[0]!.content, /"links"|confirmed_by/);
});

test('adapter returns undefined on a refusal stop_reason (never fabricates)', async () => {
  const rim = new AnthropicRimAdapter({
    apiKey: 'test-key',
    fetchImpl: stubFetch(() => ({ stop_reason: 'refusal', content: [] })),
  });
  assert.equal(await rim.proseOverRows('q', [row('BHV-0001', 'EV-0001')]), undefined);
});

test('adapter returns undefined on a non-ok HTTP response', async () => {
  const failing = (async () => ({ ok: false, status: 500, json: async () => ({}) } as Response)) as unknown as typeof fetch;
  const rim = new AnthropicRimAdapter({ apiKey: 'test-key', fetchImpl: failing });
  assert.equal(await rim.proseOverRows('q', [row('BHV-0001', 'EV-0001')]), undefined);
});

test('adapter returns undefined when fetch throws (network/timeout)', async () => {
  const throwing = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
  const rim = new AnthropicRimAdapter({ apiKey: 'test-key', fetchImpl: throwing });
  assert.equal(await rim.proseOverRows('q', [row('BHV-0001', 'EV-0001')]), undefined);
});
