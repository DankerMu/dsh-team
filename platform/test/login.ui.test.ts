import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Response } from '@playwright/test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { applyMigrations, openDatabase, type DatabaseHandle } from '../src/db/index.ts';
import { assertWebBuild } from '../src/web/index.ts';
import { readPublicIdentity } from './auth-fixture.ts';
import { withUpstream } from './gateway-http-fixture.ts';

test('built React login submits real credentials, recovers from rejections and stays entirely local', async ({
  page,
  playwright,
}, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-team-web-ui-'));
  const release = Promise.withResolvers<undefined>();
  let database: DatabaseHandle | undefined;
  let app: FastifyInstance | undefined;
  let seed: APIRequestContext | undefined;
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
    const loginUrl = `${baseUrl}/_platform/api/login`;
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
    const upstreamRequests: { path: string; cookie: string | undefined }[] = [];
    const admittedUsers: string[] = [];
    // This owned plain-text destination observes gateway admission; it is NOT DSH evidence.
    await withUpstream(
      (request, response) => {
        upstreamRequests.push({ path: request.url ?? '', cookie: request.headers.cookie });
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('本地已认证入口（非 DSH）');
      },
      async (target) => {
        // No lifecycle service, fake page or intercepted assets: real auth/static/gateway composition.
        if (database === undefined) throw new Error('Missing UI database');
        app = await buildApp(config, database, undefined, (userId) => {
          admittedUsers.push(userId);
          return target;
        });
        await app.listen({ host: '127.0.0.1', port });
        // Separate API cookie jar: registration never gives the browser a preauthenticated cookie.
        seed = await playwright.request.newContext({
          baseURL: baseUrl,
          extraHTTPHeaders: { Origin: baseUrl },
        });
        const password = 'browser-owned-password';
        const identities = new Map<string, string>();
        for (const email of ['active@example.com', 'disabled@example.com', 'limited@example.com']) {
          const registered = await seed.post('/_platform/api/register', {
            data: { email, password },
          });
          expect(registered.status()).toBe(201);
          identities.set(email, readPublicIdentity(await registered.json()).id);
        }
        database
          .prepare("UPDATE users SET status = 'disabled' WHERE email = ?")
          .run('disabled@example.com');
        for (let attempt = 0; attempt < 10; attempt++) {
          const failed = await seed.post('/_platform/api/login', {
            data: { email: 'limited@example.com', password: 'wrong-password' },
          });
          expect(failed.status()).toBe(401);
        }
        expect(await page.context().cookies()).toEqual([]);
        const consoleErrors: { text: string; url: string }[] = [];
        const pageErrors: string[] = [];
        const externalRequests: string[] = [];
        const failedRequests: string[] = [];
        const loginRequests: string[] = [];
        const loginStatuses: number[] = [];
        const assets: Response[] = [];
        page.on('console', (message) => {
          if (message.type() === 'error')
            consoleErrors.push({ text: message.text(), url: message.location().url });
        });
        page.on('pageerror', (error) => pageErrors.push(error.message));
        page.on('requestfailed', (request) => failedRequests.push(request.url()));
        page.on('request', (request) => {
          if (new URL(request.url()).origin !== baseUrl) externalRequests.push(request.url());
          if (request.url() === loginUrl) loginRequests.push(request.method());
        });
        page.on('response', (response) => {
          if (response.url() === loginUrl) loginStatuses.push(response.status());
          if (new URL(response.url()).pathname.startsWith('/_platform/assets/'))
            assets.push(response);
        });
        async function screenshot(name: string) {
          const path = testInfo.outputPath(`${name}.png`);
          await page.screenshot({ path, fullPage: true });
          await testInfo.attach(name, { path, contentType: 'image/png' });
        }
        async function rejectLogin(email: string, status: number, message: string, name: string) {
          await page.getByLabel('邮箱').fill(email);
          await page
            .getByLabel('密码')
            .fill(email === 'active@example.com' ? 'wrong-password' : password);
          const [response] = await Promise.all([
            page.waitForResponse((response) => response.url() === loginUrl),
            page.getByRole('button', { name: '登录', exact: true }).click(),
          ]);
          expect(response.status()).toBe(status);
          await expect(page.getByRole('alert')).toHaveText(message);
          await expect(page.getByLabel('邮箱')).toBeEnabled();
          await expect(page.getByLabel('密码')).toBeEnabled();
          await expect(page.getByRole('button', { name: '登录', exact: true })).toBeEnabled();
          await expect(page).toHaveURL(`${baseUrl}/_platform/login`);
          expect(await page.context().cookies()).toEqual([]);
          await screenshot(name);
        }

        const response = await page.goto(`${baseUrl}/_platform/login`, {
          waitUntil: 'networkidle',
        });

        expect(response?.status()).toBe(200);
        await expect(page.getByRole('heading', { name: '登录 DSH 团队平台' })).toBeVisible();
        const form = page.getByRole('form', { name: '登录' });
        await expect(form).toBeVisible();
        await expect(page.getByLabel('邮箱')).toBeEnabled();
        await expect(page.getByLabel('密码')).toBeEnabled();
        const submit = page.getByRole('button', { name: '登录', exact: true });
        await expect(submit).toBeEnabled();
        await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
        await screenshot('login');
        await page.getByLabel('邮箱').fill('missing@example.com');
        await page.getByLabel('密码').fill(password);
        const paused = Promise.withResolvers<undefined>();
        await page.route(
          loginUrl,
          async (route) => {
            paused.resolve(undefined);
            await release.promise;
            await route.continue();
          },
          { times: 1 },
        );

        await submit.click();
        await paused.promise;

        await expect(page.getByRole('status')).toHaveText('正在登录…');
        await expect(page.getByLabel('邮箱')).toBeDisabled();
        await expect(page.getByLabel('密码')).toBeDisabled();
        await expect(page.getByRole('button', { name: '正在登录…' })).toBeDisabled();
        await form.evaluate((element: unknown) => {
          // This callback runs in Chromium; the root Node config intentionally has no DOM lib.
          const browser = globalThis as typeof globalThis & {
            HTMLFormElement: new () => { requestSubmit(): void };
          };
          if (!(element instanceof browser.HTMLFormElement)) throw new Error('Missing login form');
          element.requestSubmit();
          element.requestSubmit();
        });
        expect(loginRequests).toEqual(['POST']);
        await screenshot('login-pending');
        release.resolve(undefined);
        await expect(page.getByRole('alert')).toHaveText('邮箱或密码错误。');
        await expect(page).toHaveURL(`${baseUrl}/_platform/login`);
        expect(await page.context().cookies()).toEqual([]);
        await screenshot('login-unknown-account');
        await rejectLogin('active@example.com', 401, '邮箱或密码错误。', 'login-wrong-password');
        await rejectLogin(
          'disabled@example.com',
          403,
          '账号已被禁用，请联系管理员。',
          'login-disabled',
        );
        await rejectLogin(
          'limited@example.com',
          429,
          '登录尝试过于频繁，请稍后再试。',
          'login-limited',
        );
        expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([
          0, 0,
        ]);
        expect(upstreamRequests).toEqual([]);
        expect(admittedUsers).toEqual([]);
        await page.getByLabel('邮箱').fill('active@example.com');
        await page.getByLabel('密码').fill(password);

        const [success] = await Promise.all([
          page.waitForResponse((response) => response.url() === loginUrl),
          page.getByRole('button', { name: '登录', exact: true }).click(),
        ]);

        expect(success.status()).toBe(200);
        await expect(page).toHaveURL(`${baseUrl}/`);
        await expect(page.locator('body')).toContainText('本地已认证入口（非 DSH）');
        expect(admittedUsers).toContain(identities.get('active@example.com'));
        expect(upstreamRequests).toContainEqual({ path: '/', cookie: target.cookie });
        const cookies = await page.context().cookies();
        expect(cookies.find((cookie) => cookie.name === 'platform_session')).toMatchObject({
          httpOnly: true,
        });
        expect(
          await page.evaluate(() => {
            // Chromium supplies document; keep its cookie contract local to this callback.
            const browser = globalThis as typeof globalThis & {
              document: { cookie: string };
            };
            return browser.document.cookie;
          }),
        ).toBe('');
        await screenshot('login-authenticated-local-destination');
        expect(loginRequests).toEqual(['POST', 'POST', 'POST', 'POST', 'POST']);
        expect(loginStatuses).toEqual([401, 401, 403, 429, 200]);
        for (const asset of assets) expect(asset.status()).toBe(200);
        // Only exact browser network diagnostics for observed login rejections are expected.
        // Each consumes one request/status allowance; unrelated console errors always fail.
        const allowances = [401, 401, 403, 429];
        for (const error of consoleErrors) {
          expect(error.url).toBe(loginUrl);
          const match =
            /^Failed to load resource: the server responded with a status of (401|403|429) \([^\n]+\)$/.exec(
              error.text,
            );
          expect(match).not.toBeNull();
          const index = allowances.indexOf(Number(match?.[1]));
          expect(index).toBeGreaterThanOrEqual(0);
          allowances.splice(index, 1);
        }
        expect(pageErrors).toEqual([]);
        expect(failedRequests).toEqual([]);
        expect(externalRequests).toEqual([]);
      },
    );
  } finally {
    // Always release a paused real request before closing its owned listener.
    release.resolve(undefined);
    try {
      await seed?.dispose();
    } finally {
      try {
        // Playwright owns page/context/browser; app owns DB after successful buildApp.
        if (app === undefined) database?.close();
        else await app.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
});
