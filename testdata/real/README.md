# testdata/real/ — real-repo validation fixtures

These are **real, unmodified test files** vendored from a third-party OSS
project to validate Cartographer against code it did not author (SPEC §11).
They are fixtures, not dependencies — used by `bootstrap.test.ts` regressions.

- **Source:** [sindresorhus/got](https://github.com/sindresorhus/got),
  files `test/cache.ts` and `test/cookies.ts`, captured 2026-06-15.
- **License:** MIT (got is MIT-licensed; these excerpts retain that license).
- **Why these:** they exercise real-world conventions the synthetic fixtures
  missed — a `test/` directory with **un-suffixed** filenames (`cache.ts`,
  not `cache.test.ts`) and terse/parameterized titles (`"blah"`, `"[2]"`).

Captured once by hand; **no network access at test time** (the dependency
policy and the determinism rule both hold).
