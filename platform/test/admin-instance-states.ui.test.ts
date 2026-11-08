import { expect, test } from '@playwright/test';
import {
  expectViewportLayout,
  observeAccountUi,
  withAccountUiRouteCleanup,
} from './account-ui-fixture.ts';
import { readPublicIdentity } from './auth-fixture.ts';
import {
  ADMIN_UI_PASSWORD,
  withAdminUi,
  holdAdminList,
  openPendingAdminList,
  failAdminList,
  expectPlatformLogin,
  readAuditSnapshot,
  expectAuditUnchanged,
} from './admin-ui-fixture.ts';

const PAGE = '/_platform/admin/instances';
const API = '/_platform/api/admin/instances';

for (const authority of ['anonymous', 'employee', 'demoted'] as const) {
  test(`instance page uses current real ${authority} authority without retaining rows or actions`, async ({
    page,
    playwright,
  }, testInfo) => {
    await withAdminUi(playwright, page, async ({ baseUrl, database, admin, target }) => {
      if (authority === 'anonymous') await page.context().clearCookies();
      if (authority === 'employee') {
        const login = await page.context().request.post(`${baseUrl}/_platform/api/login`, {
          headers: { Origin: baseUrl },
          data: { email: target.email, password: ADMIN_UI_PASSWORD },
        });
        expect(login.status()).toBe(200);
      }
      const url = `${baseUrl}${API}`;
      const observed = observeAccountUi(page, testInfo, baseUrl, url);
      const before = readAuditSnapshot(database);
      await page.goto(`${baseUrl}${PAGE}`, { waitUntil: 'networkidle' });
      if (authority === 'demoted') {
        await expect(page.getByRole('row').filter({ hasText: target.email })).toBeVisible();
        database.prepare("UPDATE users SET role='employee' WHERE id=?").run(admin.id);
        await page.getByRole('button', { name: '刷新', exact: true }).click();
      }

      if (authority === 'anonymous') await expectPlatformLogin(page, baseUrl);
      else {
        await expect(page.getByRole('alert')).toHaveText('无权限');
        await expect(page.getByRole('table')).toHaveCount(0);
        await expect(page.getByRole('button')).toHaveCount(0);
        await expect(page.getByRole('dialog')).toHaveCount(0);
      }
      expectAuditUnchanged(database, before);
      expect(observed.otherMutations).toEqual([]);
      await observed.screenshot(`instances-authority-${authority}`);
      observed.expectHealthy([{ url, status: authority === 'anonymous' ? 401 : 403 }]);
    });
  });
}

test('instance loading, controlled failure and rendering-only empty remain distinct with real retry', async ({
  page,
  playwright,
}, testInfo) => {
  await withAdminUi(playwright, page, async ({ baseUrl, database, target }) => {
    const url = `${baseUrl}${API}`;
    const observed = observeAccountUi(page, testInfo, baseUrl, url);
    const before = readAuditSnapshot(database);
    await withAccountUiRouteCleanup(page, async (release) => {
      const arrival = await holdAdminList(page, url, release.promise);
      await openPendingAdminList(page, `${baseUrl}${PAGE}`, arrival.promise);
      await observed.screenshot('instances-loading');
      release.resolve(undefined);
      await expect(page.getByRole('row').filter({ hasText: target.email })).toBeVisible();
      await failAdminList(page, url, 'private-instance-diagnostic');
      await page.getByRole('button', { name: '刷新', exact: true }).click();
      await expect(page.getByRole('alert')).toHaveText('加载失败，请重试。');
      await expect(page.getByRole('table')).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText('private-instance-diagnostic');
      await observed.screenshot('instances-list-failure');
      await page.getByRole('button', { name: '重试', exact: true }).click();
      await expect(page.getByRole('row').filter({ hasText: target.email })).toBeVisible();
      // A current administrator is itself a row. This response qualifies empty rendering only.
      await page.route(
        url,
        (route) =>
          route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }),
        { times: 1 },
      );
      await page.getByRole('button', { name: '刷新', exact: true }).click();
      await expect(page.getByRole('status')).toHaveText('暂无实例');
      await expect(page.getByRole('table')).toHaveCount(0);
      expect(database.prepare('SELECT COUNT(*) AS count FROM users').get()).toEqual({ count: 2 });
      await observed.screenshot('instances-empty-rendering-only');
    });
    expectAuditUnchanged(database, before);
    expect(observed.actionRequests.map((request) => request.method)).toEqual([
      'GET',
      'GET',
      'GET',
      'GET',
    ]);
    observed.expectHealthy([{ url, status: 500 }]);
  });
});

test('current administrator revocation at confirmation rejects the real reset without audit or stale controls', async ({
  page,
  playwright,
}, testInfo) => {
  await withAdminUi(playwright, page, async ({ baseUrl, database, admin, target }) => {
    database.prepare("INSERT INTO instances(user_id,status) VALUES (?,'stopped')").run(target.id);
    const list = `${baseUrl}${API}`;
    const reset = `${list}/${target.id}/reset-config`;
    const observed = observeAccountUi(page, testInfo, baseUrl, [list, reset]);
    const before = readAuditSnapshot(database);
    await page.goto(`${baseUrl}${PAGE}`, { waitUntil: 'networkidle' });
    await page
      .getByRole('row')
      .filter({ hasText: target.email })
      .getByRole('button', { name: '重置配置', exact: true })
      .click();
    database.prepare("UPDATE users SET role='employee' WHERE id=?").run(admin.id);
    const result = page.waitForResponse(reset);
    await page.getByRole('button', { name: '确认', exact: true }).click();

    expect((await result).status()).toBe(403);
    await expect(page.getByRole('alert')).toHaveText('无权限');
    await expect(page.getByRole('table')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button')).toHaveCount(0);
    expectAuditUnchanged(database, before);
    expect(database.prepare('SELECT status FROM instances WHERE user_id=?').get(target.id)).toEqual(
      { status: 'stopped' },
    );
    await observed.screenshot('instances-reset-current-authority');
    observed.expectHealthy([{ url: reset, status: 403 }]);
  });
});

test('only a current profile-incompatible error row shows the fixed reset hint beside its reset action', async ({
  page,
  playwright,
}, testInfo) => {
  await withAdminUi(playwright, page, async ({ baseUrl, database, seed, target }) => {
    const hint = '该用户的 DSH 配置来自旧版本，需要执行“重置配置”';
    const coded =
      'profile-incompatible\nDSH readiness failed during startup; container stopped; owned network removed\ndsh: skipping profile bundle "@deepseek-ai/dsh-web-app": incompatible';
    const insert = database.prepare(
      'INSERT INTO instances(user_id,status,last_error) VALUES (?,?,?)',
    );
    insert.run(target.id, 'error', coded);
    const others = [
      ['plain-error', 'error', 'DSH readiness failed: deadline or cancellation; container stopped'],
      // A reset stops through stop('admin') and keeps the coded diagnostic: no hint once stopped.
      ['reset-stopped', 'stopped', coded],
    ] as const;
    for (const [name, status, lastError] of others) {
      const registered = await seed.post('/_platform/api/register', {
        data: { email: `${name}@example.test`, password: ADMIN_UI_PASSWORD },
      });
      expect(registered.status()).toBe(201);
      insert.run(readPublicIdentity(await registered.json()).id, status, lastError);
    }
    const url = `${baseUrl}${API}`;
    const observed = observeAccountUi(page, testInfo, baseUrl, url);
    const before = readAuditSnapshot(database);

    await page.goto(`${baseUrl}${PAGE}`, { waitUntil: 'networkidle' });

    const row = page.getByRole('row').filter({ hasText: target.email });
    await expect(row.getByText(hint, { exact: true })).toBeVisible();
    await expect(
      row
        .getByRole('button', { name: '重置配置', exact: true })
        .locator('xpath=following-sibling::*[1]'),
    ).toHaveText(hint);
    await expect(page.getByText(hint, { exact: true })).toHaveCount(1);
    for (const [name] of others)
      await expect(
        page.getByRole('row').filter({ hasText: `${name}@example.test` }),
      ).not.toContainText(hint);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await observed.screenshot('instances-profile-incompatible-hint');
    await expectViewportLayout(
      page,
      observed.screenshot,
      'glass-admin-instances-profile-hint',
      async () => {
        await expect(row.getByText(hint, { exact: true })).toBeVisible();
      },
    );
    expectAuditUnchanged(database, before);
    expect(observed.actionRequests).toEqual([{ url, method: 'GET' }]);
    expect(observed.otherMutations).toEqual([]);
    observed.expectHealthy([]);
  });
});
