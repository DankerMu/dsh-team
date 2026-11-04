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
            'images/dsh-user/*.test.mjs',
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
      {
        test: {
          name: 'stack',
          include: ['platform/test/**/*.stack.test.ts'],
          fileParallelism: false,
          // Two cold image builds (600s each, 1200s) leave 1200s for compose, health, the
          // conversation, 13 in-instance proxy calls (30s each at most), drainage and the RAGFlow
          // restore, which is bounded at 300s from before `docker start` (its 60s CLI bound lies
          // inside). That remainder is a margin, not the sum of every per-step bound: a vitest
          // timeout skips the restore `finally` and leaves ragflow-cpu stopped (LOCAL_STACK.md §5).
          testTimeout: 2_400_000,
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
        'images/dsh-user/*.mjs',
      ],
      // Exact process/browser bootstrap exemptions are registered in constraints.yaml.
      exclude: [
        'platform/src/**/*.test.ts',
        'platform/src/main.ts',
        'platform/web/src/**/*.test.{ts,tsx}',
        'platform/web/src/main.tsx',
        'plugins/**/*.test.js',
        'images/dsh-user/*.test.mjs',
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
