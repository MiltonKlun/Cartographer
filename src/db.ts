// The ledger: node:sqlite single file, WAL mode, one writer (SPEC §5).
// Every mutation lands in the append-only `mutations` table (I11); evidence
// and receipts are immutable at the SQL level via triggers.
import { DatabaseSync } from 'node:sqlite';
import { type Clock, systemClock, isoNow } from './clock.js';
import { assertValid } from './validate.js';
import type { Behavior, Evidence, Question, Receipt, RecordType, Session } from './types.js';

export type TableName = 'behaviors' | 'evidence' | 'questions' | 'sessions' | 'receipts';

const TABLE_OF: Record<RecordType, TableName> = {
  behavior: 'behaviors',
  evidence: 'evidence',
  question: 'questions',
  session: 'sessions',
  receipt: 'receipts',
};

const ID_PREFIX: Record<RecordType, string> = {
  behavior: 'BHV',
  evidence: 'EV',
  question: 'Q',
  session: 'SES',
  receipt: 'ACT',
};

interface Migration {
  version: number;
  name: string;
  sql: string;
}

// Migrations are append-only: never edit a shipped entry, add a new one.
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-tables',
    sql: `
      CREATE TABLE behaviors (id TEXT PRIMARY KEY, area TEXT NOT NULL, criticality TEXT NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE evidence  (id TEXT PRIMARY KEY, observed_at TEXT NOT NULL, outcome TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE questions (id TEXT PRIMARY KEY, status TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE sessions  (id TEXT PRIMARY KEY, status TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE receipts  (id TEXT PRIMARY KEY, class TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE mutations (
        seq       INTEGER PRIMARY KEY AUTOINCREMENT,
        actor     TEXT NOT NULL,
        at        TEXT NOT NULL,
        tbl       TEXT NOT NULL,
        record_id TEXT NOT NULL,
        diff      TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'immutability-triggers',
    sql: `
      CREATE TRIGGER mutations_no_update BEFORE UPDATE ON mutations
        BEGIN SELECT RAISE(ABORT, 'mutations log is append-only (I11)'); END;
      CREATE TRIGGER mutations_no_delete BEFORE DELETE ON mutations
        BEGIN SELECT RAISE(ABORT, 'mutations log is append-only (I11)'); END;
      CREATE TRIGGER evidence_no_update BEFORE UPDATE ON evidence
        BEGIN SELECT RAISE(ABORT, 'evidence is immutable; supersede with a new record (SPEC §3.2)'); END;
      CREATE TRIGGER evidence_no_delete BEFORE DELETE ON evidence
        BEGIN SELECT RAISE(ABORT, 'evidence is immutable; supersede with a new record (SPEC §3.2)'); END;
      CREATE TRIGGER receipts_no_update BEFORE UPDATE ON receipts
        BEGIN SELECT RAISE(ABORT, 'receipts are immutable (I4/I11)'); END;
      CREATE TRIGGER receipts_no_delete BEFORE DELETE ON receipts
        BEGIN SELECT RAISE(ABORT, 'receipts are immutable (I4/I11)'); END;
      CREATE TRIGGER behaviors_no_delete BEFORE DELETE ON behaviors
        BEGIN SELECT RAISE(ABORT, 'behaviors are never deleted; retire instead (I11)'); END;
    `,
  },
  {
    version: 3,
    name: 'evidence-dedupe-key',
    // internal idempotence column (SPEC §6: dedupe key = source ref + artifact
    // hash); not part of the evidence record schema
    sql: `
      ALTER TABLE evidence ADD COLUMN dedupe_key TEXT;
      CREATE UNIQUE INDEX evidence_dedupe ON evidence(dedupe_key) WHERE dedupe_key IS NOT NULL;
    `,
  },
];

export interface MutationRow {
  seq: number;
  actor: string;
  at: string;
  tbl: string;
  record_id: string;
  diff: string;
}

export class Ledger {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;

  constructor(path: string, opts: { clock?: Clock } = {}) {
    this.clock = opts.clock ?? systemClock;
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);',
    );
    const appliedRows = this.db.prepare('SELECT version FROM schema_migrations').all() as {
      version: number;
    }[];
    const applied = new Set(appliedRows.map((r) => r.version));
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      this.db.exec('BEGIN');
      try {
        this.db.exec(m.sql);
        this.db
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(m.version, m.name, isoNow(this.clock));
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
  }

  private transactionDepth = 0;

  /** Runs `fn` inside a transaction; nested calls join the outer one. */
  transaction<T>(fn: () => T): T {
    if (this.transactionDepth > 0) return fn();
    this.db.exec('BEGIN');
    this.transactionDepth++;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.transactionDepth--;
    }
  }

  nextId(type: RecordType): string {
    const table = TABLE_OF[type];
    const row = this.db
      .prepare(`SELECT MAX(CAST(substr(id, instr(id, '-') + 1) AS INTEGER)) AS n FROM ${table}`)
      .get() as { n: number | null };
    const next = (row.n ?? 0) + 1;
    return `${ID_PREFIX[type]}-${String(next).padStart(4, '0')}`;
  }

  private logMutation(actor: string, tbl: string, recordId: string, diff: unknown): void {
    this.db
      .prepare('INSERT INTO mutations (actor, at, tbl, record_id, diff) VALUES (?, ?, ?, ?, ?)')
      .run(actor, isoNow(this.clock), tbl, recordId, JSON.stringify(diff));
  }

  // -- inserts (validate at the boundary, log the mutation in-transaction) --

  insertBehavior(b: Behavior, actor: string): void {
    assertValid('behavior', b);
    this.transaction(() => {
      this.db
        .prepare('INSERT INTO behaviors (id, area, criticality, status, json) VALUES (?, ?, ?, ?, ?)')
        .run(b.id, b.area, b.criticality, b.status, JSON.stringify(b));
      this.logMutation(actor, 'behaviors', b.id, { new: b });
    });
  }

  insertEvidence(e: Evidence, actor: string, dedupeKey?: string): void {
    assertValid('evidence', e);
    this.transaction(() => {
      this.db
        .prepare('INSERT INTO evidence (id, observed_at, outcome, json, dedupe_key) VALUES (?, ?, ?, ?, ?)')
        .run(e.id, e.observed_at, e.outcome, JSON.stringify(e), dedupeKey ?? null);
      this.logMutation(actor, 'evidence', e.id, { new: e });
    });
  }

  /** Idempotence check for ingestors (SPEC §6). */
  findEvidenceIdByDedupeKey(key: string): string | undefined {
    const row = this.db.prepare('SELECT id FROM evidence WHERE dedupe_key = ?').get(key) as
      | { id: string }
      | undefined;
    return row?.id;
  }

  insertQuestion(q: Question, actor: string): void {
    assertValid('question', q);
    this.transaction(() => {
      this.db
        .prepare('INSERT INTO questions (id, status, json) VALUES (?, ?, ?)')
        .run(q.id, q.status, JSON.stringify(q));
      this.logMutation(actor, 'questions', q.id, { new: q });
    });
  }

  insertSession(s: Session, actor: string): void {
    assertValid('session', s);
    this.transaction(() => {
      this.db
        .prepare('INSERT INTO sessions (id, status, json) VALUES (?, ?, ?)')
        .run(s.id, s.status, JSON.stringify(s));
      this.logMutation(actor, 'sessions', s.id, { new: s });
    });
  }

  /** Receipts are written by the autonomy gateway, inside the action's transaction (I4). */
  insertReceipt(r: Receipt, actor: string): void {
    assertValid('receipt', r);
    this.db
      .prepare('INSERT INTO receipts (id, class, json) VALUES (?, ?, ?)')
      .run(r.id, r.class, JSON.stringify(r));
    this.logMutation(actor, 'receipts', r.id, { new: r });
  }

  // -- updates (behaviors/questions/sessions only; evidence and receipts are immutable) --

  updateBehavior(id: string, change: (old: Behavior) => Behavior, actor: string): Behavior {
    const old = this.getBehavior(id);
    if (!old) throw new Error(`no such behavior: ${id}`);
    const next = change(structuredClone(old));
    if (next.id !== id) throw new Error('behavior id is immutable');
    assertValid('behavior', next);
    this.transaction(() => {
      this.db
        .prepare('UPDATE behaviors SET area = ?, criticality = ?, status = ?, json = ? WHERE id = ?')
        .run(next.area, next.criticality, next.status, JSON.stringify(next), id);
      this.logMutation(actor, 'behaviors', id, { old, new: next });
    });
    return next;
  }

  // -- reads --

  getBehavior(id: string): Behavior | undefined {
    const row = this.db.prepare('SELECT json FROM behaviors WHERE id = ?').get(id) as
      | { json: string }
      | undefined;
    return row ? (JSON.parse(row.json) as Behavior) : undefined;
  }

  allRecords(table: TableName): unknown[] {
    const rows = this.db.prepare(`SELECT json FROM ${table} ORDER BY id`).all() as {
      json: string;
    }[];
    return rows.map((r) => JSON.parse(r.json));
  }

  allMutations(): MutationRow[] {
    return this.db
      .prepare('SELECT seq, actor, at, tbl, record_id, diff FROM mutations ORDER BY seq')
      .all() as unknown as MutationRow[];
  }

  /** Escape hatch for tests proving the SQL-level immutability triggers. */
  rawExec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}
