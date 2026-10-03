import { defineConfig } from 'vitest/config';
import { constraintNumber } from './scripts/constraints.mjs';

// Per-file threshold: a well-covered large file must not subsidize a bare one.
const minCoverage = constraintNumber('testing', 'min_line_coverage');

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['platform/src/**/*.test.ts'] } },
      { test: { name: 'integration', include: ['platform/test/**/*.integration.test.ts'] } },
    ],
    coverage: {
      provider: 'v8',
      include: ['platform/src/**/*.ts'],
      // main.ts is the process entry point; registered in constraints.yaml `exemptions`.
      exclude: ['platform/src/**/*.test.ts', 'platform/src/main.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        perFile: true,
        lines: minCoverage,
        branches: minCoverage,
        functions: minCoverage,
        statements: minCoverage,
      },
    },
  },
});
