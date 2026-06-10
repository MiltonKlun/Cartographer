// All time logic uses an injected clock; tests never sleep (BUILD-PLAN rule 5).

export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

export function fixedClock(iso: string): Clock {
  const d = new Date(iso);
  return () => d;
}

/** ISO 8601 UTC, second precision — the ledger's timestamp format. */
export function isoNow(clock: Clock): string {
  return clock().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
