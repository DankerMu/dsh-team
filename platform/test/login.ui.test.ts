import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { applyMigrations, openDatabase, type DatabaseHandle } from '../src/db/index.ts';
import { assertWebBuild } from '../src/web/index.ts';

test('built React login form is accessible, inert and entirely local', async ({
  page,
}, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-team-web-ui-'));
  let database: DatabaseHandle | undefined;
  let app: FastifyInstance | undefined;
  try {
    await assertWebBuild();
    // Reserve a unique port before capturing the public Origin; never reuse a dev listener.
    const reservation = createServer();
    let port: number;
    try {
      await new Promise<void>((resolve, reject) => {
        reservation.once('error', reject);
        reservation.listen(0, '127.0.0.1', resolve);
      });
      const address = reservation.address();
      if (address === null || typeof address === 'string')
        throw new Error('Missing UI TCP address');
      port = address.port;
    } finally {
      await new Promise<void>((resolve, reject) => {
        reservation.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    }
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    const config = loadConfig({
      PLATFORM_HOST: '127.0.0.1',
      PLATFORM_PORT: String(port),
      PLATFORM_PUBLIC_URL: baseUrl,
      PLATFORM_DATA_DIR: directory,
      PLATFORM_LOG_LEVEL: 'silent',
      PLATFORM_COOKIE_SECURE: 'false',
    });
    database = openDatabase(join(directory, 'platform.db'));
    applyMigrations(database);
    // No lifecycle service: real auth/static/gateway composition without Docker reconciliation.
    app = await buildApp(config, database);
    await app.listen({ host: '127.0.0.1', port });
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const externalRequests: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('request', (request) => {
      if (new URL(request.url()).origin !== baseUrl) externalRequests.push(request.url());
    });

    const response = await page.goto(`${baseUrl}/_platform/login`, { waitUntil: 'networkidle' });

    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: '登录 DSH 团队平台' })).toBeVisible();
    const form = page.getByRole('form', { name: '登录' });
    await expect(form).toBeVisible();
    await expect(page.getByLabel('邮箱')).toBeDisabled();
    await expect(page.getByLabel('密码')).toBeDisabled();
    const submit = page.getByRole('button', { name: '登录', exact: true });
    await expect(submit).toBeDisabled();
    await expect(submit).toHaveAttribute('type', 'button');
    await expect(form.locator('input[name]')).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await page.keyboard.press('Enter');
    expect(page.url()).toBe(`${baseUrl}/_platform/login`);
    const screenshot = testInfo.outputPath('login.png');
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach('login form', { path: screenshot, contentType: 'image/png' });
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(externalRequests).toEqual([]);
  } finally {
    // Playwright owns and closes page/context/browser, including failing test paths.
    try {
      if (app === undefined) database?.close();
      else await app.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
