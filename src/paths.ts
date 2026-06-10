import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Compiled output lives in dist/, one level under the project root.
export const projectRoot = fileURLToPath(new URL('..', import.meta.url));
export const schemasDir = join(projectRoot, 'schemas');
export const configDir = join(projectRoot, 'config');
