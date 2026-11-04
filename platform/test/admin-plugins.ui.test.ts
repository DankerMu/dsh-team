import { readFile } from 'node:fs/promises';
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

const PAGE = '/_platform/admin/plugins';
const HINT = '修改在每个实例下次启动时生效；保存不会重启正在运行的实例。';
const DEFAULT_REGISTRIES = ['https://registry.npmjs.org/', 'https://registry.npmmirror.com/'];
const LOCKED = '强制开（必启，不可修改）';
const COUNT = '保存时运行中的实例数：0（非实时统计）。';
const FORMS = ['预装插件', '插件安装源', '联网工具'] as const;

interface ImageCatalogEntry {
  id: string;
  package: string;
  name: string;
  category: 'required' | 'manageable';
  imageDefaultEnabled: boolean;
}
async function readImageCatalog(): Promise<ImageCatalogEntry[]> {
  // The shipped image file is the independent source of truth for the displayed rows.
  const file = new URL('../../images/dsh-user/catalog.json', import.meta.url);
  const parsed = JSON.parse(await readFile(file, 'utf8')) as { entries: ImageCatalogEntry[] };
  return parsed.entries;
}
/** The test switches only 办公 Agent: required entries stay forced on, other manageable ones employee. */
function savedState(item: ImageCatalogEntry): string {
  if (item.category === 'required') return 'forced-on';
  return item.id === 'office-agents' ? 'forced-off' : 'employee';
}
function urls(baseUrl: string) {
  return {
    catalog: `${baseUrl}/_platform/api/admin/plugin-catalog`,
    sources: `${baseUrl}/_platform/api/admin/plugin-sources`,
    web: `${baseUrl}/_platform/api/admin/web-tools`,
  };
}
function observePlugins(
  page: Page,
  testInfo: Parameters<typeof observeAccountUi>[1],
  baseUrl: string,
) {
  const api = urls(baseUrl);
  return { api, ...observeAccountUi(page, testInfo, baseUrl, [api.catalog, api.sources, api.web]) };
}
function auditCount(database: DatabaseHandle, type: string): number {
  return database.prepare('SELECT * FROM audit_events WHERE event_type=?').all(type).length;
}
function form(page: Page, name: string) {
  return page.getByRole('form', { name, exact: true });
}
function registries(page: Page) {
  return page.getByLabel('安装源地址（每行一个，第一行为主安装源）', { exact: true });
}
async function save(page: Page, url: string, label: string) {
  const response = page.waitForResponse(
    (candidate) => candidate.url() === url && candidate.request().method() === 'PUT',
  );
  await page.getByRole('button', { name: label, exact: true }).click();
  return response;
}
/** Counts persist per saved section, so only the forms not yet saved must lack the line. */
async function expectCountUnder(page: Page, saved: readonly string[]): Promise<void> {
  // The awaited positive assertions retry until React commits; only then check absence.
  for (const name of saved) await expect(form(page, name)).toContainText(COUNT);
  for (const name of FORMS)
    if (!saved.includes(name))
      await expect(form(page, name)).not.toContainText('保存时运行中的实例数');
}
async function expectNoConfiguration(page: Page): Promise<void> {
  await expect(page.getByRole('form')).toHaveCount(0);
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('registry.npmjs.org');
  await expect(page.locator('body')).not.toContainText(HINT);
}

test('administrator sees the image catalog and saves each section through the real APIs', async ({
  page,
  playwright,
}, testInfo) => {
  const catalog = await readImageCatalog();
  await withAdminUi(playwright, page, async ({ baseUrl, database }) => {
    const observed = observePlugins(page, testInfo, baseUrl);
    const { api } = observed;
    const entry = await page.goto(`${baseUrl}${PAGE}`);
    expect(entry?.status()).toBe(200);
    await expect(page.getByText(HINT, { exact: true })).toBeVisible();
    const rows = form(page, '预装插件').locator('tbody tr');
    await expect(rows).toHaveCount(catalog.length);
    expect(catalog.length).toBe(5);
    for (const [index, item] of catalog.entries()) {
      const cells = rows.nth(index).locator('td');
      await expect(cells.nth(0)).toHaveText(item.name);
      await expect(cells.nth(1)).toHaveText(item.package);
      await expect(cells.nth(2)).toHaveText(item.imageDefaultEnabled ? '默认开启' : '默认关闭');
      if (item.category === 'required') {
        await expect(cells.nth(3)).toHaveText(LOCKED);
        await expect(cells.nth(3).locator('select')).toHaveCount(0);
      } else
        await expect(page.getByLabel(`${item.name} 的管理状态`, { exact: true })).toHaveValue(
          'employee',
        );
    }
    await expect(registries(page)).toHaveValue(DEFAULT_REGISTRIES.join('\n'));
    await expect(page.getByLabel('开启仓库探测', { exact: true })).toBeChecked();
    await expect(page.getByLabel('允许联网搜索与抓取工具', { exact: true })).not.toBeChecked();
    await observed.screenshot('plugins-ready');
    await expectViewportLayout(page, observed.screenshot, 'glass-admin-plugins', async () => {
      await expect(form(page, '预装插件')).toBeVisible();
      await expect(form(page, '联网工具')).toBeVisible();
    });

    await page.getByLabel('办公 Agent 的管理状态', { exact: true }).selectOption('forced-off');
    const savedCatalog = await save(page, api.catalog, '保存插件目录');
    expect(savedCatalog.status()).toBe(200);
    expect(await savedCatalog.json()).toEqual({
      entries: catalog.map((item) => ({ ...item, state: savedState(item) })),
      runningInstances: 0,
    });
    expect(savedCatalog.request().postDataJSON()).toEqual({
      entries: catalog.map((item) => ({ id: item.id, state: savedState(item) })),
    });
    expect(readSettings(database).pluginCatalog).toEqual({
      'knowledge-base': 'employee',
      'office-agents': 'forced-off',
    });
    expect(auditCount(database, 'plugin-catalog.updated')).toBe(1);
    await expectCountUnder(page, ['预装插件']);

    await registries(page).fill('http://mirror.intranet.invalid/');
    await page.getByLabel('开启仓库探测', { exact: true }).uncheck();
    const savedSources = await save(page, api.sources, '保存安装源');
    expect(savedSources.status()).toBe(200);
    expect(await savedSources.json()).toEqual({
      pluginRegistries: ['http://mirror.intranet.invalid/'],
      registryProbeEnabled: false,
      runningInstances: 0,
    });
    expect(readSettings(database)).toMatchObject({
      pluginRegistries: ['http://mirror.intranet.invalid/'],
      registryProbeEnabled: false,
    });
    expect(auditCount(database, 'plugin-sources.updated')).toBe(1);
    await expectCountUnder(page, ['插件安装源', '预装插件']);

    await page.getByLabel('允许联网搜索与抓取工具', { exact: true }).check();
    const savedWeb = await save(page, api.web, '保存联网工具设置');
    expect(savedWeb.status()).toBe(200);
    expect(await savedWeb.json()).toEqual({ webToolsEnabled: true, runningInstances: 0 });
    expect(readSettings(database).webToolsEnabled).toBe(true);
    expect(auditCount(database, 'web-tools.updated')).toBe(1);
    await expectCountUnder(page, ['联网工具', '预装插件', '插件安装源']);
    await expect(page.getByText(HINT, { exact: true })).toBeVisible();
    await observed.screenshot('plugins-saved');

    await page.reload();
    await expect(page.getByLabel('办公 Agent 的管理状态', { exact: true })).toHaveValue(
      'forced-off',
    );
    await expect(registries(page)).toHaveValue('http://mirror.intranet.invalid/');
    await expect(page.getByLabel('开启仓库探测', { exact: true })).not.toBeChecked();
    await expect(page.getByLabel('允许联网搜索与抓取工具', { exact: true })).toBeChecked();
    await observed.screenshot('plugins-reloaded');
    await expectNoBrowserStorage(page);
    expect(observed.otherMutations).toEqual([]);
    observed.expectHealthy([]);
  });
});

test('a rejected registry line leaves settings and audits unchanged', async ({
  page,
  playwright,
}, testInfo) => {
  await withAdminUi(playwright, page, async ({ baseUrl, database }) => {
    const observed = observePlugins(page, testInfo, baseUrl);
    await page.goto(`${baseUrl}${PAGE}`);
    await expect(registries(page)).toBeVisible();
    const before = readSettings(database);
    const audits = readAuditSnapshot(database);
    await registries(page).fill('https://registry.npmjs.org/\nftp://mirror.invalid/');
    const rejected = await save(page, observed.api.sources, '保存安装源');
    expect(rejected.status()).toBe(400);
    await expect(form(page, '插件安装源').getByRole('alert')).toHaveText(
      '第 2 行的安装源地址无效：须以 http:// 或 https:// 开头且不含空白。',
    );
    await expect(page.getByRole('alert')).toHaveCount(1);
    await expect(form(page, '预装插件').getByRole('alert')).toHaveCount(0);
    await expect(form(page, '联网工具').getByRole('alert')).toHaveCount(0);
    await expect(registries(page)).toHaveValue(
      'https://registry.npmjs.org/\nftp://mirror.invalid/',
    );
    expect(readSettings(database)).toEqual(before);
    expectAuditUnchanged(database, audits);
    await observed.screenshot('plugins-invalid-registry');
    observed.expectHealthy([{ url: observed.api.sources, status: 400 }]);
  });
});

test('one pending real save fences the other save buttons', async ({
  page,
  playwright,
}, testInfo) => {
  await withAdminUi(playwright, page, async ({ baseUrl, database }) => {
    const observed = observePlugins(page, testInfo, baseUrl);
    await page.goto(`${baseUrl}${PAGE}`);
    await expect(registries(page)).toBeVisible();
    await withAccountUiRouteCleanup(page, async (release) => {
      // Installed after the reads settled, so only the PUT can reach this route.
      const held = await holdAdminList(page, observed.api.sources, release.promise, 'PUT');
      await page.getByLabel('开启仓库探测', { exact: true }).uncheck();
      await page.getByRole('button', { name: '保存安装源', exact: true }).click();
      await held.promise;
      for (const label of ['保存插件目录', '保存安装源', '保存联网工具设置'])
        await expect(page.getByRole('button', { name: label, exact: true })).toBeDisabled();
      await expect(page.getByRole('status')).toHaveText('正在保存…');
      await observed.screenshot('plugins-saving');
      release.resolve(undefined);
      await expect(form(page, '插件安装源')).toContainText(COUNT);
    });
    for (const label of ['保存插件目录', '保存安装源', '保存联网工具设置'])
      await expect(page.getByRole('button', { name: label, exact: true })).toBeEnabled();
    expect(readSettings(database).registryProbeEnabled).toBe(false);
    expect(observed.actionRequests.filter((request) => request.method === 'PUT')).toEqual([
      { url: observed.api.sources, method: 'PUT' },
    ]);
    observed.expectHealthy([]);
  });
});

test('loading holds a real read and one controlled failure retries the real APIs', async ({
  page,
  playwright,
}, testInfo) => {
  await withAdminUi(playwright, page, async ({ baseUrl }) => {
    const observed = observePlugins(page, testInfo, baseUrl);
    await withAccountUiRouteCleanup(page, async (release) => {
      const held = await holdAdminList(page, observed.api.catalog, release.promise);
      await page.goto(`${baseUrl}${PAGE}`);
      await held.promise;
      await expect(page.getByRole('status')).toHaveText('加载中…');
      await expectNoConfiguration(page);
      await observed.screenshot('plugins-loading');
      release.resolve(undefined);
      await expect(registries(page)).toBeVisible();
    });
    await withAccountUiRouteCleanup(page, async () => {
      await failAdminList(page, observed.api.web, 'private-plugins-diagnostic');
      await page.reload({ waitUntil: 'networkidle' });
      await expect(page.getByRole('alert')).toHaveText('插件目录加载失败，请重试。');
      await expectNoConfiguration(page);
      await expect(page.locator('body')).not.toContainText('private-plugins-diagnostic');
      await observed.screenshot('plugins-failed');
      await page.getByRole('button', { name: '重试', exact: true }).click();
      await expect(registries(page)).toBeVisible();
    });
    expect(observed.actionRequests.every((request) => request.method === 'GET')).toBe(true);
    observed.expectHealthy([{ url: observed.api.web, status: 500 }]);
  });
});

for (const status of [401, 403]) {
  test(`entry authority rejection ${String(status)} shows no configuration`, async ({
    page,
    playwright,
  }, testInfo) => {
    await withAdminUi(playwright, page, async ({ baseUrl, target }) => {
      const observed = observePlugins(page, testInfo, baseUrl);
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
      await observed.screenshot(`plugins-entry-${String(status)}`);
      const rejections = Object.values(observed.api).map((url) => ({ url, status }));
      expect(observed.actionResponses).toEqual(expect.arrayContaining(rejections));
      expect(observed.actionResponses).toHaveLength(3);
      expect(observed.otherMutations).toEqual([]);
      await expectNoBrowserStorage(page);
      observed.expectHealthy(rejections);
    });
  });

  test(`save authority rejection ${String(status)} hides configuration without modifying storage`, async ({
    page,
    playwright,
  }, testInfo) => {
    await withAdminUi(playwright, page, async ({ baseUrl, database, admin }) => {
      const observed = observePlugins(page, testInfo, baseUrl);
      await page.goto(`${baseUrl}${PAGE}`);
      await expect(registries(page)).toBeVisible();
      const before = readSettings(database);
      const audits = readAuditSnapshot(database);
      if (status === 401)
        database.prepare('DELETE FROM platform_sessions WHERE user_id=?').run(admin.id);
      else database.prepare("UPDATE users SET role='employee' WHERE id=?").run(admin.id);
      await page.getByLabel('允许联网搜索与抓取工具', { exact: true }).check();
      const denied = await save(page, observed.api.web, '保存联网工具设置');
      expect(denied.status()).toBe(status);
      if (status === 401) await expectPlatformLogin(page, baseUrl);
      else {
        await expect(page.getByRole('alert')).toHaveText('无权限');
        await expectNoConfiguration(page);
      }
      expect(readSettings(database)).toEqual(before);
      expectAuditUnchanged(database, audits);
      await expectNoBrowserStorage(page);
      await observed.screenshot(`plugins-denied-${String(status)}`);
      observed.expectHealthy([{ url: observed.api.web, status }]);
    });
  });
}

test('the audit filter names the three plugin configuration events', async ({
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
    expect(options).toEqual(
      expect.arrayContaining(['修改插件目录', '修改插件安装源', '修改联网工具开关']),
    );
    expect(observed.otherMutations).toEqual([]);
    observed.expectHealthy([]);
  });
});
