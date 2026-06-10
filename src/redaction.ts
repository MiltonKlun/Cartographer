// The redaction stage (I10): runs at ingestion, before anything reaches the
// vault. A 'scrub' rule replaces matches in-place; a 'quarantine' rule hit
// means the blob is NOT stored — the evidence record is metadata-only.
// Secrets never enter the ledger. This stage is not optional and has no
// bypass flag.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from './paths.js';

export interface RedactionRule {
  name: string;
  pattern: string;
  action: 'scrub' | 'quarantine';
}

export interface RedactionResult {
  /** Scrubbed text. Meaningless when quarantined (the blob must be dropped). */
  text: string;
  rules_hit: string[];
  status: 'clean' | 'redacted' | 'quarantined';
}

export function loadRedactionRules(path?: string): RedactionRule[] {
  const file = path ?? join(configDir, 'redaction.json');
  const config = JSON.parse(readFileSync(file, 'utf8')) as { rules: RedactionRule[] };
  for (const rule of config.rules) new RegExp(rule.pattern); // fail fast on bad config
  return config.rules;
}

export function redactText(text: string, rules: RedactionRule[]): RedactionResult {
  const hit: string[] = [];
  let quarantined = false;
  let out = text;
  for (const rule of rules) {
    const re = new RegExp(rule.pattern, 'g');
    if (!re.test(out)) continue;
    hit.push(rule.name);
    if (rule.action === 'quarantine') {
      quarantined = true;
    } else {
      out = out.replace(new RegExp(rule.pattern, 'g'), `[REDACTED:${rule.name}]`);
    }
  }
  if (quarantined) return { text: '', rules_hit: hit, status: 'quarantined' };
  return { text: out, rules_hit: hit, status: hit.length > 0 ? 'redacted' : 'clean' };
}

/**
 * Binary artifacts (trace zips, screenshots) cannot be scrubbed in place:
 * any rule hit — scrub or quarantine — quarantines the blob, because we
 * cannot safely rewrite binary content (I10: when in doubt, don't store).
 */
export function scanBuffer(buf: Buffer, rules: RedactionRule[]): { rules_hit: string[]; quarantined: boolean } {
  const haystack = buf.toString('latin1');
  const hit: string[] = [];
  for (const rule of rules) {
    if (new RegExp(rule.pattern, 'g').test(haystack)) hit.push(rule.name);
  }
  return { rules_hit: hit, quarantined: hit.length > 0 };
}
