import { expect, test } from '@playwright/test';
import { readPublicIdentity, type PublicIdentity } from './auth-fixture.ts';
import {
  expectCredentialLayout,
  expectNoBrowserStorage,
  expectNoScriptVisibleCookie,
  observeAccountUi,
  submitPendingAccountForm,
  withAccountUi,
  withAccountUiRouteCleanup,
} from './account-ui-fixture.ts';

test('built React registration recovers from real short-password and duplicate-email errors into its own employee session', async ({
  page,
  playwright,
}, testInfo) => {
  await withAccountUi(
    playwright,
    async ({ baseUrl, database, seed, target, upstreamRequests, admittedUsers }) => {
      const registrationUrl = `${baseUrl}/_platform/api/register`;
      await withAccountUiRouteCleanup(page, async (release) => {
        // Only the duplicate account uses the API jar; the browser starts without any session.
        const duplicate = await seed.post('/_platform/api/register', {
          data: { email: 'existing@example.com', password: 'seed-only-password' },
        });
        expect(duplicate.status()).toBe(201);
        const seededIdentity = readPublicIdentity(await duplicate.json());
        const seedCookie = (await seed.storageState()).cookies.find(
          (cookie) => cookie.name === 'platform_session',
        );
        expect(seedCookie).toBeDefined();
        expect(await page.context().cookies()).toEqual([]);
        const {
          requests: registrationRequests,
          statuses: registrationStatuses,
          otherMutations,
          screenshot,
          expectHealthy,
        } = observeAccountUi(page, testInfo, baseUrl, registrationUrl);
        async function expectEditableFailure(message: string) {
          await expect(page.getByRole('alert')).toHaveText(message);
          await expect(page.getByLabel('邮箱')).toBeEnabled();
          await expect(page.getByLabel('密码')).toBeEnabled();
          await expect(page.getByRole('button', { name: '注册', exact: true })).toBeEnabled();
          await expect(page.getByRole('form', { name: '注册' })).toHaveAttribute(
            'aria-busy',
            'false',
          );
          await expect(page).toHaveURL(`${baseUrl}/_platform/register`);
          expect(await page.context().cookies()).toEqual([]);
          expect(upstreamRequests).toEqual([]);
          expect(admittedUsers).toEqual([]);
        }

        const entry = await page.goto(`${baseUrl}/_platform/register`, {
          waitUntil: 'networkidle',
        });

        expect(entry?.status()).toBe(200);
        await expect(page.getByRole('heading', { name: '注册 DSH 团队平台' })).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
        const [loginPage] = await Promise.all([
          page.waitForResponse((response) => response.url() === `${baseUrl}/_platform/login`),
          page.getByRole('link', { name: '已有账号？登录' }).click(),
        ]);
        expect(loginPage.status()).toBe(200);
        await expect(page.getByRole('heading', { name: '登录 DSH 团队平台' })).toBeVisible();
        const [registrationPage] = await Promise.all([
          page.waitForResponse((response) => response.url() === `${baseUrl}/_platform/register`),
          page.getByRole('link', { name: '没有账号？注册' }).click(),
        ]);
        expect(registrationPage.status()).toBe(200);
        const form = page.getByRole('form', { name: '注册' });
        await expect(form).toBeVisible();
        await expect(page.getByLabel('邮箱')).toBeEnabled();
        await expect(page.getByLabel('密码')).toBeEnabled();
        await expect(page.getByRole('button', { name: '注册', exact: true })).toBeEnabled();
        expect(await page.context().cookies()).toEqual([]);
        await screenshot('registration');
        await page.getByLabel('邮箱').fill('unused@example.com');
        await page.getByLabel('密码').fill('short');
        const paused = Promise.withResolvers<undefined>();
        await page.route(
          registrationUrl,
          async (route) => {
            paused.resolve(undefined);
            await release.promise;
            await route.continue();
          },
          { times: 1 },
        );

        await page.getByRole('button', { name: '注册', exact: true }).click();
        await paused.promise;

        await expect(page.getByRole('status')).toHaveText('正在注册…');
        await expect(form).toHaveAttribute('aria-busy', 'true');
        await expect(page.getByLabel('邮箱')).toBeDisabled();
        await expect(page.getByLabel('密码')).toBeDisabled();
        await expect(page.getByRole('button', { name: '正在注册…' })).toBeDisabled();
        await submitPendingAccountForm(page, '注册');
        expect(registrationRequests).toEqual(['POST']);
        expect(await page.context().cookies()).toEqual([]);
        await screenshot('registration-pending');
        const shortResponse = page.waitForResponse(
          (response) => response.url() === registrationUrl,
        );
        release.resolve(undefined);
        const short = await shortResponse;
        expect(short.status()).toBe(400);
        await expectEditableFailure('密码太短，请输入至少 6 个字符。');
        await expect(page.getByLabel('密码')).toHaveValue('short');
        await screenshot('registration-short-password');

        const password = ' browser-owned-😀-password ';
        await page.getByLabel('邮箱').fill('existing@example.com');
        await page.getByLabel('密码').fill(password);
        const [conflict] = await Promise.all([
          page.waitForResponse((response) => response.url() === registrationUrl),
          page.getByRole('button', { name: '注册', exact: true }).click(),
        ]);

        expect(conflict.status()).toBe(409);
        await expectEditableFailure('邮箱已注册，请使用其他邮箱或登录。');
        await expect(page.getByLabel('密码')).toHaveValue(password);
        await screenshot('registration-duplicate-email');
        await expectNoBrowserStorage(page);
        await page.getByLabel('邮箱').fill('unused@example.com');

        const [success] = await Promise.all([
          page.waitForResponse((response) => response.url() === registrationUrl),
          page.getByRole('button', { name: '注册', exact: true }).click(),
        ]);

        expect(success.status()).toBe(201);
        // Success navigation can discard the response body; observe the owned committed account.
        const identity = readPublicIdentity(
          database
            .prepare<[string], PublicIdentity>('SELECT id, email, role FROM users WHERE email = ?')
            .get('unused@example.com'),
        );
        expect(identity).toEqual({
          id: expect.stringMatching(/^[a-z0-9]{12}$/),
          email: 'unused@example.com',
          role: 'employee',
        });
        expect(identity.id).not.toBe(seededIdentity.id);
        await expect(page).toHaveURL(`${baseUrl}/`);
        await expect(page.locator('body')).toContainText('本地已认证入口（非 DSH）');
        expect(admittedUsers).toContain(identity.id);
        expect(upstreamRequests).toContainEqual({ path: '/', cookie: target.cookie });
        const cookie = (await page.context().cookies()).find(
          (cookie) => cookie.name === 'platform_session',
        );
        expect(cookie).toMatchObject({ httpOnly: true, path: '/', sameSite: 'Lax' });
        expect(cookie?.value).not.toBe(seedCookie?.value);
        await expectNoScriptVisibleCookie(page);
        await screenshot('registration-authenticated-local-destination');
        expect(registrationRequests).toEqual(['POST', 'POST', 'POST']);
        expect(registrationStatuses).toEqual([400, 409, 201]);
        expect(otherMutations).toEqual([]);
        expectHealthy([400, 409]);
      });
    },
  );
});

test('built React registration places its brand panel beside the form on desktop and above it on narrow screens', async ({
  page,
  playwright,
}, testInfo) => {
  await expectCredentialLayout(playwright, page, testInfo, {
    form: 'registration',
    name: '注册',
    alternative: '已有账号？登录',
  });
});
