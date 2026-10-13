import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { readSettings, writeSettings } from '../src/db/index.ts';
import {
  observeAccountUi,
  expectNoBrowserStorage,
  withAccountUiRouteCleanup,
} from './account-ui-fixture.ts';
import {
  withAdminUi,
  holdAdminList,
  failAdminList,
  expectPlatformLogin,
} from './admin-ui-fixture.ts';

const PAGE = '/_platform/admin/runtime';
const API = '/_platform/api/admin/runtime-config';

test('administrator saves all runtime fields with fractional CPU without receiving or modifying model configuration', async ({
  page,
  playwright,
}, testInfo) => {
  await withAdminUi(playwright, page, async ({ baseUrl, database }) => {
    const key = randomBytes(32).toString('hex');
    const models = {
      modelBaseUrl: 'http://owned.invalid/v1',
      modelApiKey: key,
      models: [{ name: 'owned-model' }],
      defaultModel: 'owned-model',
    };
    writeSettings(database, models);
    const api = `${baseUrl}${API}`;
    const observed = observeAccountUi(page, testInfo, baseUrl, api);
    const initial = page.waitForResponse(api);
    const entry = await page.goto(`${baseUrl}${PAGE}`);
    expect(entry?.status()).toBe(200);
    expect((await (await initial).text()).includes(key)).toBe(false);
    await page.getByLabel('空闲分钟数', { exact: true }).fill('15');
    await page.getByLabel('CPU 核数', { exact: true }).fill('0.125');
    await page.getByLabel('内存 MiB', { exact: true }).fill('1024');
    await page.getByLabel('同时运行上限', { exact: true }).fill('2');
    await page.getByLabel('默认权限档', { exact: true }).selectOption('auto');
    const saving = page.waitForResponse(
      (response) => response.url() === api && response.request().method() === 'PUT',
    );
    await page.getByRole('button', { name: '保存运行参数', exact: true }).click();
    const saved = await saving;
    expect(saved.status()).toBe(200);
    const body: unknown = await saved.json();
    expect(JSON.stringify(body).includes(key)).toBe(false);
    expect(body).toEqual({
      idleMinutes: 15,
      cpuCores: 0.125,
      memoryMiB: 1024,
      maxRunningInstances: 2,
      defaultPermissionTier: 'auto',
      runningInstances: 0,
    });
    const stored = readSettings(database);
    expect(stored.modelApiKey === key).toBe(true);
    expect(stored.modelBaseUrl).toBe(models.modelBaseUrl);
    expect(stored.models).toEqual(models.models);
    expect(stored.defaultModel).toBe(models.defaultModel);
    expect(stored).toMatchObject({ cpuCores: 0.125, maxRunningInstances: 2 });
    await expect(page.getByRole('status')).toContainText('已保存');
    await observed.screenshot('runtime-saved');
    await page.reload();
    await expect(page.getByLabel('CPU 核数', { exact: true })).toHaveValue('0.125');
    await expect(page.getByLabel('默认权限档', { exact: true })).toHaveValue('auto');
    await expect(page.getByLabel('空闲分钟数', { exact: true })).toHaveValue('15');
    await expect(page.getByLabel('内存 MiB', { exact: true })).toHaveValue('1024');
    await expect(page.getByLabel('同时运行上限', { exact: true })).toHaveValue('2');
    await observed.screenshot('runtime-reloaded');
    await expectNoBrowserStorage(page);
    expect(observed.otherMutations).toEqual([]);
    observed.expectHealthy([]);
  });
});

test('runtime native and local validation prevents writes and real subnet-capacity rejection permits correction', async ({
  page,
  playwright,
}, testInfo) => {
  await withAdminUi(playwright, page, async ({ baseUrl, database }) => {
    const api = `${baseUrl}${API}`;
    const observed = observeAccountUi(page, testInfo, baseUrl, api);
    await page.goto(`${baseUrl}${PAGE}`);
    await expect(page.getByLabel('同时运行上限', { exact: true })).toBeVisible();
    const before = readSettings(database);
    const audits = database.prepare('SELECT * FROM audit_events').all();
    for (const [label, value, restored, constraint] of [
      ['同时运行上限', '0', '60', 'rangeUnderflow'],
      ['内存 MiB', '1.5', '4096', 'stepMismatch'],
      ['CPU 核数', '', '2', 'valueMissing'],
    ] as const) {
      const control = page.getByLabel(label, { exact: true });
      await control.fill(value);
      await page.getByRole('button', { name: '保存运行参数', exact: true }).click();
      await expect(control).toBeFocused();
      const invalid = await control.evaluate((node, expected) => {
        // These exact labels resolve native numeric controls with browser validation state.
        const input = node as { validity: Record<string, boolean>; validationMessage: string };
        return {
          valid: input.validity.valid,
          violation: input.validity[expected],
          message: input.validationMessage,
        };
      }, constraint);
      expect(invalid).toMatchObject({ valid: false, violation: true });
      expect(invalid.message.trim() === '').toBe(false);
      expect(observed.actionRequests.filter((request) => request.method === 'PUT')).toEqual([]);
      expect(readSettings(database)).toEqual(before);
      expect(database.prepare('SELECT * FROM audit_events').all()).toEqual(audits);
      await observed.screenshot(`runtime-invalid-${constraint}`);
      await control.fill(restored);
    }
    await page.getByLabel('CPU 核数', { exact: true }).fill('0');
    await page.getByRole('button', { name: '保存运行参数', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('大于 0');
    expect(observed.actionRequests.filter((request) => request.method === 'PUT')).toEqual([]);
    await page.getByLabel('CPU 核数', { exact: true }).fill('0.000001');
    // The owned fixture uses the default /16 pool; the UI itself must not hardcode this capacity.
    await page.getByLabel('同时运行上限', { exact: true }).fill('4097');
    const rejected = page.waitForResponse(
      (response) => response.url() === api && response.status() === 400,
    );
    await page.getByRole('button', { name: '保存运行参数', exact: true }).click();
    expect((await rejected).status()).toBe(400);
    await expect(page.getByRole('alert')).toContainText('容量：4096');
    expect(readSettings(database)).toEqual(before);
    expect(database.prepare('SELECT * FROM audit_events').all()).toEqual(audits);
    await observed.screenshot('runtime-pool-capacity');
    await page.getByLabel('同时运行上限', { exact: true }).fill('2');
    await page.getByRole('button', { name: '保存运行参数', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('已保存');
    expect(readSettings(database)).toMatchObject({ maxRunningInstances: 2, cpuCores: 0.000001 });
    observed.expectHealthy([400]);
  });
});

for (const status of [401, 403]) {
  test(`runtime current authority rejection ${String(status)} hides values without modifying storage`, async ({
    page,
    playwright,
  }, testInfo) => {
    await withAdminUi(playwright, page, async ({ baseUrl, database, admin }) => {
      const api = `${baseUrl}${API}`;
      const observed = observeAccountUi(page, testInfo, baseUrl, api);
      await page.goto(`${baseUrl}${PAGE}`);
      await expect(page.getByLabel('CPU 核数', { exact: true })).toBeVisible();
      const before = readSettings(database);
      const audits = database.prepare('SELECT * FROM audit_events').all();
      if (status === 401)
        database.prepare('DELETE FROM platform_sessions WHERE user_id=?').run(admin.id);
      else database.prepare("UPDATE users SET role='employee' WHERE id=?").run(admin.id);
      const denied = page.waitForResponse(
        (response) => response.url() === api && response.status() === status,
      );
      await page.getByRole('button', { name: '保存运行参数', exact: true }).click();
      expect((await denied).status()).toBe(status);
      if (status === 401) await expectPlatformLogin(page, baseUrl);
      else await expect(page.getByRole('alert')).toHaveText('无权限');
      await expect(page.getByRole('form', { name: '运行参数' })).toHaveCount(0);
      expect(readSettings(database)).toEqual(before);
      expect(database.prepare('SELECT * FROM audit_events').all()).toEqual(audits);
      await expectNoBrowserStorage(page);
      await observed.screenshot(`runtime-denied-${String(status)}`);
      observed.expectHealthy([status]);
    });
  });
}

test('runtime loading and one controlled failure remain noneditable and retry reads the real API', async ({
  page,
  playwright,
}, testInfo) => {
  await withAdminUi(playwright, page, async ({ baseUrl }) => {
    const api = `${baseUrl}${API}`;
    const observed = observeAccountUi(page, testInfo, baseUrl, api);
    await withAccountUiRouteCleanup(page, async (release) => {
      const held = await holdAdminList(page, api, release.promise);
      await page.goto(`${baseUrl}${PAGE}`);
      await held.promise;
      await expect(page.getByRole('status')).toContainText('加载中');
      await expect(page.getByRole('form')).toHaveCount(0);
      await observed.screenshot('runtime-loading');
      release.resolve(undefined);
      await expect(page.getByLabel('CPU 核数', { exact: true })).toBeVisible();
    });
    await withAccountUiRouteCleanup(page, async () => {
      await failAdminList(page, api, 'private-runtime-diagnostic');
      await page.reload({ waitUntil: 'networkidle' });
      await expect(page.getByRole('alert')).toContainText('加载失败');
      await expect(page.getByRole('form')).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText('private-runtime-diagnostic');
      await observed.screenshot('runtime-failed');
      await page.getByRole('button', { name: '重试', exact: true }).click();
      await expect(page.getByLabel('CPU 核数', { exact: true })).toBeVisible();
    });
    expect(observed.actionRequests.every((request) => request.method === 'GET')).toBe(true);
    observed.expectHealthy([500]);
  });
});
