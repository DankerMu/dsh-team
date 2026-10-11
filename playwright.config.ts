import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './platform/test',
  testMatch: '**/*.ui.test.ts',
  // Owned app/database fixtures never overlap; retries would hide a baseline failure.
  workers: 1,
  retries: 0,
  timeout: 30_000,
  outputDir: 'reports/platform-ui',
  use: { browserName: 'chromium', viewport: { width: 1280, height: 800 } },
});
