#!/usr/bin/env node
import { main } from '../dist/cli.js';
main(process.argv.slice(2)).catch((err) => {
  console.error(`cart: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
