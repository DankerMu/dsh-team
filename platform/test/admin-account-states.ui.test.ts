import { expect, test } from '@playwright/test';
import { readPublicIdentity } from './auth-fixture.ts';
import {
  observeAccountUi,
  withAccountUi,
  withAccountUiRouteCleanup,
} from './account-ui-fixture.ts';
import {
  ADMIN_UI_PASSWORD,
  withAdminUi,
  holdAdminList,
  openPendingAdminList,
  failAdminList,
  expectPlatformLogin,
} from './admin-ui-fixture.ts';

for (const authenticated of [false, true]) {
  test(
    authenticated
      ? 'employee sees real administrator denial without accounts or actions'
      : 'anonymous account page returns to fixed login after real authority rejection',
    async ({ page, playwright }, testInfo) => {
      await withAccountUi(playwright, async ({ baseUrl, seed }) => {
        if (authenticated) {
          const registered = await seed.post('/_platform/api/register', {
            data: { email: 'denied@example.com', password: ADMIN_UI_PASSWORD },
          });
          expect(registered.status()).toBe(201);
          const login = await page.context().request.post(`${baseUrl}/_platform/api/login`, {
            headers: { Origin: baseUrl },
            data: { email: 'denied@example.com', password: ADMIN_UI_PASSWORD },
          });
          expect(login.status()).toBe(200);
        }
        const url = `${baseUrl}/_platform/api/admin/users?page=1&pageSize=20`;
        const { actionResponses, otherMutations, screenshot, expectHealthy } = observeAccountUi(
          page,
          testInfo,
          baseUrl,
          url,
        );

        const entry = await page.goto(`${baseUrl}/_platform/admin`, { waitUntil: 'networkidle' });

        expect(entry?.status()).toBe(200);
        if (authenticated) {
          await expect(page.getByRole('alert')).toHaveText('无权限');
          await expect(page.getByRole('table')).toHaveCount(0);
          await expect(page.getByRole('button')).toHaveCount(0);
          await expect(page.getByRole('dialog')).toHaveCount(0);
        } else {
          await expectPlatformLogin(page, baseUrl);
        }
        const status = authenticated ? 403 : 401;
        expect(actionResponses).toEqual([{ url, status }]);
        expect(otherMutations).toEqual([]);
        await screenshot(authenticated ? 'admin-denied' : 'admin-login-required');
        expectHealthy([{ url, status }]);
      });
    },
  );
}

test('account loading holds a real list request and then displays actual rows', async ({
  page,
  playwright,
}, testInfo) => {
  await withAdminUi(playwright, page, async ({ baseUrl, target }) => {
    const url = `${baseUrl}/_platform/api/admin/users?page=1&pageSize=20`;
    const { screenshot, expectHealthy } = observeAccountUi(page, testInfo, baseUrl, url);
    await withAccountUiRouteCleanup(page, async (release) => {
      const held = await holdAdminList(page, url, release.promise);
      await openPendingAdminList(page, `${baseUrl}/_platform/admin`, held.promise);
      await screenshot('admin-loading');
      const loaded = page.waitForResponse((response) => response.url() === url);
      release.resolve(undefined);
      expect((await loaded).status()).toBe(200);
      await expect(page.getByRole('row').filter({ hasText: target.email })).toBeVisible();
      await screenshot('admin-loading-complete');
    });
    expectHealthy([]);
  });
});

test('synthetic empty receipt exercises only the unfiltered empty rendering branch', async ({
  page,
  playwright,
}, testInfo) => {
  await withAdminUi(playwright, page, async ({ baseUrl, database }) => {
    const url = `${baseUrl}/_platform/api/admin/users?page=1&pageSize=20`;
    const { screenshot, expectHealthy } = observeAccountUi(page, testInfo, baseUrl, url);
    await withAccountUiRouteCleanup(page, async () => {
      // A current administrator guarantees real total>=1. This single receipt proves rendering only.
      await page.route(
        url,
        (route) =>
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: '{"items":[],"page":1,"pageSize":20,"total":0}',
          }),
        { times: 1 },
      );

      await page.goto(`${baseUrl}/_platform/admin`, { waitUntil: 'networkidle' });

      await expect(page.getByRole('status')).toHaveText('暂无账号');
      await expect(page.getByRole('table')).toHaveCount(0);
      await screenshot('admin-empty-render-only');
      expect(database.prepare('SELECT COUNT(*) AS total FROM users').get()).toEqual({ total: 2 });
    });
    expectHealthy([]);
  });
});

test('real unmatched search has its own state rather than empty or failed accounts', async ({
  page,
  playwright,
}, testInfo) => {
  await withAdminUi(playwright, page, async ({ baseUrl }) => {
    const listUrl = `${baseUrl}/_platform/api/admin/users?page=1&pageSize=20`;
    const searchUrl = `${listUrl}&search=unmatched%2B%E4%B8%AD%E6%96%87`;
    const { actionResponses, screenshot, expectHealthy } = observeAccountUi(
      page,
      testInfo,
      baseUrl,
      [listUrl, searchUrl],
    );
    await page.goto(`${baseUrl}/_platform/admin`, { waitUntil: 'networkidle' });
    await page.getByLabel('搜索邮箱').fill('unmatched+中文');

    const [response] = await Promise.all([
      page.waitForResponse((result) => result.url() === searchUrl),
      page.getByRole('button', { name: '搜索', exact: true }).click(),
    ]);

    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ items: [], page: 1, pageSize: 20, total: 0 });
    await expect(page.getByRole('status')).toHaveText('没有匹配的账号');
    await expect(page.getByRole('table')).toHaveCount(0);
    expect(actionResponses).toEqual([
      { url: listUrl, status: 200 },
      { url: searchUrl, status: 200 },
    ]);
    await screenshot('admin-no-match');
    expectHealthy([]);
  });
});

test('exact controlled list failure shows retry and recovers through the real account API', async ({
  page,
  playwright,
}, testInfo) => {
  await withAdminUi(playwright, page, async ({ baseUrl, target }) => {
    const url = `${baseUrl}/_platform/api/admin/users?page=1&pageSize=20`;
    const { actionResponses, screenshot, expectHealthy } = observeAccountUi(
      page,
      testInfo,
      baseUrl,
      url,
    );
    await withAccountUiRouteCleanup(page, async () => {
      await failAdminList(page, url, 'private-list-error');
      await page.goto(`${baseUrl}/_platform/admin`, { waitUntil: 'networkidle' });
      await expect(page.getByRole('alert')).toHaveText('加载失败');
      await expect(page.getByRole('button', { name: '重试' })).toBeVisible();
      await expect(page.getByRole('table')).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText('private-list-error');
      await screenshot('admin-list-failure');
      const [retried] = await Promise.all([
        page.waitForResponse((response) => response.url() === url && response.status() === 200),
        page.getByRole('button', { name: '重试' }).click(),
      ]);
      expect(retried.status()).toBe(200);
      await expect(page.getByRole('row').filter({ hasText: target.email })).toBeVisible();
      expect(actionResponses).toEqual([
        { url, status: 500 },
        { url, status: 200 },
      ]);
      await screenshot('admin-list-retry');
    });
    expectHealthy([{ url, status: 500 }]);
  });
});

test('real account search and adjacent pages retain exact server membership and reset page one', async ({
  page,
  playwright,
}, testInfo) => {
  await withAdminUi(playwright, page, async ({ baseUrl, database, seed, target }) => {
    database.prepare('UPDATE users SET created_at=?').run(1_700_000_000_000);
    for (let index = 0; index < 21; index++) {
      const email = `page-${String(index).padStart(2, '0')}@example.com`;
      const response = await seed.post('/_platform/api/register', {
        data: { email, password: ADMIN_UI_PASSWORD },
      });
      expect(response.status()).toBe(201);
      const user = readPublicIdentity(await response.json());
      // Literal independent ordering: page-20 is newest, page-00 oldest, original accounts older still.
      database
        .prepare('UPDATE users SET created_at=? WHERE id=?')
        .run(1_900_000_000_000 + index, user.id);
    }
    const firstUrl = `${baseUrl}/_platform/api/admin/users?page=1&pageSize=20`;
    const nextUrl = `${baseUrl}/_platform/api/admin/users?page=2&pageSize=20`;
    const searchUrl = `${firstUrl}&search=employee-browser`;
    const { actionResponses, screenshot, expectHealthy } = observeAccountUi(
      page,
      testInfo,
      baseUrl,
      [firstUrl, nextUrl, searchUrl],
    );
    await page.goto(`${baseUrl}/_platform/admin`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('row').filter({ hasText: 'page-20@example.com' })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'page-01@example.com' })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'page-00@example.com' })).toHaveCount(0);
    await expect(page.getByRole('row').filter({ hasText: target.email })).toHaveCount(0);
    await expect(page.getByRole('row')).toHaveCount(21);

    await page.getByRole('button', { name: '下一页' }).click();

    await expect(page.getByRole('row')).toHaveCount(4);
    await expect(page.getByRole('row').filter({ hasText: 'page-00@example.com' })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: target.email })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'page-01@example.com' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '下一页' })).toBeDisabled();
    await screenshot('admin-page-two');
    await page.getByLabel('搜索邮箱').fill('employee-browser');
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    await expect(page.getByRole('row')).toHaveCount(2);
    await expect(page.getByRole('row').filter({ hasText: target.email })).toBeVisible();
    await expect(page.locator('.admin-pages')).toContainText('第 1 页，共 1 个账号');
    expect(actionResponses).toEqual([
      { url: firstUrl, status: 200 },
      { url: nextUrl, status: 200 },
      { url: searchUrl, status: 200 },
    ]);
    await screenshot('admin-search');
    expectHealthy([]);
  });
});
