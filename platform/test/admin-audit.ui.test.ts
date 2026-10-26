import { expect, test, type Page, type Response } from '@playwright/test';
import { recordAuditEvent } from '../src/audit/index.ts';
import {
  expectNoBrowserStorage,
  expectNoScriptVisibleCookie,
  expectViewportLayout,
} from './account-ui-fixture.ts';
import {
  withAdminUi,
  observeAuditUi,
  readAuditSnapshot,
  expectAuditUnchanged,
} from './admin-ui-fixture.ts';

test('administrator opens the built audit page and sees a real stored event', async ({
  page,
  playwright,
}, testInfo) => {
  await withAdminUi(playwright, page, async ({ baseUrl, database, admin, target }) => {
    recordAuditEvent(database, {
      type: 'instance.stopped',
      createdAt: 1_900_000_000_000,
      actorEmail: admin.email,
      targetEmail: target.email,
      target: 'audit-tracer-instance',
      sourceAddress: '192.0.2.76',
      details: { reason: 'admin' },
    });
    const before = readAuditSnapshot(database);
    const { url, actionResponses, otherMutations, screenshot, expectHealthy } = observeAuditUi(
      page,
      testInfo,
      baseUrl,
    );

    const entry = await page.goto(`${baseUrl}/_platform/admin/audit`, {
      waitUntil: 'networkidle',
    });

    expect(entry?.status()).toBe(200);
    const event = page.getByRole('row').filter({ hasText: 'audit-tracer-instance' });
    await expect(event).toContainText(admin.email);
    await expect(event).toContainText(target.email);
    await expect(event).toContainText('192.0.2.76');
    expect(actionResponses).toEqual([{ url, status: 200 }]);
    expect(otherMutations).toEqual([]);
    expectAuditUnchanged(database, before);
    await expectNoBrowserStorage(page);
    await expectNoScriptVisibleCookie(page);
    await screenshot('admin-audit-entry');
    expectHealthy([]);
  });
});

test.use({ timezoneId: 'Asia/Shanghai' });

async function expectIds(page: Page, ids: readonly number[]): Promise<void> {
  await expect(page.locator('tbody tr')).toHaveCount(ids.length);
  await expect
    .poll(async () => {
      const rows = page.locator('tbody tr');
      return Promise.all(
        ids.map(async (_id, index) => Number(await rows.nth(index).getAttribute('data-audit-id'))),
      );
    })
    .toEqual(ids);
}

async function expectResponseIds(response: Response, ids: readonly number[]): Promise<void> {
  expect(response.status()).toBe(200);
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null || !('items' in body) || !Array.isArray(body.items))
    throw new Error('Missing audit response');
  expect(Object.keys(body).sort()).toEqual(['items', 'page', 'pageSize']);
  const actual = body.items.map((item: unknown) => {
    if (typeof item !== 'object' || item === null || !('id' in item))
      throw new Error('Missing audit identity');
    return item.id;
  });
  expect(actual).toEqual(ids);
}

test('real event, actor-or-target email and local inclusive time filters intersect without changing audit records', async ({
  page,
  playwright,
}, testInfo) => {
  await withAdminUi(playwright, page, async ({ baseUrl, database }) => {
    database.prepare('DELETE FROM audit_events').run();
    const alice = 'alice@example.com';
    const bob = 'bob@example.com';
    const from = 1_893_456_000_000;
    const records = [
      { type: 'login.succeeded', createdAt: from - 1, actorEmail: alice, target: 'before' },
      { type: 'login.succeeded', createdAt: from, actorEmail: alice, target: 'start' },
      {
        type: 'login.succeeded',
        createdAt: from + 1000,
        targetEmail: alice,
        target: 'target-only',
      },
      {
        type: 'login.succeeded',
        createdAt: from + 1000,
        actorEmail: alice,
        targetEmail: alice,
        target: 'both',
      },
      {
        type: 'account.disabled',
        createdAt: from + 1000,
        actorEmail: bob,
        targetEmail: bob,
        target: alice,
      },
      { type: 'login.succeeded', createdAt: from + 2000, actorEmail: bob, target: 'end-unrelated' },
      {
        type: 'instance.stopped',
        createdAt: from + 2000,
        targetEmail: alice,
        target: 'end-stop',
        details: { reason: 'admin' },
      },
      { type: 'login.succeeded', createdAt: from + 2001, actorEmail: alice, target: 'after' },
    ];
    for (const record of records) recordAuditEvent(database, record);
    const before = readAuditSnapshot(database);
    const initial = `${baseUrl}/_platform/api/admin/audit-events?page=1&pageSize=20`;
    const eventUrl = `${initial}&eventType=login.succeeded`;
    const emailUrl = `${initial}&email=ALICE%40EXAMPLE.COM`;
    const timeUrl = `${initial}&from=1893456000000&to=1893456002000`;
    const combined = `${eventUrl}&email=ALICE%40EXAMPLE.COM&from=1893456000000&to=1893456002000`;
    const accounts = `${baseUrl}/_platform/api/admin/users?page=1&pageSize=20`;
    const { screenshot, expectHealthy, actionRequests, otherMutations } = observeAuditUi(
      page,
      testInfo,
      baseUrl,
      [eventUrl, emailUrl, timeUrl, combined, accounts],
    );
    await page.goto(`${baseUrl}/_platform/admin`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('link', { name: '账号管理', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await page.getByRole('link', { name: '审计日志', exact: true }).click();
    await expect(page.getByRole('link', { name: '审计日志', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page).toHaveURL(`${baseUrl}/_platform/admin/audit`);
    await expect(page.getByRole('link', { name: '账号管理', exact: true })).not.toHaveAttribute(
      'aria-current',
      'page',
    );
    await expectIds(page, [8, 7, 6, 5, 4, 3, 2, 1]);
    await expectViewportLayout(page, screenshot, 'glass-admin-audit', async () => {
      await expect(page.locator('tbody tr')).toHaveCount(8);
    });
    await page.getByLabel('事件类型').selectOption('login.succeeded');
    expect(actionRequests.filter((request) => request.url === eventUrl)).toEqual([]);
    const eventResponse = page.waitForResponse(eventUrl);
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    await expectResponseIds(await eventResponse, [8, 6, 4, 3, 2, 1]);
    await expectIds(page, [8, 6, 4, 3, 2, 1]);
    await expect(page.locator('tbody tr td:nth-child(5)')).toHaveText([
      'after',
      'end-unrelated',
      'both',
      'target-only',
      'start',
      'before',
    ]);
    await screenshot('audit-event-filter');
    await page.getByLabel('事件类型').selectOption('');
    await page.getByLabel('邮箱', { exact: true }).fill(' ALICE@EXAMPLE.COM ');
    const emailResponse = page.waitForResponse(emailUrl);
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    await expectResponseIds(await emailResponse, [8, 7, 4, 3, 2, 1]);
    await expectIds(page, [8, 7, 4, 3, 2, 1]);
    await expect(page.locator('tbody tr td:nth-child(5)')).toHaveText([
      'after',
      'end-stop',
      'both',
      'target-only',
      'start',
      'before',
    ]);
    await screenshot('audit-email-filter');
    await page.getByLabel('邮箱', { exact: true }).fill('');
    await page.getByLabel('开始时间').fill('2030-01-01T08:00');
    await page.getByLabel('结束时间').fill('2030-01-01T08:00:02');
    const timeResponse = page.waitForResponse(timeUrl);
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    await expectResponseIds(await timeResponse, [7, 6, 5, 4, 3, 2]);
    await expectIds(page, [7, 6, 5, 4, 3, 2]);
    await expect(page.locator('tbody tr td:nth-child(5)')).toHaveText([
      'end-stop',
      'end-unrelated',
      'alice@example.com',
      'both',
      'target-only',
      'start',
    ]);
    await expect(page.locator('time').first()).toHaveAttribute(
      'datetime',
      '2030-01-01T00:00:02.000Z',
    );
    await screenshot('audit-local-inclusive-time');
    await page.getByLabel('事件类型').selectOption('login.succeeded');
    await page.getByLabel('邮箱', { exact: true }).fill('ALICE@EXAMPLE.COM');
    const intersectionResponse = page.waitForResponse(combined);
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    await expectResponseIds(await intersectionResponse, [4, 3, 2]);
    await expectIds(page, [4, 3, 2]);
    await expect(page.locator('tbody tr td:nth-child(5)')).toHaveText([
      'both',
      'target-only',
      'start',
    ]);
    await screenshot('audit-filter-intersection');
    await page.getByRole('link', { name: '账号管理', exact: true }).click();
    await expect(page.getByRole('heading', { name: '账号管理', exact: true })).toBeVisible();
    await expect(page).toHaveURL(`${baseUrl}/_platform/admin`);
    await expect(page.getByRole('link', { name: '账号管理', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByRole('link', { name: '审计日志', exact: true })).not.toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(actionRequests.every((request) => request.method === 'GET')).toBe(true);
    expect(otherMutations).toEqual([]);
    expectAuditUnchanged(database, before);
    await expectNoBrowserStorage(page);
    expectHealthy([]);
  });
});

test('real tied filtered page20 membership has a short last page and filter reset', async ({
  page,
  playwright,
}, testInfo) => {
  await withAdminUi(playwright, page, async ({ baseUrl, database }) => {
    database.prepare('DELETE FROM audit_events').run();
    for (let index = 1; index <= 24; index++)
      recordAuditEvent(database, {
        type: 'instance.ready',
        createdAt: 1_900_000_000_000,
        target: `ready-${String(index)}`,
      });
    recordAuditEvent(database, {
      type: 'login.failed',
      createdAt: 1_900_000_000_001,
      target: 'newer-decoy',
    });
    const before = readAuditSnapshot(database);
    const initial = `${baseUrl}/_platform/api/admin/audit-events?page=1&pageSize=20`;
    const first = `${initial}&eventType=instance.ready`;
    const second = `${baseUrl}/_platform/api/admin/audit-events?page=2&pageSize=20&eventType=instance.ready`;
    const empty = `${initial}&eventType=instance.ready&email=absent%40example.com`;
    const { screenshot, expectHealthy, actionRequests, otherMutations } = observeAuditUi(
      page,
      testInfo,
      baseUrl,
      [first, second, empty],
    );
    await page.goto(`${baseUrl}/_platform/admin/audit`, { waitUntil: 'networkidle' });
    await page.getByLabel('事件类型').selectOption('instance.ready');
    const firstResponse = page.waitForResponse(first);
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    const firstIds = [24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5];
    await expectResponseIds(await firstResponse, firstIds);
    await expectIds(page, firstIds);
    await expect(page.locator('tbody tr td:nth-child(5)')).toHaveText([
      'ready-24',
      'ready-23',
      'ready-22',
      'ready-21',
      'ready-20',
      'ready-19',
      'ready-18',
      'ready-17',
      'ready-16',
      'ready-15',
      'ready-14',
      'ready-13',
      'ready-12',
      'ready-11',
      'ready-10',
      'ready-9',
      'ready-8',
      'ready-7',
      'ready-6',
      'ready-5',
    ]);
    await expect(page.getByRole('button', { name: '上一页' })).toBeDisabled();
    const secondResponse = page.waitForResponse(second);
    await page.getByRole('button', { name: '下一页' }).click();
    await expectResponseIds(await secondResponse, [4, 3, 2, 1]);
    await expectIds(page, [4, 3, 2, 1]);
    await expect(page.locator('tbody tr td:nth-child(5)')).toHaveText([
      'ready-4',
      'ready-3',
      'ready-2',
      'ready-1',
    ]);
    await expect(page.getByRole('button', { name: '下一页' })).toBeDisabled();
    await screenshot('audit-short-last-page');
    await page.getByLabel('邮箱', { exact: true }).fill('absent@example.com');
    const resetResponse = page.waitForResponse(empty);
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    await expectResponseIds(await resetResponse, []);
    await expect(page.getByRole('status')).toHaveText('没有匹配的审计记录');
    await expect(page.getByLabel('审计分页')).toContainText('第 1 页');
    await screenshot('audit-no-match-reset');
    expect(actionRequests).toEqual([
      { url: initial, method: 'GET' },
      { url: first, method: 'GET' },
      { url: second, method: 'GET' },
      { url: empty, method: 'GET' },
    ]);
    expect(otherMutations).toEqual([]);
    expectAuditUnchanged(database, before);
    expectHealthy([]);
  });
});

test('a full real terminal page permits an empty next page and returning to its exact previous membership', async ({
  page,
  playwright,
}, testInfo) => {
  await withAdminUi(playwright, page, async ({ baseUrl, database }) => {
    database.prepare('DELETE FROM audit_events').run();
    for (let index = 1; index <= 40; index++)
      recordAuditEvent(database, {
        type: 'instance.started',
        createdAt: 1_900_000_000_000,
        target: `started-${String(index)}`,
      });
    const before = readAuditSnapshot(database);
    const second = `${baseUrl}/_platform/api/admin/audit-events?page=2&pageSize=20`;
    const third = `${baseUrl}/_platform/api/admin/audit-events?page=3&pageSize=20`;
    const { screenshot, expectHealthy, otherMutations } = observeAuditUi(page, testInfo, baseUrl, [
      second,
      third,
    ]);
    await page.goto(`${baseUrl}/_platform/admin/audit`, { waitUntil: 'networkidle' });
    await expectIds(
      page,
      [40, 39, 38, 37, 36, 35, 34, 33, 32, 31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21],
    );
    await expect(page.locator('tbody tr td:nth-child(5)')).toHaveText([
      'started-40',
      'started-39',
      'started-38',
      'started-37',
      'started-36',
      'started-35',
      'started-34',
      'started-33',
      'started-32',
      'started-31',
      'started-30',
      'started-29',
      'started-28',
      'started-27',
      'started-26',
      'started-25',
      'started-24',
      'started-23',
      'started-22',
      'started-21',
    ]);
    const secondIds = [20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    await page.getByRole('button', { name: '下一页' }).click();
    await expectIds(page, secondIds);
    await expect(page.locator('tbody tr td:nth-child(5)')).toHaveText([
      'started-20',
      'started-19',
      'started-18',
      'started-17',
      'started-16',
      'started-15',
      'started-14',
      'started-13',
      'started-12',
      'started-11',
      'started-10',
      'started-9',
      'started-8',
      'started-7',
      'started-6',
      'started-5',
      'started-4',
      'started-3',
      'started-2',
      'started-1',
    ]);
    await screenshot('audit-full-terminal-page');
    const terminal = page.waitForResponse(third);
    await page.getByRole('button', { name: '下一页' }).click();
    await expectResponseIds(await terminal, []);
    await expect(page.getByRole('status')).toHaveText('本页没有审计记录');
    await expect(page.getByRole('button', { name: '下一页' })).toBeDisabled();
    await expect(page.getByRole('button', { name: '上一页' })).toBeEnabled();
    await expect(page.getByLabel('审计分页')).not.toContainText('共');
    await screenshot('audit-empty-terminal-page');
    await page.getByRole('button', { name: '上一页' }).click();
    await expectIds(page, secondIds);
    expect(otherMutations).toEqual([]);
    expectAuditUnchanged(database, before);
    expectHealthy([]);
  });
});
