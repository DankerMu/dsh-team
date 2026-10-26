import { expect, test } from '@playwright/test';
import { readPublicIdentity, type PublicIdentity } from './auth-fixture.ts';
import {
  expectNoBrowserStorage,
  expectNoScriptVisibleCookie,
  expectViewportLayout,
  observeAccountUi,
  submitPendingAccountForm,
  withAccountUi,
  withAccountUiRouteCleanup,
} from './account-ui-fixture.ts';

test('built account page changes the password with session rotation, logs out and accepts only the new password', async ({
  page,
  playwright,
}, testInfo) => {
  await withAccountUi(
    playwright,
    async ({ baseUrl, database, seed, target, upstreamRequests, admittedUsers }) => {
      const loginUrl = `${baseUrl}/_platform/api/login`;
      const passwordUrl = `${baseUrl}/_platform/api/change-password`;
      const logoutUrl = `${baseUrl}/_platform/api/logout`;
      const email = 'password-browser@example.com';
      const oldPassword = ' browser-old-😀-password ';
      const newPassword = ' browser-new-😀-password ';
      await withAccountUiRouteCleanup(page, async (release) => {
        const registered = await seed.post('/_platform/api/register', {
          data: { email, password: oldPassword },
        });
        expect(registered.status()).toBe(201);
        const identity = readPublicIdentity(await registered.json());
        const seedCookie = (await seed.storageState()).cookies.find(
          (cookie) => cookie.name === 'platform_session',
        );
        expect(seedCookie).toBeDefined();
        expect(await page.context().cookies()).toEqual([]);
        const { actionRequests, actionResponses, otherMutations, screenshot, expectHealthy } =
          observeAccountUi(page, testInfo, baseUrl, [loginUrl, passwordUrl, logoutUrl]);
        async function expectBrowserAdmission(): Promise<void> {
          const result = await page.evaluate(async () => {
            const response = await fetch('/', { credentials: 'same-origin' });
            return { status: response.status, body: await response.text() };
          });
          expect(result).toEqual({ status: 200, body: '本地已认证入口（非 DSH）' });
        }

        const registration = await page.goto(`${baseUrl}/_platform/register`, {
          waitUntil: 'networkidle',
        });
        expect(registration?.status()).toBe(200);
        await expect(page.getByRole('link', { name: '账号设置' })).toHaveAttribute(
          'href',
          '/_platform/account',
        );
        await page.getByRole('link', { name: '已有账号？登录' }).click();
        await expect(page.getByRole('heading', { name: '登录 DSH 团队平台' })).toBeVisible();
        await page.getByLabel('邮箱').fill(email);
        await page.getByLabel('密码').fill(oldPassword);
        const [login] = await Promise.all([
          page.waitForResponse((response) => response.url() === loginUrl),
          page.getByRole('button', { name: '登录', exact: true }).click(),
        ]);
        expect(login.status()).toBe(200);
        await expect(page).toHaveURL(`${baseUrl}/`);
        await expect(page.locator('body')).toContainText('本地已认证入口（非 DSH）');
        expect(admittedUsers).toContain(identity.id);
        const browserCookie = (await page.context().cookies()).find(
          (cookie) => cookie.name === 'platform_session',
        );
        if (browserCookie === undefined) throw new Error('Missing browser-owned session');
        expect(browserCookie).toMatchObject({ httpOnly: true, path: '/', sameSite: 'Lax' });
        expect(browserCookie.value).not.toBe(seedCookie?.value);

        await page.goto(`${baseUrl}/_platform/login`, { waitUntil: 'networkidle' });
        const [account] = await Promise.all([
          page.waitForResponse((response) => response.url() === `${baseUrl}/_platform/account`),
          page.getByRole('link', { name: '账号设置' }).click(),
        ]);
        expect(account.status()).toBe(200);
        await expect(page).toHaveURL(`${baseUrl}/_platform/account`);
        await expect(page.getByRole('heading', { name: '修改密码', exact: true })).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
        await expect(page.getByRole('link', { name: '返回工作台' })).toHaveAttribute('href', '/');
        const form = page.getByRole('form', { name: '修改密码' });
        await expect(form).toBeVisible();
        await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeEnabled();
        expect(actionRequests).toEqual([{ url: loginUrl, method: 'POST' }]);
        await screenshot('account');
        await expectViewportLayout(page, screenshot, 'glass-account', async () => {
          await expect(form).toBeVisible();
        });
        await expectNoScriptVisibleCookie(page);
        await expectNoBrowserStorage(page);

        await page.getByLabel('当前密码').fill('wrong-current-password');
        await page.getByLabel('新密码').fill(newPassword);
        const [wrong] = await Promise.all([
          page.waitForResponse((response) => response.url() === passwordUrl),
          page.getByRole('button', { name: '修改密码', exact: true }).click(),
        ]);
        expect(wrong.status()).toBe(401);
        expect(await wrong.json()).toMatchObject({ message: 'Current password is incorrect' });
        await expect(page.getByRole('alert')).toHaveText('当前密码错误，请重试。');
        await expect(page).toHaveURL(`${baseUrl}/_platform/account`);
        await expect(page.getByLabel('当前密码')).toHaveValue('wrong-current-password');
        await expect(page.getByLabel('新密码')).toHaveValue(newPassword);
        await expect(page.getByLabel('当前密码')).toBeEnabled();
        await expect(page.getByLabel('新密码')).toBeEnabled();
        await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeEnabled();
        expect(
          (await page.context().cookies()).find((cookie) => cookie.name === 'platform_session'),
        ).toEqual(browserCookie);
        await expectBrowserAdmission();
        await screenshot('account-wrong-current-password');

        await page.getByLabel('当前密码').fill(oldPassword);
        const paused = Promise.withResolvers<undefined>();
        await page.route(
          passwordUrl,
          async (route) => {
            expect(route.request().method()).toBe('POST');
            expect(route.request().postDataJSON()).toEqual({
              currentPassword: oldPassword,
              newPassword,
            });
            paused.resolve(undefined);
            await release.promise;
            await route.continue();
          },
          { times: 1 },
        );
        await page.getByRole('button', { name: '修改密码', exact: true }).click();
        await paused.promise;
        await expect(page.getByRole('status')).toHaveText('正在修改密码…');
        await expect(form).toHaveAttribute('aria-busy', 'true');
        await expect(page.getByLabel('当前密码')).toBeDisabled();
        await expect(page.getByLabel('新密码')).toBeDisabled();
        await expect(page.getByRole('button', { name: '正在修改密码…' })).toBeDisabled();
        await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeDisabled();
        await submitPendingAccountForm(page, '修改密码');
        await page
          .getByRole('button', { name: '退出登录', exact: true })
          .evaluate((element: unknown) => {
            // Chromium supplies the DOM constructor; the root Node config has no DOM lib.
            const browser = globalThis as typeof globalThis & {
              HTMLButtonElement: new () => { click(): void };
            };
            if (!(element instanceof browser.HTMLButtonElement))
              throw new Error('Missing logout button');
            element.click();
          });
        expect(actionRequests).toEqual([
          { url: loginUrl, method: 'POST' },
          { url: passwordUrl, method: 'POST' },
          { url: passwordUrl, method: 'POST' },
        ]);
        expect(
          (await page.context().cookies()).find((cookie) => cookie.name === 'platform_session'),
        ).toEqual(browserCookie);
        await screenshot('account-password-pending');
        const changedResponse = page.waitForResponse((response) => response.url() === passwordUrl);
        release.resolve(undefined);
        const changed = await changedResponse;
        expect(changed.status()).toBe(204);
        // Chromium need not expose a body resource for 204; verify its committed effects below.
        await expect(page.getByRole('status')).toHaveText('密码修改成功。');
        await expect(page).toHaveURL(`${baseUrl}/_platform/account`);
        await expect(page.getByLabel('当前密码')).toHaveValue('');
        await expect(page.getByLabel('新密码')).toHaveValue('');
        await expect(page.getByLabel('当前密码')).toBeEnabled();
        await expect(page.getByLabel('新密码')).toBeEnabled();
        await expect(page.getByRole('button', { name: '修改密码', exact: true })).toBeEnabled();
        await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeEnabled();
        const replacement = (await page.context().cookies()).find(
          (cookie) => cookie.name === 'platform_session',
        );
        expect(replacement).toMatchObject({ httpOnly: true, path: '/', sameSite: 'Lax' });
        expect(replacement?.value).not.toBe(browserCookie.value);
        await expectBrowserAdmission();
        const admittedBeforeOldProbe = [...admittedUsers];
        const upstreamBeforeOldProbe = [...upstreamRequests];
        const revoked = await seed.get('/', {
          headers: {
            Cookie: `platform_session=${browserCookie.value}`,
            Accept: 'application/json',
          },
          maxRedirects: 0,
        });
        expect(revoked.status()).toBe(401);
        expect(admittedUsers).toEqual(admittedBeforeOldProbe);
        expect(upstreamRequests).toEqual(upstreamBeforeOldProbe);
        await expectNoScriptVisibleCookie(page);
        await expectNoBrowserStorage(page);
        await screenshot('account-password-changed');

        const [loggedOut] = await Promise.all([
          page.waitForResponse((response) => response.url() === logoutUrl),
          page.getByRole('button', { name: '退出登录', exact: true }).click(),
        ]);
        expect(loggedOut.status()).toBe(204);
        expect(loggedOut.request().postDataJSON()).toEqual({});
        // Do not read an empty response body from the document already being left.
        await expect(page).toHaveURL(`${baseUrl}/_platform/login`);
        await expect(page.getByRole('heading', { name: '登录 DSH 团队平台' })).toBeVisible();
        expect(await page.context().cookies()).toEqual([]);
        await screenshot('account-logged-out');
        await page.getByLabel('邮箱').fill(email);
        await page.getByLabel('密码').fill(oldPassword);
        const [oldLogin] = await Promise.all([
          page.waitForResponse((response) => response.url() === loginUrl),
          page.getByRole('button', { name: '登录', exact: true }).click(),
        ]);
        expect(oldLogin.status()).toBe(401);
        await expect(page.getByRole('alert')).toHaveText('邮箱或密码错误。');
        await expect(page).toHaveURL(`${baseUrl}/_platform/login`);
        expect(await page.context().cookies()).toEqual([]);
        await screenshot('account-old-password-refused');
        await page.getByLabel('密码').fill(newPassword);
        const [newLogin] = await Promise.all([
          page.waitForResponse((response) => response.url() === loginUrl),
          page.getByRole('button', { name: '登录', exact: true }).click(),
        ]);
        expect(newLogin.status()).toBe(200);
        await expect(page).toHaveURL(`${baseUrl}/`);
        await expect(page.locator('body')).toContainText('本地已认证入口（非 DSH）');
        const committedIdentity = readPublicIdentity(
          database
            .prepare<[string], PublicIdentity>('SELECT id, email, role FROM users WHERE email = ?')
            .get(email),
        );
        expect(committedIdentity).toEqual(identity);
        expect(admittedUsers).toEqual([identity.id, identity.id, identity.id, identity.id]);
        expect(upstreamRequests).toEqual([
          { path: '/', cookie: target.cookie },
          { path: '/', cookie: target.cookie },
          { path: '/', cookie: target.cookie },
          { path: '/', cookie: target.cookie },
        ]);
        await expectNoScriptVisibleCookie(page);
        await expectNoBrowserStorage(page);
        await screenshot('account-new-password-authenticated-local-destination');
        expect(actionRequests).toEqual([
          { url: loginUrl, method: 'POST' },
          { url: passwordUrl, method: 'POST' },
          { url: passwordUrl, method: 'POST' },
          { url: logoutUrl, method: 'POST' },
          { url: loginUrl, method: 'POST' },
          { url: loginUrl, method: 'POST' },
        ]);
        expect(actionResponses).toEqual([
          { url: loginUrl, status: 200 },
          { url: passwordUrl, status: 401 },
          { url: passwordUrl, status: 204 },
          { url: logoutUrl, status: 204 },
          { url: loginUrl, status: 401 },
          { url: loginUrl, status: 200 },
        ]);
        expect(otherMutations).toEqual([]);
        expectHealthy(
          [
            { url: passwordUrl, status: 401 },
            { url: loginUrl, status: 401 },
          ],
          [changed.request(), loggedOut.request()],
        );
      });
    },
  );
});
