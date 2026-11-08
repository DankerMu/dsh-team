import { randomBytes } from 'node:crypto';
import { expect, test, type Page, type Response } from '@playwright/test';
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
import { refusedOrigin, startModelUpstream } from './model-upstream-fixture.ts';

const PAGE = '/_platform/admin/knowledge-base';
const HINT = '保存即生效：平台之后的每次知识库请求都使用新配置，不需要重启实例。';
const SAVED = '已保存，立即生效。';
const NOT_CONFIGURED = '未配置 RAGFlow 地址或密钥，或密钥被拒绝';
const UPSTREAM_ERROR = 'RAGFlow 返回了异常结果';
const UNAVAILABLE = '无法连接到 RAGFlow 地址';
const CONNECTED = '连接成功，RAGFlow 版本：v1.0.0-rc2';
const ADDRESS_INVALID =
  'RAGFlow 地址无效：须以 http:// 或 https:// 开头，不含空白、?、#、@ 或 \\，最长 2048 个字符。';
const PARAMETERS_INVALID =
  '检索参数无效：返回片段数为 1–100 的整数，相似度阈值和关键词权重为 0–1 之间的数，重排模型 ID 前后不能有空白。';
const LOAD_FAILED = '知识库配置加载失败，请重试。';
const VERSION_PATH = '/api/v1/system/version';
const MODELS_PATH = '/api/v1/users/me/models';
const BUTTONS = ['保存连接配置', '保存检索参数', '测试连接'] as const;

type Handler = Parameters<Awaited<ReturnType<typeof startModelUpstream>>['setHandler']>[0];
function answer(status: number, body: unknown): Handler {
  return (_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
}
const VERSION_OK = answer(200, { code: 0, data: 'v1.0.0-rc2' });
const MODELS_OK = answer(200, { code: 0, data: { tenant_id: 'f'.repeat(32), role: 'owner' } });
/** A test-owned loopback RAGFlow answering only the two connection-test paths. */
function ragflow(version: Handler = VERSION_OK, models: Handler = MODELS_OK): Handler {
  return (request, response, socket) => {
    const route =
      request.path === VERSION_PATH
        ? version
        : request.path === MODELS_PATH
          ? models
          : answer(404, {});
    route(request, response, socket);
  };
}
function urls(baseUrl: string) {
  return {
    connection: `${baseUrl}/_platform/api/admin/ragflow-config`,
    retrieval: `${baseUrl}/_platform/api/admin/retrieval-config`,
    test: `${baseUrl}/_platform/api/admin/ragflow-config/test`,
  };
}
function observeKnowledgeBase(
  page: Page,
  testInfo: Parameters<typeof observeAccountUi>[1],
  baseUrl: string,
) {
  const api = urls(baseUrl);
  return {
    api,
    ...observeAccountUi(page, testInfo, baseUrl, [api.connection, api.retrieval, api.test]),
  };
}
function auditCount(database: DatabaseHandle, type: string): number {
  return database.prepare('SELECT * FROM audit_events WHERE event_type=?').all(type).length;
}
function form(page: Page, name: string) {
  return page.getByRole('form', { name, exact: true });
}
function field(page: Page, label: string) {
  return page.getByLabel(label, { exact: true });
}
async function press(page: Page, url: string, method: string, label: string) {
  const response = page.waitForResponse(
    (candidate) => candidate.url() === url && candidate.request().method() === method,
  );
  await page.getByRole('button', { name: label, exact: true }).click();
  return response;
}
/** Clicks 保存检索参数 with its real PUT held at the browser until `pending` has run. */
async function withHeldSave(page: Page, url: string, pending: () => Promise<void>) {
  let answer: Promise<Response> | undefined;
  await withAccountUiRouteCleanup(page, async (release) => {
    const held = await holdAdminList(page, url, release.promise, 'PUT');
    answer = page.waitForResponse(
      (candidate) => candidate.url() === url && candidate.request().method() === 'PUT',
    );
    await page.getByRole('button', { name: '保存检索参数', exact: true }).click();
    await held.promise;
    await pending();
    release.resolve(undefined);
    await answer;
  });
  if (answer === undefined) throw new Error('Missing held save response');
  return answer;
}
/** Runs one connection test and proves it wrote no audit row. */
async function testConnection(page: Page, url: string, database: DatabaseHandle) {
  const audits = readAuditSnapshot(database);
  const response = await press(page, url, 'POST', '测试连接');
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON()).toEqual({});
  expectAuditUnchanged(database, audits);
}
async function expectNoSecret(page: Page, secret: string): Promise<void> {
  expect((await page.content()).includes(secret)).toBe(false);
  expect(page.url().includes(secret)).toBe(false);
  await expectNoBrowserStorage(page);
}
async function expectNoConfiguration(page: Page): Promise<void> {
  await expect(page.locator('form')).toHaveCount(0);
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByRole('spinbutton')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(HINT);
  await expect(page.locator('body')).not.toContainText('已配置');
}

test('administrator configures, tests and tunes RAGFlow through the real APIs', async ({
  page,
  playwright,
}, testInfo) => {
  const key = `owned-ragflow-key-${randomBytes(12).toString('hex')}`;
  const upstream = await startModelUpstream(ragflow());
  try {
    await withAdminUi(playwright, page, async ({ baseUrl, database }) => {
      const observed = observeKnowledgeBase(page, testInfo, baseUrl);
      const { api } = observed;
      const entry = await page.goto(`${baseUrl}${PAGE}`);
      expect(entry?.status()).toBe(200);
      await expect(page.getByText(HINT, { exact: true })).toBeVisible();
      await expect(field(page, 'RAGFlow 地址')).toHaveValue('');
      await expect(page.locator('#ragflow-key-state')).toHaveText('未配置');
      await expect(field(page, '返回片段数')).toHaveValue('8');
      await expect(field(page, '相似度阈值')).toHaveValue('0.2');
      await expect(field(page, '关键词权重')).toHaveValue('0.7');
      await expect(field(page, '重排模型 ID')).toHaveValue('');
      await expectViewportLayout(
        page,
        observed.screenshot,
        'glass-admin-knowledge-base',
        async () => {
          await expect(form(page, 'RAGFlow 连接')).toBeVisible();
          await expect(form(page, '检索参数')).toBeVisible();
        },
      );
      await testConnection(page, api.test, database);
      await expect(page.getByRole('alert')).toHaveText(NOT_CONFIGURED);
      expect(upstream.requests).toEqual([]);

      await field(page, 'RAGFlow 地址').fill(upstream.origin);
      await field(page, '密钥').fill(key);
      const savedConnection = await press(page, api.connection, 'PUT', '保存连接配置');
      expect(savedConnection.status()).toBe(200);
      expect(savedConnection.request().postDataJSON()).toEqual({
        baseURL: upstream.origin,
        apiKey: key,
      });
      expect(readSettings(database)).toMatchObject({
        ragflowBaseUrl: upstream.origin,
        ragflowApiKey: key,
      });
      expect(auditCount(database, 'ragflow-config.updated')).toBe(1);
      await expect(page.getByRole('status')).toHaveText(SAVED);
      await expect(page.locator('#ragflow-key-state')).toHaveText('已配置');
      await expect(field(page, '密钥')).toHaveValue('');
      await expectNoSecret(page, key);

      await testConnection(page, api.test, database);
      await expect(page.getByRole('status')).toHaveText(CONNECTED);
      await observed.screenshot('admin-knowledge-base-connection-ok');
      expect(upstream.requests.map((request) => request.path)).toEqual([VERSION_PATH, MODELS_PATH]);
      expect(upstream.requests[0]?.headers.authorization).toBeUndefined();
      expect(upstream.requests[1]?.headers.authorization).toBe(`Bearer ${key}`);

      const release = Promise.withResolvers<undefined>();
      upstream.setHandler(
        ragflow((request, response, socket) => {
          void release.promise.then(() => {
            VERSION_OK(request, response, socket);
          });
        }),
      );
      const tests = () =>
        observed.actionRequests.filter((request) => request.url === api.test).length;
      const before = tests();
      const heldAudits = readAuditSnapshot(database);
      await page.getByRole('button', { name: '测试连接', exact: true }).dblclick();
      await upstream.received(3);
      await expect(page.getByRole('status')).toHaveText('正在测试连接…');
      for (const label of BUTTONS)
        await expect(page.getByRole('button', { name: label, exact: true })).toBeDisabled();
      await observed.screenshot('admin-knowledge-base-testing');
      release.resolve(undefined);
      await expect(page.getByRole('status')).toHaveText(CONNECTED);
      expectAuditUnchanged(database, heldAudits);
      for (const label of BUTTONS)
        await expect(page.getByRole('button', { name: label, exact: true })).toBeEnabled();
      expect(tests() - before).toBe(1);
      expect(upstream.requests).toHaveLength(4);

      upstream.setHandler(ragflow(VERSION_OK, answer(401, { code: 401, message: 'x' })));
      await testConnection(page, api.test, database);
      await expect(page.getByRole('alert')).toHaveText(NOT_CONFIGURED);
      upstream.setHandler(ragflow(answer(200, { code: 500, message: 'x' })));
      await testConnection(page, api.test, database);
      await expect(page.getByRole('alert')).toHaveText(UPSTREAM_ERROR);
      await observed.screenshot('admin-knowledge-base-connection-upstream-error');
      const refused = await refusedOrigin();
      await field(page, 'RAGFlow 地址').fill(refused);
      const savedRefused = await press(page, api.connection, 'PUT', '保存连接配置');
      expect(savedRefused.status()).toBe(200);
      expect(savedRefused.request().postDataJSON()).toEqual({ baseURL: refused });
      expect(auditCount(database, 'ragflow-config.updated')).toBe(2);
      expect(readSettings(database)).toMatchObject({ ragflowBaseUrl: refused, ragflowApiKey: key });
      await testConnection(page, api.test, database);
      await expect(page.getByRole('alert')).toHaveText(UNAVAILABLE);
      expect(new Set([NOT_CONFIGURED, UPSTREAM_ERROR, UNAVAILABLE]).size).toBe(3);

      await field(page, '返回片段数').fill('3');
      const savedRetrieval = await press(page, api.retrieval, 'PUT', '保存检索参数');
      expect(savedRetrieval.status()).toBe(200);
      expect(readSettings(database)).toMatchObject({
        retrievalTopK: 3,
        retrievalSimilarityThreshold: 0.2,
        retrievalKeywordsWeight: 0.7,
        retrievalRerankId: '',
      });
      expect(auditCount(database, 'retrieval-config.updated')).toBe(1);
      await expect(page.getByRole('status')).toHaveText(SAVED);
      const settings = readSettings(database);
      const audits = readAuditSnapshot(database);
      await field(page, '重排模型 ID').fill(' rr ');
      const whitespace = await press(page, api.retrieval, 'PUT', '保存检索参数');
      expect(whitespace.request().postDataJSON()).toEqual({
        retrievalTopK: 3,
        retrievalSimilarityThreshold: 0.2,
        retrievalKeywordsWeight: 0.7,
        retrievalRerankId: ' rr ',
      });
      expect(whitespace.status()).toBe(400);
      await expect(page.getByRole('alert')).toHaveText(PARAMETERS_INVALID);
      await field(page, '重排模型 ID').fill('');
      await field(page, '返回片段数').fill('0');
      // Hold the real PUT so the previous 400 text is seen to clear before this answer arrives.
      const outOfRange = await withHeldSave(page, api.retrieval, async () => {
        await expect(page.getByRole('status')).toHaveText('正在保存…');
        await expect(page.getByRole('alert')).toHaveCount(0);
      });
      expect(outOfRange.request().postDataJSON()).toMatchObject({
        retrievalTopK: 0,
        retrievalRerankId: '',
      });
      expect(outOfRange.status()).toBe(400);
      await expect(page.getByRole('alert')).toHaveText(PARAMETERS_INVALID);
      await observed.screenshot('admin-knowledge-base-retrieval-invalid');
      expect(readSettings(database)).toEqual(settings);
      expectAuditUnchanged(database, audits);

      await field(page, 'RAGFlow 地址').fill('http://ragflow.invalid/?x');
      const invalidAddress = await press(page, api.connection, 'PUT', '保存连接配置');
      expect(invalidAddress.status()).toBe(400);
      await expect(page.getByRole('alert')).toHaveText(ADDRESS_INVALID);
      await observed.screenshot('admin-knowledge-base-address-invalid');
      expect(readSettings(database)).toEqual(settings);
      expectAuditUnchanged(database, audits);

      await page.reload();
      await expect(field(page, 'RAGFlow 地址')).toHaveValue(refused);
      await expect(page.locator('#ragflow-key-state')).toHaveText('已配置');
      await expect(field(page, '密钥')).toHaveValue('');
      await expect(field(page, '返回片段数')).toHaveValue('3');
      await expect(field(page, '相似度阈值')).toHaveValue('0.2');
      await expect(field(page, '关键词权重')).toHaveValue('0.7');
      await expect(field(page, '重排模型 ID')).toHaveValue('');
      await observed.screenshot('admin-knowledge-base-reloaded');
      await expectNoSecret(page, key);
      expect(observed.otherMutations).toEqual([]);
      observed.expectHealthy([
        { url: api.retrieval, status: 400 },
        { url: api.retrieval, status: 400 },
        { url: api.connection, status: 400 },
      ]);
    });
  } finally {
    await upstream.close();
  }
});

test('loading holds a real read and one controlled failure retries the real APIs', async ({
  page,
  playwright,
}, testInfo) => {
  await withAdminUi(playwright, page, async ({ baseUrl }) => {
    const observed = observeKnowledgeBase(page, testInfo, baseUrl);
    await withAccountUiRouteCleanup(page, async (release) => {
      const held = await holdAdminList(page, observed.api.connection, release.promise);
      const entry = await page.goto(`${baseUrl}${PAGE}`, { waitUntil: 'domcontentloaded' });
      expect(entry?.status()).toBe(200);
      await held.promise;
      await expect(page.getByRole('status')).toHaveText('加载中…');
      await expect(page.locator('form')).toHaveCount(0);
      await observed.screenshot('admin-knowledge-base-loading');
      release.resolve(undefined);
      await expect(form(page, 'RAGFlow 连接')).toBeVisible();
    });
    await withAccountUiRouteCleanup(page, async () => {
      await failAdminList(page, observed.api.retrieval, 'private-knowledge-base-diagnostic');
      await page.reload({ waitUntil: 'networkidle' });
      await expect(page.getByRole('alert')).toHaveText(LOAD_FAILED);
      await expectNoConfiguration(page);
      await expect(page.locator('body')).not.toContainText('private-knowledge-base-diagnostic');
      await observed.screenshot('admin-knowledge-base-failed');
      await page.getByRole('button', { name: '重试', exact: true }).click();
      await expect(form(page, '检索参数')).toBeVisible();
    });
    await expectNoBrowserStorage(page);
    expect(observed.actionRequests.every((request) => request.method === 'GET')).toBe(true);
    observed.expectHealthy([{ url: observed.api.retrieval, status: 500 }]);
  });
});

for (const status of [401, 403]) {
  test(`entry authority rejection ${String(status)} shows no configuration`, async ({
    page,
    playwright,
  }, testInfo) => {
    await withAdminUi(playwright, page, async ({ baseUrl, target }) => {
      const observed = observeKnowledgeBase(page, testInfo, baseUrl);
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
      await observed.screenshot(`admin-knowledge-base-entry-${String(status)}`);
      const rejections = [observed.api.connection, observed.api.retrieval].map((url) => ({
        url,
        status,
      }));
      expect(observed.actionResponses).toEqual(expect.arrayContaining(rejections));
      expect(observed.actionResponses).toHaveLength(2);
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
      const observed = observeKnowledgeBase(page, testInfo, baseUrl);
      await page.goto(`${baseUrl}${PAGE}`);
      await expect(form(page, '检索参数')).toBeVisible();
      const before = readSettings(database);
      const audits = readAuditSnapshot(database);
      if (status === 401)
        database.prepare('DELETE FROM platform_sessions WHERE user_id=?').run(admin.id);
      else database.prepare("UPDATE users SET role='employee' WHERE id=?").run(admin.id);
      await field(page, '返回片段数').fill('5');
      const denied = await press(page, observed.api.retrieval, 'PUT', '保存检索参数');
      expect(denied.status()).toBe(status);
      if (status === 401) await expectPlatformLogin(page, baseUrl);
      else {
        await expect(page.getByRole('alert')).toHaveText('无权限');
        await expectNoConfiguration(page);
      }
      expect(readSettings(database)).toEqual(before);
      expectAuditUnchanged(database, audits);
      await expectNoBrowserStorage(page);
      await observed.screenshot(`admin-knowledge-base-denied-${String(status)}`);
      expect(observed.otherMutations).toEqual([]);
      observed.expectHealthy([{ url: observed.api.retrieval, status }]);
    });
  });
}

test('the audit filter names the two knowledge-base configuration events', async ({
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
    expect(options).toEqual(expect.arrayContaining(['修改知识库连接', '修改检索参数']));
    expect(observed.otherMutations).toEqual([]);
    observed.expectHealthy([]);
  });
});
