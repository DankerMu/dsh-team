import { expect, test } from '@playwright/test';
import { readPublicIdentity } from './auth-fixture.ts';
import {
  expectNoBrowserStorage,
  expectNoScriptVisibleCookie,
  expectViewportLayout,
  observeAccountUi,
  withAccountUi,
  withAccountUiRouteCleanup,
} from './account-ui-fixture.ts';

test('built waiting page serially observes startup and offers only explicit terminal retries', async ({
  page,
  playwright,
}, testInfo) => {
  await withAccountUi(
    playwright,
    async ({ baseUrl, seed, target, upstreamRequests, admittedUsers }) => {
      await withAccountUiRouteCleanup(page, async (release) => {
        const loginUrl = `${baseUrl}/_platform/api/login`;
        const startUrl = `${baseUrl}/_platform/api/instance/start`;
        const statusUrl = `${baseUrl}/_platform/api/instance`;
        const sessionUrl = `${baseUrl}/_platform/api/session`;
        const password = 'wait-browser-owned-password';
        const registered = await seed.post('/_platform/api/register', {
          data: { email: 'wait@example.com', password },
        });
        expect(registered.status()).toBe(201);
        const identity = readPublicIdentity(await registered.json());
        expect(await page.context().cookies()).toEqual([]);
        // The observer tracks both methods explicitly; GET is not an auth mutation allowance.
        const { actionRequests, actionResponses, otherMutations, screenshot, expectHealthy } =
          observeAccountUi(page, testInfo, baseUrl, [loginUrl, startUrl, statusUrl, sessionUrl]);
        const assets: { path: string; status: number }[] = [];
        page.on('response', (response) => {
          const path = new URL(response.url()).pathname;
          if (path.startsWith('/_platform/assets/'))
            assets.push({ path, status: response.status() });
        });
        const login = await page.goto(`${baseUrl}/_platform/login`);
        expect(login?.status()).toBe(200);
        await page.getByLabel('邮箱').fill('wait@example.com');
        await page.getByLabel('密码').fill(password);
        const [authenticated] = await Promise.all([
          page.waitForResponse(loginUrl),
          page.getByRole('button', { name: '登录', exact: true }).click(),
        ]);
        expect(authenticated.status()).toBe(200);
        await expect(page).toHaveURL(`${baseUrl}/`);
        await expect(page.locator('body')).toContainText('本地已认证入口（非 DSH）');
        expect(
          (await page.context().cookies()).find((cookie) => cookie.name === 'platform_session'),
        ).toMatchObject({ httpOnly: true });
        await expectNoScriptVisibleCookie(page);

        const startStates = ['starting', 'full', 'unconfigured', 'error', 'error', 'running'];
        const calls: { path: string; method: string; body: string | null; at: number }[] = [];
        const statusPending = Promise.withResolvers<undefined>();
        let starts = 0;
        let observations = 0;
        let active = 0;
        let maxActive = 0;
        let statusSettledAt = 0;
        await page.route(startUrl, async (route) => {
          const request = route.request();
          calls.push({
            path: '/_platform/api/instance/start',
            method: request.method(),
            body: request.postData(),
            at: Date.now(),
          });
          expect(request.method()).toBe('POST');
          expect(request.postData()).toBe('{}');
          expect(request.headers()['content-type']).toBe('application/json');
          const status = startStates[starts++];
          expect(status).toBeDefined();
          active++;
          maxActive = Math.max(maxActive, active);
          await route.fulfill({
            status: 200,
            json: { status, reason: status === 'running' ? null : status },
          });
          active--;
        });
        await page.route(statusUrl, async (route) => {
          const request = route.request();
          calls.push({
            path: '/_platform/api/instance',
            method: request.method(),
            body: request.postData(),
            at: Date.now(),
          });
          expect(request.method()).toBe('GET');
          expect(request.postData()).toBeNull();
          const number = ++observations;
          active++;
          maxActive = Math.max(maxActive, active);
          if (number === 1) {
            statusPending.resolve(undefined);
            await release.promise;
            statusSettledAt = Date.now();
          }
          const status = number === 1 ? 'starting' : 'running';
          await route.fulfill({
            status: 200,
            json: { status, reason: status === 'running' ? null : status },
          });
          active--;
        });

        const waiting = await page.goto(`${baseUrl}/_platform/wait`);
        expect(waiting?.status()).toBe(200);
        await expect(page.getByRole('heading', { name: '等待工作台' })).toBeVisible();
        await expect(page.getByRole('status')).toHaveText('启动中');
        await expect(page.getByRole('button', { name: '重试' })).toBeDisabled();
        await screenshot('wait-starting');
        await statusPending.promise;
        await expectViewportLayout(page, screenshot, 'glass-wait', async () => {
          await expect(page.getByRole('status')).toHaveText('启动中');
        });
        // Keep an observation pending for longer than two poll periods: no overlap or restart.
        await page.waitForTimeout(2200);
        expect(calls.map(({ method }) => method)).toEqual(['POST', 'GET']);
        expect(starts).toBe(1);
        expect(observations).toBe(1);
        await expect(page).toHaveURL(`${baseUrl}/_platform/wait`);
        release.resolve(undefined);
        await expect(page).toHaveURL(`${baseUrl}/`);
        expect(calls[2]?.at).toBeGreaterThanOrEqual(statusSettledAt + 1000);
        await expect(page.locator('body')).toContainText('本地已认证入口（非 DSH）');
        await screenshot('wait-ready-local-destination');

        for (const [message, name] of [
          ['当前使用人数已满，请稍后再试', 'wait-full'],
          ['管理员尚未完成模型配置', 'wait-unconfigured'],
          ['启动失败，请重试。', 'wait-error'],
        ] as const) {
          const entry = await page.goto(`${baseUrl}/_platform/wait`);
          expect(entry?.status()).toBe(200);
          await expect(page.getByRole('alert')).toHaveText(message);
          await expect(page.getByRole('button', { name: '重试' })).toBeEnabled();
          await screenshot(name);
          // The real identity read answers employee: the administrator link never appears.
          await expect(page.getByRole('link', { name: '去配置模型' })).toHaveCount(0);
          const count = calls.length;
          await page.waitForTimeout(1200);
          expect(calls).toHaveLength(count);
        }
        await expect(page.getByText('仍失败时请联系管理员', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: '重试' }).click();
        await expect.poll(() => starts).toBe(5);
        await expect(page.getByRole('alert')).toHaveText('启动失败，请重试。');
        await expect(page.getByText('仍失败时请联系管理员', { exact: true })).toBeVisible();
        await screenshot('wait-retry-error-admin-guidance');
        await page.waitForTimeout(1200);
        expect(starts).toBe(5);
        expect(observations).toBe(2);
        await page.getByRole('button', { name: '重试' }).click();
        await expect(page).toHaveURL(`${baseUrl}/`);
        await expect(page.locator('body')).toContainText('本地已认证入口（非 DSH）');
        await screenshot('wait-retry-ready-local-destination');
        await page.waitForTimeout(1200);

        expect(calls.map(({ path, method, body }) => ({ path, method, body }))).toEqual([
          { path: '/_platform/api/instance/start', method: 'POST', body: '{}' },
          { path: '/_platform/api/instance', method: 'GET', body: null },
          { path: '/_platform/api/instance', method: 'GET', body: null },
          { path: '/_platform/api/instance/start', method: 'POST', body: '{}' },
          { path: '/_platform/api/instance/start', method: 'POST', body: '{}' },
          { path: '/_platform/api/instance/start', method: 'POST', body: '{}' },
          { path: '/_platform/api/instance/start', method: 'POST', body: '{}' },
          { path: '/_platform/api/instance/start', method: 'POST', body: '{}' },
        ]);
        expect(maxActive).toBe(1);
        expect(active).toBe(0);
        expect(actionRequests).toEqual([
          { url: loginUrl, method: 'POST' },
          { url: startUrl, method: 'POST' },
          { url: statusUrl, method: 'GET' },
          { url: statusUrl, method: 'GET' },
          { url: startUrl, method: 'POST' },
          { url: startUrl, method: 'POST' },
          { url: sessionUrl, method: 'GET' },
          { url: startUrl, method: 'POST' },
          { url: startUrl, method: 'POST' },
          { url: startUrl, method: 'POST' },
        ]);
        expect(actionResponses.map(({ status }) => status)).toEqual([
          200, 200, 200, 200, 200, 200, 200, 200, 200, 200,
        ]);
        expect(otherMutations).toEqual([]);
        expect(assets.some(({ path, status }) => path.endsWith('.js') && status === 200)).toBe(
          true,
        );
        expect(assets.some(({ path, status }) => path.endsWith('.css') && status === 200)).toBe(
          true,
        );
        expect(admittedUsers).toEqual([identity.id, identity.id, identity.id]);
        expect(upstreamRequests.filter(({ path }) => path === '/')).toEqual([
          { path: '/', cookie: target.cookie },
          { path: '/', cookie: target.cookie },
          { path: '/', cookie: target.cookie },
        ]);
        await expectNoBrowserStorage(page);
        await expectNoScriptVisibleCookie(page);
        expectHealthy([]);
      });
    },
  );
});

test('built waiting page offers an administrator the model configuration link only while unconfigured', async ({
  page,
  playwright,
}, testInfo) => {
  await withAccountUi(playwright, async ({ baseUrl, database, seed, admittedUsers }) => {
    const loginUrl = `${baseUrl}/_platform/api/login`;
    const startUrl = `${baseUrl}/_platform/api/instance/start`;
    const sessionUrl = `${baseUrl}/_platform/api/session`;
    const usersUrl = `${baseUrl}/_platform/api/admin/users?page=1&pageSize=20`;
    const configUrl = `${baseUrl}/_platform/api/admin/model-config`;
    const email = 'wait-admin@example.com';
    const password = 'wait-admin-browser-password';
    const registered = await seed.post('/_platform/api/register', { data: { email, password } });
    expect(registered.status()).toBe(201);
    database.prepare("UPDATE users SET role = 'admin' WHERE email = ?").run(email);
    const observed = observeAccountUi(page, testInfo, baseUrl, [
      loginUrl,
      startUrl,
      sessionUrl,
      usersUrl,
      configUrl,
    ]);
    const states = ['unconfigured', 'full'];
    // Only the start API is substituted; the identity read is the real platform route.
    await page.route(startUrl, async (route) => {
      const status = states.shift() ?? 'unconfigured';
      await route.fulfill({ status: 200, json: { status, reason: status } });
    });
    const login = await page.goto(`${baseUrl}/_platform/login`);
    expect(login?.status()).toBe(200);
    await page.getByLabel('邮箱').fill(email);
    await page.getByLabel('密码').fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(`${baseUrl}/`);

    const waiting = await page.goto(`${baseUrl}/_platform/wait`);
    expect(waiting?.status()).toBe(200);
    await expect(page.getByRole('alert')).toHaveText('管理员尚未完成模型配置');
    const link = page.getByRole('link', { name: '去配置模型' });
    await expect(link).toHaveAttribute('href', '/_platform/admin/models');
    await expect(page.getByRole('link', { name: '账号设置' })).toBeVisible();
    await expectViewportLayout(page, observed.screenshot, 'wait-admin-unconfigured', async () => {
      await expect(link).toBeVisible();
    });
    await page.getByRole('button', { name: '重试' }).click();
    await expect(page.getByRole('alert')).toHaveText('当前使用人数已满，请稍后再试');
    await expect(link).toHaveCount(0);
    await page.getByRole('button', { name: '重试' }).click();
    await expect(link).toBeVisible();

    await link.click();

    await expect(page).toHaveURL(`${baseUrl}/_platform/admin/models`);
    await expect(page.getByRole('heading', { name: '模型配置', exact: true })).toBeVisible();
    await observed.screenshot('wait-admin-configure-models');
    expect(
      observed.actionRequests.filter(({ url }) => url === sessionUrl).map(({ method }) => method),
    ).toEqual(['GET']);
    expect(
      observed.actionResponses.filter(({ url }) => url === sessionUrl).map(({ status }) => status),
    ).toEqual([200]);
    expect(admittedUsers).toHaveLength(1);
    await expectNoBrowserStorage(page);
    observed.expectHealthy([]);
  });
});
