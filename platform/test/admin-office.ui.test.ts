import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { readSettings, type DatabaseHandle } from '../src/db/index.ts';
import {
  expectNoBrowserStorage,
  expectViewportLayout,
  observeAccountUi,
  withAccountUiRouteCleanup,
} from './account-ui-fixture.ts';
import {
  ADMIN_UI_PASSWORD,
  expectAuditUnchanged,
  expectPlatformLogin,
  failAdminList,
  holdAdminList,
  observeAuditUi,
  readAuditSnapshot,
  withAdminUi,
} from './admin-ui-fixture.ts';

const PAGE = '/_platform/admin/office';
const HINT = '修改在每个实例下次启动时生效；保存不会重启正在运行的实例。';
const SAVED = '已保存，实例下次启动时生效。';
const BUNDLED = '当前使用：自带 Document Server';
const EXTERNAL = '当前使用：外部 Document Server';
const UNAVAILABLE = '自带 Document Server：未配置，Office 不可用';
const FIRST_SWITCH = '首次切换到外部 Document Server 时必须填写 JWT。';
const ADDRESS_INVALID =
  'Document Server 地址无效：须以 http:// 或 https:// 开头，不含空白、?、#、@ 或 \\，最长 2048 个字符。';
const LOAD_FAILED = 'Office 配置加载失败，请重试。';
const RESET_NOTE = '切回自带会清除已保存的外部地址和 JWT。';
const FIRST_URL = 'https://office.intranet.invalid';
const SECOND_URL = 'https://office2.intranet.invalid';
const AUDIT = 'document-server-config.updated';
const BUNDLED_CONTAINER = 'dsh-team-office-ui';
const BUNDLED_JWT = 'office-ui-bundled-jwt-marker';

function observeOffice(page: Page, testInfo: Parameters<typeof observeAccountUi>[1], base: string) {
  const api = `${base}/_platform/api/admin/document-server`;
  return { api, ...observeAccountUi(page, testInfo, base, [api]) };
}
function auditCount(database: DatabaseHandle): number {
  return database.prepare('SELECT * FROM audit_events WHERE event_type=?').all(AUDIT).length;
}
function field(page: Page, label: string) {
  return page.getByLabel(label, { exact: true });
}
function statusLine(page: Page) {
  return page.locator('#office-status');
}
function region(page: Page) {
  return page.getByRole('region', { name: '当前 Office 配置', exact: true });
}
async function press(page: Page, url: string, label: string) {
  const response = page.waitForResponse(
    (candidate) => candidate.url() === url && candidate.request().method() === 'PUT',
  );
  await page.getByRole('button', { name: label, exact: true }).click();
  return response;
}
async function expectAbsent(page: Page, ...markers: string[]): Promise<void> {
  const html = await page.content();
  for (const marker of markers) {
    expect(html.includes(marker)).toBe(false);
    expect(page.url().includes(marker)).toBe(false);
  }
  await expectNoBrowserStorage(page);
}
async function expectNoConfiguration(page: Page): Promise<void> {
  await expect(page.locator('form')).toHaveCount(0);
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByRole('region')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(HINT);
  await expect(page.locator('body')).not.toContainText('当前使用');
  await expect(page.locator('body')).not.toContainText('已配置');
}

test('administrator switches to an external Document Server and back through the real API', async ({
  page,
  playwright,
}, testInfo) => {
  const jwt = `owned-office-jwt-${randomBytes(12).toString('hex')}`;
  await withAdminUi(playwright, page, async ({ baseUrl, database }) => {
    const observed = observeOffice(page, testInfo, baseUrl);
    const { api } = observed;
    const entry = await page.goto(`${baseUrl}${PAGE}`);
    expect(entry?.status()).toBe(200);
    await expect(page.getByText(HINT, { exact: true })).toBeVisible();
    await expect(region(page)).toContainText(BUNDLED);
    await expect(page.getByText(UNAVAILABLE, { exact: true })).toBeVisible();
    await expect(page.getByText(UNAVAILABLE, { exact: true })).toHaveRole('alert');
    await expect(field(page, 'Document Server 地址')).toHaveValue('');
    await expect(page.locator('#office-jwt-state')).toHaveText('未配置');
    await observed.screenshot('admin-office-bundled-unconfigured');

    await field(page, 'Document Server 地址').fill(FIRST_URL);
    await page.getByRole('button', { name: '切换到外部', exact: true }).click();
    await expect(statusLine(page)).toHaveText(FIRST_SWITCH);
    expect(observed.actionRequests.filter((request) => request.method === 'PUT')).toEqual([]);

    await field(page, 'JWT').fill(jwt);
    const switched = await press(page, api, '切换到外部');
    expect(switched.status()).toBe(200);
    expect(switched.request().postDataJSON()).toEqual({
      mode: 'external',
      url: FIRST_URL,
      jwtSecret: jwt,
    });
    expect(readSettings(database)).toMatchObject({
      documentServerUrl: FIRST_URL,
      documentServerJwtSecret: jwt,
    });
    expect(auditCount(database)).toBe(1);
    await expect(statusLine(page)).toHaveText(SAVED);
    await expect(page.getByText(/^保存时运行中的实例数：0（非实时统计）。$/u)).toBeVisible();
    await expect(region(page)).toContainText(EXTERNAL);
    await expect(region(page)).toContainText(FIRST_URL);
    await expect(region(page)).toContainText('JWT：已配置');
    await expect(field(page, 'JWT')).toHaveValue('');
    await expect(page.getByText(RESET_NOTE, { exact: true })).toBeVisible();
    await observed.screenshot('admin-office-external-saved');
    await expectAbsent(page, jwt);

    await field(page, 'Document Server 地址').fill(SECOND_URL);
    const addressOnly = await press(page, api, '保存外部配置');
    expect(addressOnly.status()).toBe(200);
    expect(addressOnly.request().postData()).toBe(
      JSON.stringify({ mode: 'external', url: SECOND_URL }),
    );
    expect(readSettings(database)).toMatchObject({
      documentServerUrl: SECOND_URL,
      documentServerJwtSecret: jwt,
    });
    expect(auditCount(database)).toBe(2);
    await expect(region(page)).toContainText(SECOND_URL);

    const settings = readSettings(database);
    const audits = readAuditSnapshot(database);
    await field(page, 'Document Server 地址').fill('https://office.invalid/?x');
    const invalid = await press(page, api, '保存外部配置');
    expect(invalid.status()).toBe(400);
    await expect(statusLine(page)).toHaveText(ADDRESS_INVALID);
    await observed.screenshot('admin-office-address-invalid');
    expect(readSettings(database)).toEqual(settings);
    expectAuditUnchanged(database, audits);

    await page.reload();
    await expect(region(page)).toContainText(EXTERNAL);
    await expect(region(page)).toContainText(SECOND_URL);
    await expect(field(page, 'Document Server 地址')).toHaveValue(SECOND_URL);
    await expect(page.locator('#office-jwt-state')).toHaveText('已配置');
    await expect(field(page, 'JWT')).toHaveValue('');
    await expectViewportLayout(page, observed.screenshot, 'glass-admin-office', async () => {
      await expect(page.getByRole('form', { name: '外部 Document Server' })).toBeVisible();
      await expect(region(page)).toBeVisible();
    });
    await expectAbsent(page, jwt);

    const reset = await press(page, api, '切回自带');
    expect(reset.status()).toBe(200);
    expect(reset.request().postData()).toBe(JSON.stringify({ mode: 'bundled' }));
    expect(readSettings(database)).toMatchObject({
      documentServerUrl: '',
      documentServerJwtSecret: '',
    });
    expect(auditCount(database)).toBe(3);
    await expect(region(page)).toContainText(BUNDLED);
    await expect(page.getByText(UNAVAILABLE, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '切回自带', exact: true })).toHaveCount(0);
    await expect(field(page, 'Document Server 地址')).toHaveValue('');
    await observed.screenshot('admin-office-bundled-restored');
    await expectAbsent(page, jwt);
    expect(observed.otherMutations).toEqual([]);
    observed.expectHealthy([{ url: api, status: 400 }]);
  });
});

test('a configured bundled server is shown without its container name or JWT', async ({
  page,
  playwright,
}, testInfo) => {
  await withAdminUi(
    playwright,
    page,
    async ({ baseUrl }) => {
      const observed = observeOffice(page, testInfo, baseUrl);
      const read = page.waitForResponse(
        (candidate) => candidate.url() === observed.api && candidate.request().method() === 'GET',
      );
      await page.goto(`${baseUrl}${PAGE}`);
      const answer = await read;
      expect(answer.status()).toBe(200);
      const body = await answer.text();
      expect(JSON.parse(body)).toEqual({
        mode: 'bundled',
        bundledConfigured: true,
        url: '',
        jwtConfigured: false,
      });
      await expect(page.getByText('自带 Document Server：已配置', { exact: true })).toBeVisible();
      await expect(page.locator('body')).not.toContainText('Office 不可用');
      await observed.screenshot('admin-office-bundled-configured');
      for (const marker of [BUNDLED_CONTAINER, BUNDLED_JWT])
        expect(body.includes(marker)).toBe(false);
      await expectAbsent(page, BUNDLED_CONTAINER, BUNDLED_JWT);
      expect(observed.otherMutations).toEqual([]);
      observed.expectHealthy([]);
    },
    { documentServer: { containerName: BUNDLED_CONTAINER, jwtSecret: BUNDLED_JWT } },
  );
});

test('loading holds a real read and one controlled failure retries the real API', async ({
  page,
  playwright,
}, testInfo) => {
  await withAdminUi(playwright, page, async ({ baseUrl }) => {
    const observed = observeOffice(page, testInfo, baseUrl);
    await withAccountUiRouteCleanup(page, async (release) => {
      const held = await holdAdminList(page, observed.api, release.promise);
      const entry = await page.goto(`${baseUrl}${PAGE}`, { waitUntil: 'domcontentloaded' });
      expect(entry?.status()).toBe(200);
      await held.promise;
      await expect(statusLine(page)).toHaveText('加载中…');
      await expect(page.locator('form')).toHaveCount(0);
      await observed.screenshot('admin-office-loading');
      release.resolve(undefined);
      await expect(page.getByRole('form', { name: '外部 Document Server' })).toBeVisible();
    });
    await withAccountUiRouteCleanup(page, async () => {
      await failAdminList(page, observed.api, 'private-office-diagnostic');
      await page.reload({ waitUntil: 'networkidle' });
      await expect(page.getByRole('alert')).toHaveText(LOAD_FAILED);
      await expectNoConfiguration(page);
      await expect(page.locator('body')).not.toContainText('private-office-diagnostic');
      await observed.screenshot('admin-office-failed');
      await page.getByRole('button', { name: '重试', exact: true }).click();
      await expect(page.getByRole('form', { name: '外部 Document Server' })).toBeVisible();
    });
    await expectNoBrowserStorage(page);
    expect(observed.actionRequests.every((request) => request.method === 'GET')).toBe(true);
    observed.expectHealthy([{ url: observed.api, status: 500 }]);
  });
});

for (const status of [401, 403]) {
  test(`entry authority rejection ${String(status)} shows no configuration`, async ({
    page,
    playwright,
  }, testInfo) => {
    await withAdminUi(playwright, page, async ({ baseUrl, target }) => {
      const observed = observeOffice(page, testInfo, baseUrl);
      const context = page.context().request;
      if (status === 401) {
        const logout = await context.post(`${baseUrl}/_platform/api/logout`, {
          headers: { Origin: baseUrl },
          data: {},
        });
        expect(logout.status()).toBe(204);
      } else {
        const login = await context.post(`${baseUrl}/_platform/api/login`, {
          headers: { Origin: baseUrl },
          data: { email: target.email, password: ADMIN_UI_PASSWORD },
        });
        expect(login.status()).toBe(200);
      }
      const entry = await page.goto(`${baseUrl}${PAGE}`, { waitUntil: 'networkidle' });
      expect(entry?.status()).toBe(200);
      if (status === 401) await expectPlatformLogin(page, baseUrl);
      else {
        await expect(page.getByRole('alert')).toHaveText('无权限');
        await expectNoConfiguration(page);
        await expect(page.getByRole('button')).toHaveCount(0);
      }
      await observed.screenshot(`admin-office-entry-${String(status)}`);
      expect(observed.actionResponses).toEqual([{ url: observed.api, status }]);
      expect(observed.otherMutations).toEqual([]);
      await expectNoBrowserStorage(page);
      observed.expectHealthy([{ url: observed.api, status }]);
    });
  });

  test(`save authority rejection ${String(status)} hides configuration without modifying storage`, async ({
    page,
    playwright,
  }, testInfo) => {
    const jwt = `owned-office-jwt-${randomBytes(12).toString('hex')}`;
    await withAdminUi(playwright, page, async ({ baseUrl, database, admin }) => {
      const observed = observeOffice(page, testInfo, baseUrl);
      await page.goto(`${baseUrl}${PAGE}`);
      await expect(page.getByRole('form', { name: '外部 Document Server' })).toBeVisible();
      await field(page, 'Document Server 地址').fill(FIRST_URL);
      await field(page, 'JWT').fill(jwt);
      const before = readSettings(database);
      const audits = readAuditSnapshot(database);
      if (status === 401)
        database.prepare('DELETE FROM platform_sessions WHERE user_id=?').run(admin.id);
      else database.prepare("UPDATE users SET role='employee' WHERE id=?").run(admin.id);

      const denied = await press(page, observed.api, '切换到外部');

      expect(denied.status()).toBe(status);
      if (status === 401) await expectPlatformLogin(page, baseUrl);
      else {
        await expect(page.getByRole('alert')).toHaveText('无权限');
        await expectNoConfiguration(page);
      }
      expect(readSettings(database)).toEqual(before);
      expectAuditUnchanged(database, audits);
      await expectAbsent(page, jwt);
      await observed.screenshot(`admin-office-denied-${String(status)}`);
      expect(observed.otherMutations).toEqual([]);
      observed.expectHealthy([{ url: observed.api, status }]);
    });
  });
}

test('the audit filter names the Office configuration event', async ({
  page,
  playwright,
}, testInfo) => {
  await withAdminUi(playwright, page, async ({ baseUrl }) => {
    const observed = observeAuditUi(page, testInfo, baseUrl);
    await page.goto(`${baseUrl}/_platform/admin/audit`, { waitUntil: 'networkidle' });
    const options = await page
      .getByLabel('事件类型', { exact: true })
      .locator('option')
      .allTextContents();
    expect(options).toContain('修改 Office 配置');
    expect(observed.otherMutations).toEqual([]);
    observed.expectHealthy([]);
  });
});
