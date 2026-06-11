// Red-domain criticality guesser (CG-4.3, SPEC §11). Guesses are PROPOSALS
// only — a human confirms or overrides during the interview (I3). `red` is
// reserved for money, permissions/roles, security, compliance, and data
// integrity (SPEC §3.1); everything else defaults to `normal`.
import type { Criticality } from './types.js';

interface DomainRule {
  criticality: Criticality;
  keywords: RegExp;
}

// Order matters: first match wins, red domains listed first.
const DOMAIN_RULES: DomainRule[] = [
  {
    criticality: 'red',
    keywords:
      /\b(payment|pay|charge|refund|invoic|billing|price|pricing|coupon|discount|tax|currency|money|wallet|checkout|purchase|subscri)/i,
  },
  {
    criticality: 'red',
    keywords:
      /\b(permission|role|auth|authoriz|authentic|login|logout|password|credential|session|token|admin|privileg|access[- ]?control|rbac|acl|owner|tenant)/i,
  },
  {
    criticality: 'red',
    keywords: /\b(security|secret|encrypt|csrf|xss|sql[- ]?inject|sanitiz|vulnerab|exploit)/i,
  },
  {
    criticality: 'red',
    keywords: /\b(complian|gdpr|hipaa|pci|audit|consent|retention|privacy|pii)/i,
  },
  {
    criticality: 'red',
    keywords:
      /\b(delete|destroy|purge|wipe|corrupt|integrity|migration|backup|restore|data[- ]?loss|overwrite|bulk[- ]?(delete|update|remove))/i,
  },
  {
    criticality: 'high',
    keywords: /\b(checkout|cart|order|export|import|upload|download|submit|save|publish|deploy)/i,
  },
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
