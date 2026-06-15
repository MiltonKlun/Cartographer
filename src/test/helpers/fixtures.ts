// Paths to the repo's testdata/ and examples/ fixtures, resolved once.
import { join } from 'node:path';
import { projectRoot } from '../../paths.js';

export const examplesDir = join(projectRoot, 'examples');
export const testdataDir = join(projectRoot, 'testdata');

export const fixtures = {
  playwrightReport: join(testdataDir, 'playwright-report.json'),
  junitReport: join(testdataDir, 'junit-report.xml'),
  triageReport: join(testdataDir, 'triage-report.json'),
  etSessionSheet: join(testdataDir, 'et-session-sheet.md'),
  goldenSet: join(testdataDir, 'golden-set.json'),
} as const;
