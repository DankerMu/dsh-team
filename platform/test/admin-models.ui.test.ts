import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { readSettings } from '../src/db/index.ts';
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

const PAGE = '/_platform/admin/models';
const API = '/_platform/api/admin/model-config';
const RESTART = '/_platform/api/admin/instances/restart-running';

test('administrator saves models without receiving the key and explicitly confirms the real restart endpoint', async ({
  page,
  playwright,
}, testInfo) => {
  await withAdminUi(playwright, page, async ({ baseUrl, database, target }) => {
    const api = `${baseUrl}${API}`;
    const restart = `${baseUrl}${RESTART}`;
    const observed = observeAccountUi(page, testInfo, baseUrl, [api, restart]);
    const secret = randomBytes(32).toString('hex');
    const entry = await page.goto(`${baseUrl}${PAGE}`);
    expect(entry?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: '模型配置' })).toBeVisible();
    await page.getByLabel('模型地址', { exact: true }).fill('http://models.invalid/v1');
    await page.getByLabel('密钥', { exact: true }).fill(secret);
    await page.getByLabel('模型名称 1', { exact: true }).fill('alpha');
    await page.getByLabel('上下文窗口 1', { exact: true }).fill('500000');
    await page.getByRole('button', { name: '添加模型', exact: true }).click();
    await page.getByLabel('模型名称 2', { exact: true }).fill('beta');
    await page.getByLabel('默认模型', { exact: true }).selectOption('beta');
    const saved = page.waitForResponse(
      (response) => response.url() === api && response.request().method() === 'PUT',
    );

    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    const response = await saved;
    expect(response.status()).toBe(200);
    const received: unknown = await response.json();
    expect(JSON.stringify(received).includes(secret)).toBe(false);
    expect(received).toEqual({
      baseURL: 'http://models.invalid/v1',
      apiKeyConfigured: true,
      models: [{ name: 'alpha', contextWindow: 500000 }, { name: 'beta' }],
      defaultModel: 'beta',
      runningInstances: 0,
    });
    await expect(page.getByLabel('密钥', { exact: true })).toHaveValue('');
    await expect(page.getByText('已设置', { exact: true })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('下次启动实例时生效');
    expect(readSettings(database).modelApiKey === secret).toBe(true);
    await observed.screenshot('models-saved');

    const reloaded = page.waitForResponse(
      (response) => response.url() === api && response.request().method() === 'GET',
    );
    await page.reload();
    const reread: unknown = await (await reloaded).json();
    expect(JSON.stringify(reread).includes(secret)).toBe(false);
    await expect(page.getByLabel('默认模型', { exact: true })).toHaveValue('beta');
    await expect(page.getByLabel('密钥', { exact: true })).toHaveValue('');
    await page.getByLabel('模型地址', { exact: true }).fill('http://changed.invalid/v1');
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('下次启动实例时生效');
    expect(readSettings(database).modelApiKey === secret).toBe(true);
    expect(readSettings(database).modelBaseUrl).toBe('http://changed.invalid/v1');
    await page.getByRole('button', { name: '重启全部运行中的实例', exact: true }).click();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    expect(observed.actionRequests.filter((request) => request.url === restart)).toEqual([]);
    await page.getByRole('button', { name: '重启全部运行中的实例', exact: true }).click();
    const restarted = page.waitForResponse(restart);
    await page.getByRole('button', { name: '确认重启', exact: true }).click();
    const receipt = await restarted;
    expect(receipt.status()).toBe(200);
    expect(await receipt.json()).toEqual({ items: [] });
    await expect(page.getByRole('status')).toContainText('没有运行中的实例');
    expect(observed.actionRequests.filter((request) => request.url === restart)).toHaveLength(1);
    await expectNoBrowserStorage(page);
    await observed.screenshot('models-restart-empty');
    // Persisted running-state setup, not a claim that a Docker container exists.
    database.prepare("INSERT INTO instances(user_id,status) VALUES (?, 'running')").run(target.id);
    await page.getByRole('button', { name: '重启全部运行中的实例', exact: true }).click();
    const unavailable = page.waitForResponse(restart);
    await page.getByRole('button', { name: '确认重启', exact: true }).click();
    expect((await unavailable).status()).toBe(503);
    await expect(page.getByRole('alert')).toContainText('部分实例可能已处理');
    expect(database.prepare('SELECT status FROM instances WHERE user_id=?').get(target.id)).toEqual(
      { status: 'running' },
    );
    expect(
      database.prepare("SELECT * FROM audit_events WHERE event_type='instance.restarted'").all(),
    ).toEqual([]);
    expect(observed.actionRequests.filter((request) => request.url === restart)).toHaveLength(2);
    await observed.screenshot('models-restart-unavailable');
    observed.expectHealthy([{ url: restart, status: 503 }]);
  });
});

for (const status of [401, 403]) {
  test(`current model save denial ${String(status)} clears the editor without changing settings`, async ({
    page,
    playwright,
  }, testInfo) => {
    await withAdminUi(playwright, page, async ({ baseUrl, database, admin }) => {
      const api = `${baseUrl}${API}`;
      const observed = observeAccountUi(page, testInfo, baseUrl, api);
      await page.goto(`${baseUrl}${PAGE}`);
      await page.getByLabel('模型地址', { exact: true }).fill('http://models.invalid/v1');
      await page.getByLabel('模型名称 1', { exact: true }).fill('alpha');
      await page.getByLabel('默认模型', { exact: true }).selectOption('alpha');
      const secret = randomBytes(32).toString('hex');
      await page.getByLabel('密钥', { exact: true }).fill(secret);
      const before = readSettings(database);
      const audit = database.prepare('SELECT * FROM audit_events').all();
      if (status === 401)
        database.prepare('DELETE FROM platform_sessions WHERE user_id=?').run(admin.id);
      else database.prepare("UPDATE users SET role='employee' WHERE id=?").run(admin.id);
      // Capture the actual denial before the client401 navigation discards Chromium's body.
      await page.route(
        api,
        async (route) => {
          const live = await route.fetch({ maxRedirects: 0 });
          expect(live.status()).toBe(status);
          expect((await live.text()).includes(secret)).toBe(false);
          await route.fulfill({ response: live });
        },
        { times: 1 },
      );
      const denied = page.waitForResponse(
        (response) => response.url() === api && response.request().method() === 'PUT',
      );
      await page.getByRole('button', { name: '保存配置', exact: true }).click();
      const response = await denied;
      expect(response.status()).toBe(status);
      if (status === 401) await expectPlatformLogin(page, baseUrl);
      else await expect(page.getByRole('alert')).toHaveText('无权限');
      await expect(page.getByRole('form', { name: '模型配置' })).toHaveCount(0);
      expect((await page.content()).includes(secret)).toBe(false);
      expect(readSettings(database)).toEqual(before);
      expect(database.prepare('SELECT * FROM audit_events').all()).toEqual(audit);
      await expectNoBrowserStorage(page);
      await observed.screenshot(`models-denied-${String(status)}`);
      if (status === 403) {
        await page.reload({ waitUntil: 'networkidle' });
        await expect(page.getByRole('alert')).toHaveText('无权限');
        await expect(page.getByLabel('密钥', { exact: true })).toHaveCount(0);
      }
      observed.expectHealthy(status === 403 ? [403, 403] : [401]);
    });
  });
}

test('model loading remains noneditable and explicit retry recovers from one controlled failure', async ({
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
      await observed.screenshot('models-loading');
      release.resolve(undefined);
      await expect(page.getByLabel('模型地址', { exact: true })).toBeVisible();
    });
    await withAccountUiRouteCleanup(page, async () => {
      await failAdminList(page, api, 'private-configuration-diagnostic');
      await page.reload({ waitUntil: 'networkidle' });
      await expect(page.getByRole('alert')).toContainText('加载失败');
      await expect(page.getByRole('form')).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText('private-configuration-diagnostic');
      await observed.screenshot('models-failed');
      await page.getByRole('button', { name: '重试', exact: true }).click();
      await expect(page.getByLabel('模型地址', { exact: true })).toBeVisible();
    });
    expect(observed.actionRequests.every((request) => request.method === 'GET')).toBe(true);
    observed.expectHealthy([500]);
  });
});
