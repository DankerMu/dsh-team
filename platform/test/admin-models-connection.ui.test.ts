import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { writeSettings } from '../src/db/index.ts';
import { observeAccountUi, expectNoBrowserStorage } from './account-ui-fixture.ts';
import { withAdminUi, expectPlatformLogin } from './admin-ui-fixture.ts';
import {
  completionHandler,
  startModelUpstream,
  UPSTREAM_KEY,
  UPSTREAM_MODEL,
} from './model-upstream-fixture.ts';

const PAGE = '/_platform/admin/models';
const API = '/_platform/api/admin/model-config';
const TEST = '/_platform/api/admin/model-config/test';
const LABEL = '测试默认模型连接';
const HINT = 'OpenAI 兼容地址通常以 /v1 结尾';

async function save(page: Page, address: string, key: string): Promise<void> {
  await page.getByLabel('模型地址', { exact: true }).fill(address);
  await page.getByLabel('密钥', { exact: true }).fill(key);
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('下次启动实例时生效');
}
async function runTest(page: Page, testUrl: string): Promise<void> {
  const answered = page.waitForResponse(
    (response) => response.url() === testUrl && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: LABEL, exact: true }).click();
  expect((await answered).status()).toBe(200);
}

test('administrator saves then tests the real loopback model with fixed explanations', async ({
  page,
  playwright,
}, testInfo) => {
  const marker = `owned-upstream-marker-${randomBytes(8).toString('hex')}`;
  const upstream = await startModelUpstream(completionHandler('/v1/chat/completions', marker));
  try {
    await withAdminUi(playwright, page, async ({ baseUrl, database }) => {
      const api = `${baseUrl}${API}`;
      const testUrl = `${baseUrl}${TEST}`;
      const observed = observeAccountUi(page, testInfo, baseUrl, [api, testUrl]);
      await page.goto(`${baseUrl}${PAGE}`);
      const address = page.getByLabel('模型地址', { exact: true });
      await expect(address).toHaveAccessibleDescription('OpenAI 兼容地址，通常以 /v1 结尾');
      await expect(page.getByText('测试使用上次保存的配置，未保存的修改不参与')).toBeVisible();
      await page.getByLabel('模型名称 1', { exact: true }).fill(UPSTREAM_MODEL);
      await page.getByLabel('默认模型', { exact: true }).selectOption(UPSTREAM_MODEL);
      await save(page, `${upstream.origin}/v1`, UPSTREAM_KEY);

      const release = Promise.withResolvers<undefined>();
      upstream.setHandler((request, response, socket) => {
        void release.promise.then(() => {
          completionHandler('/v1/chat/completions', marker)(request, response, socket);
        });
      });
      await page.getByLabel('密钥', { exact: true }).fill('unsaved-typed-key');
      await page.getByRole('button', { name: LABEL, exact: true }).dblclick();
      await upstream.received(1);
      await expect(page.getByRole('status')).toHaveText('正在测试连接…');
      await expect(page.getByRole('button', { name: LABEL, exact: true })).toBeDisabled();
      release.resolve(undefined);
      await expect(page.getByRole('status')).toContainText('连接成功');
      expect(observed.actionRequests.filter((request) => request.url === testUrl)).toHaveLength(1);
      expect(upstream.requests).toHaveLength(1);
      expect(upstream.requests[0]?.path).toBe('/v1/chat/completions');
      await expect(page.getByLabel('密钥', { exact: true })).toHaveValue('unsaved-typed-key');
      await observed.screenshot('admin-models-connection-test');

      upstream.setHandler(completionHandler('/v1/chat/completions', marker));
      await save(page, `${upstream.origin}/v1`, 'wrong-owned-key');
      await runTest(page, testUrl);
      await expect(page.getByRole('alert')).toHaveText('密钥无效或无权访问该模型');
      await observed.screenshot('admin-models-connection-unauthorized');

      await save(page, `${upstream.origin}/wrong`, UPSTREAM_KEY);
      const audits = database.prepare('SELECT * FROM audit_events ORDER BY id').all();
      await runTest(page, testUrl);
      await expect(page.getByRole('alert')).toContainText('地址或模型不存在');
      await expect(page.getByRole('alert')).toContainText(HINT);
      await observed.screenshot('admin-models-connection-not-found');

      expect(upstream.requests.map((request) => request.path)).toEqual([
        '/v1/chat/completions',
        '/v1/chat/completions',
        '/wrong/chat/completions',
      ]);
      const content = await page.content();
      for (const value of [UPSTREAM_KEY, marker]) expect(content.includes(value)).toBe(false);
      expect(database.prepare('SELECT * FROM audit_events ORDER BY id').all()).toEqual(audits);
      await expectNoBrowserStorage(page);
      observed.expectHealthy([]);
    });
  } finally {
    await upstream.close();
  }
});

for (const status of [401, 403]) {
  test(`connection test denial ${String(status)} follows the model page authority policy`, async ({
    page,
    playwright,
  }, testInfo) => {
    const upstream = await startModelUpstream();
    try {
      await withAdminUi(playwright, page, async ({ baseUrl, database, admin }) => {
        const testUrl = `${baseUrl}${TEST}`;
        const observed = observeAccountUi(page, testInfo, baseUrl, [`${baseUrl}${API}`, testUrl]);
        writeSettings(database, {
          modelBaseUrl: `${upstream.origin}/v1`,
          modelApiKey: UPSTREAM_KEY,
          models: [{ name: UPSTREAM_MODEL }],
          defaultModel: UPSTREAM_MODEL,
        });
        await page.goto(`${baseUrl}${PAGE}`);
        await expect(page.getByLabel('模型地址', { exact: true })).toHaveValue(
          `${upstream.origin}/v1`,
        );
        if (status === 401)
          database.prepare('DELETE FROM platform_sessions WHERE user_id=?').run(admin.id);
        else database.prepare("UPDATE users SET role='employee' WHERE id=?").run(admin.id);
        const denied = page.waitForResponse(
          (response) => response.url() === testUrl && response.request().method() === 'POST',
        );

        await page.getByRole('button', { name: LABEL, exact: true }).click();

        expect((await denied).status()).toBe(status);
        if (status === 401) await expectPlatformLogin(page, baseUrl);
        else await expect(page.getByRole('alert')).toHaveText('无权限');
        await expect(page.getByRole('form', { name: '模型配置' })).toHaveCount(0);
        expect(upstream.requests).toEqual([]);
        await observed.screenshot(`admin-models-connection-denied-${String(status)}`);
        observed.expectHealthy([{ url: testUrl, status }]);
      });
    } finally {
      await upstream.close();
    }
  });
}
