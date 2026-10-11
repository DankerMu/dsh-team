import { expect, test } from '@playwright/test';
import { readPublicIdentity } from './auth-fixture.ts';
import {
  expectNoBrowserStorage,
  expectNoScriptVisibleCookie,
  observeAccountUi,
  submitPendingAccountForm,
  withAccountUi,
  withAccountUiRouteCleanup,
} from './account-ui-fixture.ts';

test('built React login submits real credentials, recovers from rejections and stays entirely local', async ({
  page,
  playwright,
}, testInfo) => {
  await withAccountUi(
    playwright,
    async ({ baseUrl, database, seed, target, upstreamRequests, admittedUsers }) => {
      const loginUrl = `${baseUrl}/_platform/api/login`;
      await withAccountUiRouteCleanup(page, async (release) => {
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
        const {
          requests: loginRequests,
          statuses: loginStatuses,
          screenshot,
          expectHealthy,
        } = observeAccountUi(page, testInfo, baseUrl, loginUrl);
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

        const registrationPage = await page.goto(`${baseUrl}/_platform/register`, {
          waitUntil: 'networkidle',
        });

        expect(registrationPage?.status()).toBe(200);
        await expect(page.getByRole('heading', { name: /注册/ })).toBeVisible();
        await expect(page.getByRole('link', { name: '已有账号？登录' })).toHaveAttribute(
          'href',
          '/_platform/login',
        );

        const response = await page.goto(`${baseUrl}/_platform/login`, {
          waitUntil: 'networkidle',
        });

        expect(response?.status()).toBe(200);
        await expect(page.getByRole('heading', { name: '登录 DSH 团队平台' })).toBeVisible();
        await expect(page.getByRole('link', { name: '没有账号？注册' })).toHaveAttribute(
          'href',
          '/_platform/register',
        );
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
        await submitPendingAccountForm(page, '登录');
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
        await expectNoBrowserStorage(page);
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
        await expectNoScriptVisibleCookie(page);
        await screenshot('login-authenticated-local-destination');
        expect(loginRequests).toEqual(['POST', 'POST', 'POST', 'POST', 'POST']);
        expect(loginStatuses).toEqual([401, 401, 403, 429, 200]);
        expectHealthy([401, 401, 403, 429]);
      });
    },
  );
});
