import { expect, test } from '@playwright/test';
import { readPublicIdentity } from './auth-fixture.ts';
import {
  expectNoBrowserStorage,
  expectNoScriptVisibleCookie,
  observeAccountUi,
  submitPendingAccountForm,
  withAccountUiRouteCleanup,
} from './account-ui-fixture.ts';
import {
  ADMIN_UI_PASSWORD,
  withAdminUi,
  readAuditSnapshot,
  expectAuditUnchanged,
} from './admin-ui-fixture.ts';

test('administrator opens the built account page and sees the real employee account', async ({
  page,
  playwright,
}, testInfo) => {
  await withAdminUi(playwright, page, async ({ baseUrl }) => {
    const targetEmail = 'employee-browser@example.com';
    const usersUrl = `${baseUrl}/_platform/api/admin/users?page=1&pageSize=20`;
    const { actionResponses, otherMutations, screenshot, expectHealthy } = observeAccountUi(
      page,
      testInfo,
      baseUrl,
      usersUrl,
    );

    const entry = await page.goto(`${baseUrl}/_platform/admin`, { waitUntil: 'networkidle' });

    expect(entry?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: '账号管理', exact: true })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: targetEmail })).toContainText('员工');
    await expect(page.getByRole('row').filter({ hasText: targetEmail })).toContainText('已启用');
    expect(actionResponses).toEqual([{ url: usersUrl, status: 200 }]);
    expect(otherMutations).toEqual([]);
    await expectNoBrowserStorage(page);
    await expectNoScriptVisibleCookie(page);
    await screenshot('admin-accounts');
    expectHealthy([]);
  });
});

test('real confirmed disable, enable and password reset change durable accounts and credentials once', async ({
  page,
  playwright,
}, testInfo) => {
  await withAdminUi(
    playwright,
    page,
    async ({ baseUrl, database, seed, admin, target }) => {
      const oldCookies: string[] = [];
      for (let index = 0; index < 2; index++) {
        const login = await seed.post('/_platform/api/login', {
          data: { email: target.email, password: ADMIN_UI_PASSWORD },
        });
        expect(login.status()).toBe(200);
        const cookie = (await seed.storageState()).cookies.find(
          (entry) => entry.name === 'platform_session',
        );
        if (cookie === undefined) throw new Error('Missing owned employee session');
        oldCookies.push(`platform_session=${cookie.value}`);
      }
      const listUrl = `${baseUrl}/_platform/api/admin/users?page=1&pageSize=20`;
      const statusUrl = `${baseUrl}/_platform/api/admin/users/${target.id}/status`;
      const passwordUrl = `${baseUrl}/_platform/api/admin/users/${target.id}/password`;
      const { actionRequests, actionResponses, screenshot, expectHealthy, otherMutations } =
        observeAccountUi(page, testInfo, baseUrl, [listUrl, statusUrl, passwordUrl]);
      const adminSessions = database
        .prepare('SELECT * FROM platform_sessions WHERE user_id=? ORDER BY token_hash')
        .all(admin.id);
      const employeeRow = page.getByRole('row').filter({ hasText: target.email });
      await withAccountUiRouteCleanup(page, async (release) => {
        await page.goto(`${baseUrl}/_platform/admin`, { waitUntil: 'networkidle' });
        await expect(employeeRow).toContainText('已启用');
        const beforeCancel = readAuditSnapshot(database);
        const sessionsBeforeCancel = database
          .prepare('SELECT * FROM platform_sessions ORDER BY token_hash')
          .all();
        await employeeRow.getByRole('button', { name: '禁用', exact: true }).click();
        await expect(page.getByRole('dialog')).toContainText(target.email);
        await expect(page.getByRole('dialog')).toContainText(
          '撤销该账号全部会话、断开连接并停止实例',
        );
        await screenshot('admin-disable-confirmation');
        await page.getByRole('button', { name: '取消', exact: true }).click();
        await employeeRow.getByRole('button', { name: '重置密码' }).click();
        await page.getByLabel('新密码').fill('canceled-private-password');
        await expect(page.getByLabel('新密码')).toHaveAttribute('type', 'password');
        await page.getByLabel('新密码').press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);
        expect(actionRequests).toEqual([{ url: listUrl, method: 'GET' }]);
        expect(database.prepare('SELECT status FROM users WHERE id=?').get(target.id)).toEqual({
          status: 'active',
        });
        expectAuditUnchanged(database, beforeCancel);
        expect(
          database.prepare('SELECT * FROM platform_sessions ORDER BY token_hash').all(),
        ).toEqual(sessionsBeforeCancel);
        const held = Promise.withResolvers<undefined>();
        await page.route(
          statusUrl,
          async (route) => {
            expect(route.request().method()).toBe('PUT');
            expect(route.request().postDataJSON()).toEqual({ status: 'disabled' });
            held.resolve(undefined);
            await release.promise;
            await route.continue();
          },
          { times: 1 },
        );
        await employeeRow.getByRole('button', { name: '禁用', exact: true }).click();
        await page.getByRole('button', { name: '确认', exact: true }).click();
        await held.promise;
        await expect(page.getByRole('button', { name: '正在提交…' })).toBeDisabled();
        await expect(page.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
        await expect(page.getByLabel('搜索邮箱')).toBeDisabled();
        await expect(employeeRow.getByRole('button', { name: '重置密码' })).toBeDisabled();
        await submitPendingAccountForm(page, '确认账号操作');
        expect(actionRequests).toEqual([
          { url: listUrl, method: 'GET' },
          { url: statusUrl, method: 'PUT' },
        ]);
        await screenshot('admin-disable-pending');
        const disabledResponse = page.waitForResponse((response) => response.url() === statusUrl);
        const disabledList = page.waitForResponse((response) => response.url() === listUrl);
        release.resolve(undefined);
        expect((await disabledResponse).status()).toBe(204);
        expect((await disabledList).status()).toBe(200);
        await expect(employeeRow).toContainText('已禁用');
        expect(database.prepare('SELECT status FROM users WHERE id=?').get(target.id)).toEqual({
          status: 'disabled',
        });
        expect(
          database.prepare('SELECT user_id FROM platform_sessions WHERE user_id=?').all(target.id),
        ).toEqual([]);
        // These accounts never owned an instance; canonical retirement must not fabricate one or a stop audit.
        expect(database.prepare('SELECT * FROM instances').all()).toEqual([]);
        for (const cookie of oldCookies) {
          const rejected = await seed.get('/_platform/api/instance', {
            headers: { Cookie: cookie },
          });
          expect(rejected.status()).toBe(401);
        }
        const denied = await seed.post('/_platform/api/login', {
          data: { email: target.email, password: ADMIN_UI_PASSWORD },
        });
        expect(denied.status()).toBe(403);
        await screenshot('admin-disabled');

        await employeeRow.getByRole('button', { name: '启用', exact: true }).click();
        const enabledList = page.waitForResponse((response) => response.url() === listUrl);
        const [enabled] = await Promise.all([
          page.waitForResponse((response) => response.url() === statusUrl),
          page.getByRole('button', { name: '确认', exact: true }).click(),
        ]);
        expect(enabled.status()).toBe(204);
        expect(enabled.request().method()).toBe('PUT');
        expect(enabled.request().postDataJSON()).toEqual({ status: 'active' });
        expect((await enabledList).status()).toBe(200);
        await expect(employeeRow).toContainText('已启用');
        expect(database.prepare('SELECT status FROM users WHERE id=?').get(target.id)).toEqual({
          status: 'active',
        });
        const enabledLogin = await seed.post('/_platform/api/login', {
          data: { email: target.email, password: ADMIN_UI_PASSWORD },
        });
        expect(enabledLogin.status()).toBe(200);
        for (const cookie of oldCookies)
          expect(
            (await seed.get('/_platform/api/instance', { headers: { Cookie: cookie } })).status(),
          ).toBe(401);
        const resetCookie = (await seed.storageState()).cookies.find(
          (entry) => entry.name === 'platform_session',
        );
        if (resetCookie === undefined) throw new Error('Missing reset target session');
        await screenshot('admin-enabled');

        await employeeRow.getByRole('button', { name: '重置密码' }).click();
        await expect(page.getByLabel('新密码')).toHaveValue('');
        await page.getByLabel('新密码').fill('12345');
        const rejectedList = page.waitForResponse((response) => response.url() === listUrl);
        const [short] = await Promise.all([
          page.waitForResponse((response) => response.url() === passwordUrl),
          page.getByRole('button', { name: '确认', exact: true }).click(),
        ]);
        expect(short.status()).toBe(400);
        expect((await rejectedList).status()).toBe(200);
        await expect(page.getByRole('alert')).toContainText('6–256');
        await expect(employeeRow).toBeVisible();
        expect(
          (
            await seed.get('/_platform/api/instance', {
              headers: { Cookie: `platform_session=${resetCookie.value}` },
            })
          ).status(),
        ).toBe(200);
        await screenshot('admin-password-rejected');
        const replacement = ' browser-reset-中文-password ';
        await employeeRow.getByRole('button', { name: '重置密码' }).click();
        await expect(page.getByRole('dialog')).toContainText('全部会话将失效');
        await page.getByLabel('新密码').fill(replacement);
        await screenshot('admin-password-confirmation');
        const resetList = page.waitForResponse((response) => response.url() === listUrl);
        const [reset] = await Promise.all([
          page.waitForResponse((response) => response.url() === passwordUrl),
          page.getByRole('button', { name: '确认', exact: true }).click(),
        ]);
        expect(reset.status()).toBe(204);
        expect(reset.request().method()).toBe('PUT');
        expect(reset.request().postDataJSON()).toEqual({ newPassword: replacement });
        expect((await resetList).status()).toBe(200);
        await expect(employeeRow).toContainText('已启用');
        expect(
          database.prepare('SELECT user_id FROM platform_sessions WHERE user_id=?').all(target.id),
        ).toEqual([]);
        expect(
          (
            await seed.get('/_platform/api/instance', {
              headers: { Cookie: `platform_session=${resetCookie.value}` },
            })
          ).status(),
        ).toBe(401);
        const oldLogin = await seed.post('/_platform/api/login', {
          data: { email: target.email, password: ADMIN_UI_PASSWORD },
        });
        expect(oldLogin.status()).toBe(401);
        const newLogin = await seed.post('/_platform/api/login', {
          data: { email: target.email, password: replacement },
        });
        expect(newLogin.status()).toBe(200);
        expect(readPublicIdentity(await newLogin.json())).toEqual(target);
        expect(database.prepare('SELECT role,status FROM users WHERE id=?').get(target.id)).toEqual(
          { role: 'employee', status: 'active' },
        );
        expect(
          database
            .prepare('SELECT * FROM platform_sessions WHERE user_id=? ORDER BY token_hash')
            .all(admin.id),
        ).toEqual(adminSessions);
        const audits = database
          .prepare(
            "SELECT event_type,actor_email,target_email,target,details FROM audit_events WHERE event_type IN ('account.disabled','account.enabled','password.reset','instance.stopped') ORDER BY id",
          )
          .all();
        expect(audits).toEqual(
          ['account.disabled', 'account.enabled', 'password.reset'].map((eventType) => ({
            event_type: eventType,
            actor_email: admin.email,
            target_email: target.email,
            target: target.id,
            details: '{}',
          })),
        );
        expect(JSON.stringify(audits)).not.toContain(replacement);
        await employeeRow.getByRole('button', { name: '重置密码' }).click();
        await expect(page.getByLabel('新密码')).toHaveValue('');
        await page.getByRole('button', { name: '取消', exact: true }).click();
        await expectNoBrowserStorage(page);
        await expectNoScriptVisibleCookie(page);
        expect(page.url()).toBe(`${baseUrl}/_platform/admin`);
        await screenshot('admin-password-reset');
        expect(actionRequests.filter((entry) => entry.method === 'PUT')).toEqual([
          { url: statusUrl, method: 'PUT' },
          { url: statusUrl, method: 'PUT' },
          { url: passwordUrl, method: 'PUT' },
          { url: passwordUrl, method: 'PUT' },
        ]);
        expect(actionResponses.filter((entry) => entry.url !== listUrl)).toEqual([
          { url: statusUrl, status: 204 },
          { url: statusUrl, status: 204 },
          { url: passwordUrl, status: 400 },
          { url: passwordUrl, status: 204 },
        ]);
        expect(otherMutations).toEqual([]);
      });
      expectHealthy([{ url: passwordUrl, status: 400 }]);
    },
    { canonicalInstanceService: true },
  );
});

test('real self-disable rejection is truthful and server refresh preserves the administrator', async ({
  page,
  playwright,
}, testInfo) => {
  await withAdminUi(
    playwright,
    page,
    async ({ baseUrl, database, admin }) => {
      const listUrl = `${baseUrl}/_platform/api/admin/users?page=1&pageSize=20`;
      const statusUrl = `${baseUrl}/_platform/api/admin/users/${admin.id}/status`;
      const { actionResponses, screenshot, expectHealthy } = observeAccountUi(
        page,
        testInfo,
        baseUrl,
        [listUrl, statusUrl],
      );
      await page.goto(`${baseUrl}/_platform/admin`, { waitUntil: 'networkidle' });
      const before = database
        .prepare("SELECT * FROM audit_events WHERE event_type='account.disabled'")
        .all();
      await page
        .getByRole('row')
        .filter({ hasText: admin.email })
        .getByRole('button', { name: '禁用', exact: true })
        .click();

      const refreshed = page.waitForResponse((result) => result.url() === listUrl);
      const [response] = await Promise.all([
        page.waitForResponse((result) => result.url() === statusUrl),
        page.getByRole('button', { name: '确认', exact: true }).click(),
      ]);

      expect(response.status()).toBe(409);
      expect((await refreshed).status()).toBe(200);
      await expect(page.getByRole('alert')).toContainText('不能禁用自己');
      await expect(page.getByRole('row').filter({ hasText: admin.email })).toContainText('已启用');
      expect(database.prepare('SELECT status FROM users WHERE id=?').get(admin.id)).toEqual({
        status: 'active',
      });
      expect(
        database.prepare("SELECT * FROM audit_events WHERE event_type='account.disabled'").all(),
      ).toEqual(before);
      expect(actionResponses).toEqual([
        { url: listUrl, status: 200 },
        { url: statusUrl, status: 409 },
        { url: listUrl, status: 200 },
      ]);
      await screenshot('admin-self-disable-rejected');
      expectHealthy([{ url: statusUrl, status: 409 }]);
    },
    { canonicalInstanceService: true },
  );
});

test('current administrator demotion rejects a reachable reset confirmation and clears private state', async ({
  page,
  playwright,
}, testInfo) => {
  await withAdminUi(playwright, page, async ({ baseUrl, database, admin, target }) => {
    const listUrl = `${baseUrl}/_platform/api/admin/users?page=1&pageSize=20`;
    const passwordUrl = `${baseUrl}/_platform/api/admin/users/${target.id}/password`;
    const { actionRequests, actionResponses, screenshot, expectHealthy } = observeAccountUi(
      page,
      testInfo,
      baseUrl,
      [listUrl, passwordUrl],
    );
    await page.goto(`${baseUrl}/_platform/admin`, { waitUntil: 'networkidle' });
    await page
      .getByRole('row')
      .filter({ hasText: target.email })
      .getByRole('button', { name: '重置密码' })
      .click();
    await page.getByLabel('新密码').fill('cleared-on-demotion');
    const targetBefore = database
      .prepare('SELECT password_hash,role,status FROM users WHERE id=?')
      .get(target.id);
    const sessionsBefore = database
      .prepare('SELECT * FROM platform_sessions WHERE user_id=? ORDER BY token_hash')
      .all(target.id);
    const auditsBefore = readAuditSnapshot(database);
    database.prepare("UPDATE users SET role='employee' WHERE id=?").run(admin.id);

    const [denied] = await Promise.all([
      page.waitForResponse((response) => response.url() === passwordUrl),
      page.getByRole('button', { name: '确认', exact: true }).click(),
    ]);
    expect(denied.status()).toBe(403);

    await expect(page.getByRole('alert')).toHaveText('无权限');
    await expect(page.getByRole('table')).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByLabel('新密码')).toHaveCount(0);
    expect(actionRequests.filter((entry) => entry.method === 'PUT')).toEqual([
      { url: passwordUrl, method: 'PUT' },
    ]);
    expect(
      database.prepare('SELECT password_hash,role,status FROM users WHERE id=?').get(target.id),
    ).toEqual(targetBefore);
    expect(
      database
        .prepare('SELECT * FROM platform_sessions WHERE user_id=? ORDER BY token_hash')
        .all(target.id),
    ).toEqual(sessionsBefore);
    expectAuditUnchanged(database, auditsBefore);
    expect(actionResponses).toEqual([
      { url: listUrl, status: 200 },
      { url: passwordUrl, status: 403 },
    ]);
    await screenshot('admin-current-authority-lost');
    expectHealthy([{ url: passwordUrl, status: 403 }]);
  });
});
