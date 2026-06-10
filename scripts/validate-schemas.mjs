// Validates that every schema in schemas/ compiles (draft-07) and that every
// fixture in examples/ validates against its schema. DoD gate: npm run validate:schemas.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, basename } from 'node:path';
import Ajv from 'ajv';

const root = fileURLToPath(new URL('..', import.meta.url));
const schemasDir = join(root, 'schemas');
const examplesDir = join(root, 'examples');

const ajv = new Ajv({ allErrors: true, strict: true });
let failures = 0;

const validators = new Map();
for (const file of readdirSync(schemasDir).filter((f) => f.endsWith('.schema.json'))) {
  const schema = JSON.parse(readFileSync(join(schemasDir, file), 'utf8'));
  try {
    const validate = ajv.compile(schema);
    validators.set(file.replace('.schema.json', ''), validate);
    console.log(`schema OK: ${file}`);
  } catch (err) {
    console.error(`schema FAILED to compile: ${file}: ${err.message}`);
    failures++;
  }
}

for (const file of readdirSync(examplesDir).filter((f) => f.endsWith('.json'))) {
  // examples are named <type>[.<variant>].json, e.g. behavior.json, evidence.quarantined.json
  const type = basename(file, '.json').split('.')[0];
  const validate = validators.get(type);
  if (!validate) {
    console.error(`example ${file}: no schema named ${type}.schema.json`);
    failures++;
    continue;
  }
  const data = JSON.parse(readFileSync(join(examplesDir, file), 'utf8'));
  if (validate(data)) {
    console.log(`example OK: ${file}`);
  } else {
    console.error(`example INVALID: ${file}`);
    for (const e of validate.errors ?? []) console.error(`  ${e.instancePath || '/'} ${e.message}`);
    failures++;
  }
}

if (failures > 0) {
  console.error(`validate:schemas: ${failures} failure(s)`);
  process.exit(1);
}
console.log('validate:schemas: all green');
