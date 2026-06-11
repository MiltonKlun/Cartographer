// Decline detection (I9) — a tool that knows when it isn't worth using is a
// tool people believe when it says it is. For one-off scripts, throwaway
// spikes, and work with no regression future, Cartographer recommends raw
// prompting and names exactly what is forfeited (the evidence trail).
// Deterministic heuristic; the eval harness checks it (CG-10.1).

const ONE_OFF = /\b(one[- ]?off|throwaway|throw[- ]?away|quick (?:script|hack|spike)|spike|prototype|proof[- ]of[- ]concept|poc|scratch|sandbox|playground|just (?:trying|testing|exploring)|experiment(?:al)?|disposable|temporary|temp script|demo script)\b/i;
const NO_REGRESSION = /\b(no (?:need to|reason to) (?:keep|test|maintain)|won['’]?t (?:reuse|keep|maintain)|delete (?:it )?after|run once|single use|not (?:shipping|production))\b/i;

// signals that the work DOES have a regression future → do NOT decline
const KEEP = /\b(regression|production|ship|release|CI|pipeline|coverage|long[- ]?lived|maintain|recurring|every (?:release|sprint|deploy)|test suite|guard against)\b/i;

export interface DeclineVerdict {
  decline: boolean;
  reason: string;
}

/**
 * Decide whether to recommend raw prompting instead of the ledger. Returns a
 * decline verdict with the message to show. Keep-signals override one-off
 * signals (when in doubt, the map is cheap insurance).
 */
export function shouldDecline(request: string): DeclineVerdict {
  const keep = KEEP.test(request);
  const oneOff = ONE_OFF.test(request);
  const noRegression = NO_REGRESSION.test(request);

  if (!keep && (oneOff || noRegression)) {
    return {
      decline: true,
      reason:
        'This is cheaper to just prompt for directly — no ledger needed. ' +
        'You\'d forfeit the evidence trail, which for a one-off is fine. Want me to just do it?',
    };
  }
  return { decline: false, reason: 'has a regression future — worth a behavior + evidence in the ledger' };
}
