// One generic AJV validator (SPEC §2). Every record validates at the
// ingestion boundary; the ledger refuses invalid records.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';
import { schemasDir } from './paths.js';
import type { RecordType } from './types.js';

const RECORD_TYPES: RecordType[] = ['behavior', 'evidence', 'question', 'session', 'receipt'];

const ajv = new Ajv({ allErrors: true, strict: true });
const validators = new Map<RecordType, ValidateFunction>();

function validatorFor(type: RecordType): ValidateFunction {
  let v = validators.get(type);
  if (!v) {
    const schema = JSON.parse(readFileSync(join(schemasDir, `${type}.schema.json`), 'utf8'));
    v = ajv.compile(schema);
    validators.set(type, v);
  }
  return v;
}

export class SchemaError extends Error {
  constructor(
    public readonly recordType: RecordType,
    public readonly problems: string[],
  ) {
    super(`invalid ${recordType} record:\n  ${problems.join('\n  ')}`);
    this.name = 'SchemaError';
  }
}

export function isRecordType(s: string): s is RecordType {
  return (RECORD_TYPES as string[]).includes(s);
}

export function validateRecord(type: RecordType, data: unknown): string[] {
  const validate = validatorFor(type);
  if (validate(data)) return [];
  return (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`);
}

/** Throws SchemaError unless `data` is a valid record of `type`. */
export function assertValid(type: RecordType, data: unknown): void {
  const problems = validateRecord(type, data);
  if (problems.length > 0) throw new SchemaError(type, problems);
}
