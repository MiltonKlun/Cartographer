// The autonomy gateway — the ONLY path to side effects outside the ledger
// (I4). Action classes are tiered by consequence: ACT executes with a receipt
// written in the same transaction; PROPOSE returns a draft for a human;
// NEVER-tier requests have no dispatch path and always throw (I5).
// Configuration may move classes toward caution, never away from it.
import { type Clock, systemClock, isoNow } from './clock.js';
import type { Ledger } from './db.js';
import type { Receipt, ReceiptClass } from './types.js';

export type Tier = 'ACT' | 'PROPOSE' | 'NEVER';

/** Action classes that exist (SPEC §9). */
export type ActionClass =
  | 'evidence_ingest'
  | 'verdict_recompute'
  | 'export'
  | 'flake_ticket'
  | 'flake_quarantine'
  | 'selector_heal'
  | 'vault_gc'
  | 'pr_comment'
  | 'new_test_file'
  | 'behavior_statement'
  | 'link_upgrade'
  | 'assertion_change'
  | 'repro_script';

/**
 * The NEVER list (I5). These are not ActionClass members on purpose: there is
 * no handler, no tier entry, no code path. They exist here only so refusals
 * can name the invariant.
 */
export const NEVER_CLASSES = [
  'delete_test',
  'weaken_assertion',
  'change_expected_value',
  'skip_test',
  'mark_verified_without_evidence',
  'per_person_metrics',
  'merge_to_protected_branch',
  'fabricate_evidence',
] as const;
export type NeverClass = (typeof NEVER_CLASSES)[number];

interface TierEntry {
  tier: Exclude<Tier, 'NEVER'>;
  /** pr_comment may be promoted PROPOSE → ACT by explicit team opt-in (SPEC §7.2). */
  actOptIn?: boolean;
}

const DEFAULT_TIERS: Record<ActionClass, TierEntry> = {
  evidence_ingest: { tier: 'ACT' },
  verdict_recompute: { tier: 'ACT' },
  export: { tier: 'ACT' },
  flake_ticket: { tier: 'ACT' },
  flake_quarantine: { tier: 'ACT' },
  selector_heal: { tier: 'ACT' },
  vault_gc: { tier: 'ACT' },
  pr_comment: { tier: 'PROPOSE', actOptIn: true },
  new_test_file: { tier: 'PROPOSE' },
  behavior_statement: { tier: 'PROPOSE' },
  link_upgrade: { tier: 'PROPOSE' },
  assertion_change: { tier: 'PROPOSE' },
  repro_script: { tier: 'PROPOSE' },
};

export class NeverTierError extends Error {
  constructor(cls: string) {
    super(
      `"${cls}" is NEVER-tier (I5): no code path exists and none can be configured. ` +
        'This refusal cannot be overridden.',
    );
    this.name = 'NeverTierError';
  }
}

export class UnknownActionError extends Error {
  constructor(cls: string) {
    super(`unknown action class "${cls}" — the gateway only dispatches classes in the autonomy matrix (I4)`);
    this.name = 'UnknownActionError';
  }
}

export interface ActionRequest {
  class: ActionClass;
  target: string;
  summary: string;
  evidence_basis: string[];
  revert: string;
  /** The side effect itself. Only invoked for ACT-tier actions. */
  execute: () => void;
}

export type ActionResult =
  | { tier: 'ACT'; receipt: Receipt }
  | { tier: 'PROPOSE'; draft: Omit<ActionRequest, 'execute'> };

export interface AutonomyConfig {
  /** Tier overrides; only moves toward caution are accepted (ACT → PROPOSE). */
  overrides?: Partial<Record<ActionClass, 'ACT' | 'PROPOSE'>>;
  performedBy?: string;
  clock?: Clock;
}

function isNeverClass(cls: string): cls is NeverClass {
  return (NEVER_CLASSES as readonly string[]).includes(cls);
}

const RECEIPT_CLASS_OF: Partial<Record<ActionClass, ReceiptClass>> = {
  evidence_ingest: 'evidence_ingest',
  verdict_recompute: 'verdict_recompute',
  export: 'export',
  flake_ticket: 'flake_ticket',
  flake_quarantine: 'flake_quarantine',
  selector_heal: 'selector_heal',
  vault_gc: 'vault_gc',
  pr_comment: 'pr_comment',
};

export class AutonomyGateway {
  private readonly tiers: Record<ActionClass, TierEntry>;
  private readonly clock: Clock;
  private readonly performedBy: string;

  constructor(
    private readonly ledger: Ledger,
    config: AutonomyConfig = {},
  ) {
    this.clock = config.clock ?? systemClock;
    this.performedBy = config.performedBy ?? 'cartographer@0.1';
    this.tiers = structuredClone(DEFAULT_TIERS);
    for (const [cls, tier] of Object.entries(config.overrides ?? {})) {
      this.applyOverride(cls, tier as 'ACT' | 'PROPOSE');
    }
  }

  private applyOverride(cls: string, tier: 'ACT' | 'PROPOSE'): void {
    if (isNeverClass(cls)) throw new NeverTierError(cls);
    if (!(cls in this.tiers)) throw new UnknownActionError(cls);
    const actionClass = cls as ActionClass;
    const entry = this.tiers[actionClass];
    if (tier === 'PROPOSE') {
      entry.tier = 'PROPOSE'; // toward caution: always allowed
      return;
    }
    // tier === 'ACT': loosening — only the explicit opt-in class allows it.
    if (DEFAULT_TIERS[actionClass].tier === 'ACT') return; // no-op, already ACT by default
    if (DEFAULT_TIERS[actionClass].actOptIn) {
      entry.tier = 'ACT';
      return;
    }
    throw new Error(
      `cannot promote "${cls}" to ACT: tiers may only move toward caution (I4); ` +
        'only pr_comment supports ACT opt-in (SPEC §9)',
    );
  }

  tierOf(cls: string): Tier {
    if (isNeverClass(cls)) return 'NEVER';
    if (!(cls in this.tiers)) throw new UnknownActionError(cls);
    return this.tiers[cls as ActionClass].tier;
  }

  /**
   * The single dispatch point for every side effect. ACT runs the action and
   * writes its receipt in the same transaction — an ACT action without a
   * receipt did not happen (I4). PROPOSE returns the draft, untouched.
   */
  perform(request: ActionRequest): ActionResult {
    const cls: string = request.class;
    if (isNeverClass(cls)) throw new NeverTierError(cls);
    if (!(cls in this.tiers)) throw new UnknownActionError(cls);

    const tier = this.tiers[request.class].tier;
    if (tier === 'PROPOSE') {
      const { execute: _execute, ...draft } = request;
      return { tier: 'PROPOSE', draft };
    }

    const receiptClass = RECEIPT_CLASS_OF[request.class];
    if (!receiptClass) throw new UnknownActionError(request.class);
    const receipt: Receipt = {
      id: this.ledger.nextId('receipt'),
      class: receiptClass,
      target: request.target,
      summary: request.summary,
      evidence_basis: request.evidence_basis,
      revert: request.revert,
      performed_at: isoNow(this.clock),
      performed_by: this.performedBy,
    };
    this.ledger.transaction(() => {
      request.execute();
      this.ledger.insertReceipt(receipt, this.performedBy);
    });
    return { tier: 'ACT', receipt };
  }
}
