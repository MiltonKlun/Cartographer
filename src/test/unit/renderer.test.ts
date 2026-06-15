// CG-0.4 — the claims renderer enforces I1 (evidence or silence) and
// I2 (decay is load-bearing) at the only ledger→prose chokepoint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderClaims, RenderError, type Claim } from '../../renderer.js';
import type { Verdict } from '../../types.js';

const OK = { degraded: false } as const;

const goodVerdict: Verdict = {
  state: 'VERIFIED',
  freshness: 0.84,
  computed_at: '2026-06-10T08:00:00Z',
  newest_evidence_id: 'EV-9311',
};

test('I1: citation-less claim is refused', () => {
  assert.throws(() => renderClaims([{ text: 'coupon stacking is covered' }], OK), RenderError);
});

test('I1: empty citations array is refused', () => {
  assert.throws(() => renderClaims([{ text: 'covered', citations: [] }], OK), RenderError);
});

test('I1: malformed citation id is refused', () => {
  assert.throws(
    () => renderClaims([{ text: 'covered', citations: ['tests/foo.spec.ts'] }], OK),
    RenderError,
  );
});

test('I1: cited claim renders with its citations', () => {
  const out = renderClaims([{ text: 'two coupons cannot stack', citations: ['BHV-0093', 'EV-9311'] }], OK);
  assert.match(out, /two coupons cannot stack/);
  assert.match(out, /\[BHV-0093, EV-9311\]/);
});

test('I1: explicit inference label renders without citations, marked', () => {
  const out = renderClaims([{ text: 'likely a race condition', label: 'inference' }], OK);
  assert.match(out, /^inference: likely a race condition/);
});

test('I1: explicit unknown label renders without citations, marked', () => {
  const out = renderClaims([{ text: 'gift-card × coupon interaction', label: 'unknown' }], OK);
  assert.match(out, /^UNKNOWN: gift-card/);
});

test('I2: verdict without freshness is rejected', () => {
  const v = { ...goodVerdict } as Partial<Verdict>;
  delete v.freshness;
  const claim: Claim = { text: 'x', citations: ['BHV-0001'], verdict: v as Verdict };
  assert.throws(() => renderClaims([claim], OK), /freshness/);
});

test('I2: verdict without computed_at is rejected', () => {
  const v = { ...goodVerdict } as Partial<Verdict>;
  delete v.computed_at;
  const claim: Claim = { text: 'x', citations: ['BHV-0001'], verdict: v as Verdict };
  assert.throws(() => renderClaims([claim], OK), /computed_at/);
});

test('I2: freshness outside [0,1] is rejected', () => {
  const claim: Claim = { text: 'x', citations: ['BHV-0001'], verdict: { ...goodVerdict, freshness: 1.5 } };
  assert.throws(() => renderClaims([claim], OK), /freshness/);
});

test('I2: invalid verdict state is rejected', () => {
  const claim: Claim = {
    text: 'x',
    citations: ['BHV-0001'],
    verdict: { ...goodVerdict, state: 'PROBABLY_FINE' as Verdict['state'] },
  };
  assert.throws(() => renderClaims([claim], OK), /state/);
});

test('I2: complete verdict renders state, freshness and newest evidence', () => {
  const out = renderClaims([{ text: 'viewer cannot bulk-delete', citations: ['BHV-0142'], verdict: goodVerdict }], OK);
  assert.match(out, /VERIFIED {2}F=0\.84/);
  assert.match(out, /EV-9311/);
});

test('I6: degraded health injects the banner before all claims', () => {
  const out = renderClaims(
    [{ text: 'x', citations: ['BHV-0001'] }],
    { degraded: true, reason: 'CI ingestion broken', since: '2026-06-06' },
  );
  const lines = out.split('\n');
  assert.match(lines[0] ?? '', /HEALTH DEGRADED — CI ingestion broken since 2026-06-06/);
});

test('a bad claim anywhere in the batch produces no partial output', () => {
  const claims: Claim[] = [{ text: 'good', citations: ['EV-0001'] }, { text: 'bad uncited claim' }];
  assert.throws(() => renderClaims(claims, OK), RenderError);
});
