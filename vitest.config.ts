import { defineConfig } from 'vitest/config';
import { constraintNumber } from './scripts/constraints.mjs';

// Per-file threshold: a well-covered large file must not subsidize a bare one.
const minCoverage = constraintNumber('testing', 'min_line_coverage');

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            'platform/src/**/*.test.ts',
            'platform/web/src/**/*.test.{ts,tsx}',
            'plugins/**/*.test.js',
          ],
        },
      },
      { test: { name: 'integration', include: ['platform/test/**/*.integration.test.ts'] } },
      {
        test: {
          name: 'docker',
          include: ['platform/test/**/*.docker.test.ts'],
          // Docker topology plus Chrome fresh connections: overlapping files
          // share host/CDP and produce ERR_NETWORK_CHANGED.
          fileParallelism: false,
          // Bounded build/run calls plus independent finally-cleanup need their own deadline.
          testTimeout: 900_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: [
        'platform/src/**/*.ts',
        'platform/web/src/**/*.{ts,tsx}',
        'plugins/permission-tiers/*.js',
      ],
      // Exact process/browser bootstrap exemptions are registered in constraints.yaml.
      exclude: [
        'platform/src/**/*.test.ts',
        'platform/src/main.ts',
        'platform/web/src/**/*.test.{ts,tsx}',
        'platform/web/src/main.tsx',
        'plugins/**/*.test.js',
      ],
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
