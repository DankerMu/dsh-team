import { expect, test } from '@playwright/test';
import { withAccountUi, withAccountUiRouteCleanup } from './account-ui-fixture.ts';
import {
  seedAdminUi,
  withAdminUi,
  observeAuditUi,
  seedAuditUiEvent,
  readAuditSnapshot,
  expectAuditUnchanged,
  holdAdminList,
  openPendingAdminList,
  failAdminList,
  expectPlatformLogin,
} from './admin-ui-fixture.ts';

test('a genuinely empty owned audit table has the unfiltered empty state', async ({
  page,
  playwright,
}, testInfo) => {
  await withAdminUi(playwright, page, async ({ baseUrl, database }) => {
    // Only this invocation's isolated data is cleared after real authentication.
    database.prepare('DELETE FROM audit_events').run();
    const { screenshot, expectHealthy, otherMutations } = observeAuditUi(page, testInfo, baseUrl);

    await page.goto(`${baseUrl}/_platform/admin/audit`, { waitUntil: 'networkidle' });

    await expect(page.getByRole('status')).toHaveText('暂无审计记录');
    await expect(page.getByRole('table')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '下一页' })).toBeDisabled();
    expect(database.prepare('SELECT * FROM audit_events').all()).toEqual([]);
    expect(otherMutations).toEqual([]);
    await screenshot('audit-real-empty');
    expectHealthy([]);
  });
});

test('loading holds one exact real audit GET and releases actual stored rows', async ({
  page,
  playwright,
}, testInfo) => {
  await withAdminUi(playwright, page, async ({ baseUrl, database }) => {
    seedAuditUiEvent(database, 'loading-owned-event');
    const before = readAuditSnapshot(database);
    const { url, screenshot, expectHealthy, otherMutations } = observeAuditUi(
      page,
      testInfo,
      baseUrl,
    );
    await withAccountUiRouteCleanup(page, async (release) => {
      const held = await holdAdminList(page, url, release.promise);
      await openPendingAdminList(page, `${baseUrl}/_platform/admin/audit`, held.promise);
      await expect(page.getByLabel('审计分页')).toHaveCount(0);
      await screenshot('audit-loading');
      const response = page.waitForResponse(url);
      release.resolve(undefined);
      expect((await response).status()).toBe(200);
      await expect(page.getByRole('row').filter({ hasText: 'loading-owned-event' })).toBeVisible();
      await screenshot('audit-loading-complete');
    });
    expectAuditUnchanged(database, before);
    expect(otherMutations).toEqual([]);
    expectHealthy([]);
  });
});

test('one exact controlled audit failure has safe feedback and retry reads real storage', async ({
  page,
  playwright,
}, testInfo) => {
  await withAdminUi(playwright, page, async ({ baseUrl, database }) => {
    seedAuditUiEvent(database, 'retry-owned-event');
    const before = readAuditSnapshot(database);
    const { url, screenshot, expectHealthy, actionResponses, otherMutations } = observeAuditUi(
      page,
      testInfo,
      baseUrl,
    );
    await withAccountUiRouteCleanup(page, async () => {
      await failAdminList(page, url, 'private-audit-error');
      await page.goto(`${baseUrl}/_platform/admin/audit`, { waitUntil: 'networkidle' });
      await expect(page.getByRole('alert')).toHaveText('加载失败');
      await expect(page.getByRole('table')).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText('private-audit-error');
      await screenshot('audit-failure');
      const response = page.waitForResponse(
        (entry) => entry.url() === url && entry.status() === 200,
      );

      await page.getByRole('button', { name: '重试' }).click();

      expect((await response).status()).toBe(200);
      await expect(page.getByRole('row').filter({ hasText: 'retry-owned-event' })).toBeVisible();
      expect(actionResponses).toEqual([
        { url, status: 500 },
        { url, status: 200 },
      ]);
      await screenshot('audit-retry-real');
    });
    expectAuditUnchanged(database, before);
    expect(otherMutations).toEqual([]);
    expectHealthy([{ url, status: 500 }]);
  });
});

for (const authenticated of [false, true]) {
  test(
    authenticated
      ? 'current employee role is denied real audits without rows or controls'
      : 'anonymous audit page consumes real401 and returns to login',
    async ({ page, playwright }, testInfo) => {
      await withAccountUi(playwright, async ({ baseUrl, database, seed }) => {
        if (authenticated) {
          const { admin } = await seedAdminUi(seed, database, page, baseUrl);
          database.prepare("UPDATE users SET role='employee' WHERE id=?").run(admin.id);
        }
        const before = readAuditSnapshot(database);
        const { url, screenshot, expectHealthy, actionResponses, otherMutations } = observeAuditUi(
          page,
          testInfo,
          baseUrl,
        );

        await page.goto(`${baseUrl}/_platform/admin/audit`, { waitUntil: 'networkidle' });

        if (authenticated) {
          await expect(page.getByRole('alert')).toHaveText('无权限');
          await expect(page.getByRole('table')).toHaveCount(0);
          await expect(page.getByRole('form')).toHaveCount(0);
          await expect(page.getByRole('button')).toHaveCount(0);
        } else {
          await expectPlatformLogin(page, baseUrl);
        }
        const status = authenticated ? 403 : 401;
        expect(actionResponses).toEqual([{ url, status }]);
        expect(otherMutations).toEqual([]);
        expectAuditUnchanged(database, before);
        await screenshot(authenticated ? 'audit-employee-denied' : 'audit-login-required');
        expectHealthy([{ url, status }]);
      });
    },
  );
}

test('an already open audit page loses current authority after real role demotion and session revocation', async ({
  page,
  playwright,
}, testInfo) => {
  await withAdminUi(playwright, page, async ({ baseUrl, database, admin }) => {
    seedAuditUiEvent(database, 'authority-owned-event');
    const before = readAuditSnapshot(database);
    const { url, screenshot, expectHealthy, otherMutations } = observeAuditUi(
      page,
      testInfo,
      baseUrl,
    );
    await page.goto(`${baseUrl}/_platform/admin/audit`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('row').filter({ hasText: 'authority-owned-event' })).toBeVisible();
    database.prepare("UPDATE users SET role='employee' WHERE id=?").run(admin.id);

    await page.getByRole('button', { name: '筛选', exact: true }).click();

    await expect(page.getByRole('alert')).toHaveText('无权限');
    await expect(page.getByRole('table')).toHaveCount(0);
    await expect(page.getByRole('form')).toHaveCount(0);
    await screenshot('audit-current-demotion');
    database.prepare("UPDATE users SET role='admin' WHERE id=?").run(admin.id);
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByRole('row').filter({ hasText: 'authority-owned-event' })).toBeVisible();
    database.prepare('DELETE FROM platform_sessions WHERE user_id=?').run(admin.id);
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    await expectPlatformLogin(page, baseUrl);
    await screenshot('audit-current-revocation');
    expectAuditUnchanged(database, before);
    expect(otherMutations).toEqual([]);
    expectHealthy([
      { url, status: 403 },
      { url, status: 401 },
    ]);
  });
});
