// Red-domain criticality guesser (CG-4.3, SPEC §11). Guesses are PROPOSALS
// only — a human confirms or overrides during the interview (I3). `red` is
// reserved for money, permissions/roles, security, compliance, and data
// integrity (SPEC §3.1); everything else defaults to `normal`.
import type { Criticality } from './types.js';

interface DomainRule {
  criticality: Criticality;
  keywords: RegExp;
}

// Each rule is built from two lists (H4.3):
//   words — complete words, matched with BOTH boundaries (`\bpay\b`), so
//           short tokens don't prefix-match ("payload", "Taxi", "author",
//           "Cartesian" must NOT trigger red/high).
//   stems — deliberate prefixes, matched with a leading boundary only
//           (`\binvoic`), to catch inflections (invoice/invoicing). Every
//           stem is listed explicitly so the prefix-matching is intentional,
//           never an accident.
// Order matters: first match wins, red domains listed first.
function rule(criticality: Criticality, words: string[], stems: string[] = []): DomainRule {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const alts = [...words.map((w) => `${esc(w)}\\b`), ...stems.map((s) => esc(s))];
  return { criticality, keywords: new RegExp(`\\b(?:${alts.join('|')})`, 'i') };
}

const DOMAIN_RULES: DomainRule[] = [
  // money
  rule('red',
    ['payment', 'pay', 'charge', 'refund', 'billing', 'price', 'pricing', 'coupon', 'discount', 'tax', 'currency', 'money', 'wallet', 'checkout', 'purchase'],
    ['invoic', 'subscri']),
  // permissions / roles / auth. `auth` is a WORD (so "author" is not a match);
  // authoriz/authentic are stems for the inflections.
  rule('red',
    ['permission', 'role', 'login', 'logout', 'password', 'credential', 'session', 'token', 'admin', 'rbac', 'acl', 'owner', 'tenant', 'access control', 'access-control', 'auth'],
    ['authoriz', 'authentic', 'privileg']),
  // security
  rule('red',
    ['security', 'secret', 'csrf', 'xss', 'sql inject', 'sql-inject', 'exploit'],
    ['encrypt', 'sanitiz', 'vulnerab']),
  // compliance
  rule('red',
    ['gdpr', 'hipaa', 'pci', 'audit', 'consent', 'retention', 'privacy', 'pii'],
    ['complian']),
  // data integrity
  rule('red',
    ['delete', 'destroy', 'purge', 'wipe', 'integrity', 'migration', 'backup', 'restore', 'data loss', 'data-loss', 'overwrite'],
    ['corrupt', 'bulk']),
  // high (non-red but consequential flows)
  rule('high',
    ['checkout', 'cart', 'order', 'export', 'import', 'upload', 'download', 'submit', 'save', 'publish', 'deploy']),
];

export interface CriticalityGuess {
  criticality: Criticality;
  matched: string | null;
}

/** Guess from a statement + area. Returns the match for human review. */
export function guessCriticality(text: string): CriticalityGuess {
  for (const rule of DOMAIN_RULES) {
    const m = rule.keywords.exec(text);
    if (m) return { criticality: rule.criticality, matched: m[0].toLowerCase() };
  }
  return { criticality: 'normal', matched: null };
}
