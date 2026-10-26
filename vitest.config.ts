import { defineConfig } from 'vitest/config';
import { constraintNumber } from './scripts/constraints.mjs';

// Per-file threshold: a well-covered large file must not subsidize a bare one.
const minCoverage = constraintNumber('testing', 'min_line_coverage');

export default defineConfig({
  test: {
    projects: [
      {
        // Web TSX uses the same automatic React runtime as its Vite build.
        oxc: { jsx: { runtime: 'automatic' } },
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
          // Preserve trusted owned-resource serialization; browser isolation does
          // not qualify a separate concurrency-policy change.
          fileParallelism: false,
          // Bounded build/run calls plus independent finally-cleanup need their own deadline.
          testTimeout: 900_000,
        },
      },
      {
        test: {
          name: 'model',
          include: ['platform/test/**/*.model.test.ts'],
          // Real-provider acceptance shares the trusted host; never run alongside another case.
          fileParallelism: false,
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
        'plugins/office-agents/*.js',
        'plugins/platform-nav/*.js',
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
