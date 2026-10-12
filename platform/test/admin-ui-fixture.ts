import {
  expect,
  type APIRequestContext,
  type Page,
  type PlaywrightWorkerArgs,
  type TestInfo,
} from '@playwright/test';
import type { DatabaseHandle } from '../src/db/index.ts';
import { readPublicIdentity, type PublicIdentity } from './auth-fixture.ts';
import { recordAuditEvent } from '../src/audit/index.ts';
import {
  observeAccountUi,
  withAccountUi,
  type AccountUiContext,
  type AccountUiOptions,
} from './account-ui-fixture.ts';

export const ADMIN_UI_PASSWORD = 'browser-owned-account-password';

export async function seedAdminUi(
  seed: APIRequestContext,
  database: DatabaseHandle,
  page: Page,
  baseUrl: string,
) {
  const identities = [];
  for (const email of ['admin-browser@example.com', 'employee-browser@example.com']) {
    const response = await seed.post('/_platform/api/register', {
      data: { email, password: ADMIN_UI_PASSWORD },
    });
    expect(response.status()).toBe(201);
    identities.push(readPublicIdentity(await response.json()));
  }
  const [admin, target] = identities;
  if (admin === undefined || target === undefined) throw new Error('Missing owned UI identities');
  database.prepare("UPDATE users SET role='admin' WHERE id=?").run(admin.id);
  expect(await page.context().cookies()).toEqual([]);
  const login = await page.context().request.post(`${baseUrl}/_platform/api/login`, {
    headers: { Origin: baseUrl },
    data: { email: admin.email, password: ADMIN_UI_PASSWORD },
  });
  expect(login.status()).toBe(200);
  expect(readPublicIdentity(await login.json())).toMatchObject({
    email: admin.email,
    role: 'admin',
  });
  return { admin, target };
}

interface AdminUiContext extends Omit<AccountUiContext, 'target'> {
  admin: PublicIdentity;
  target: PublicIdentity;
}
type AuditSnapshot = unknown[];

export async function withAdminUi(
  playwright: PlaywrightWorkerArgs['playwright'],
  page: Page,
  run: (context: AdminUiContext) => Promise<void>,
  options: AccountUiOptions = {},
): Promise<void> {
  await withAccountUi(
    playwright,
    async (context) => {
      const identities = await seedAdminUi(context.seed, context.database, page, context.baseUrl);
      await run({ ...context, ...identities });
    },
    options,
  );
}

export function observeAuditUi(
  page: Page,
  testInfo: TestInfo,
  baseUrl: string,
  additionalUrls: readonly string[] = [],
) {
  const url = `${baseUrl}/_platform/api/admin/audit-events?page=1&pageSize=20`;
  return { url, ...observeAccountUi(page, testInfo, baseUrl, [url, ...additionalUrls]) };
}

export function seedAuditUiEvent(database: DatabaseHandle, target: string): void {
  recordAuditEvent(database, {
    type: 'instance.ready',
    createdAt: 1_900_000_000_000,
    target,
  });
}

export function readAuditSnapshot(database: DatabaseHandle): AuditSnapshot {
  return database.prepare('SELECT * FROM audit_events ORDER BY id').all();
}

export function expectAuditUnchanged(database: DatabaseHandle, before: AuditSnapshot): void {
  expect(readAuditSnapshot(database)).toEqual(before);
}

export async function holdAdminList(
  page: Page,
  url: string,
  release: Promise<undefined>,
): Promise<PromiseWithResolvers<undefined>> {
  const arrival = Promise.withResolvers<undefined>();
  await page.route(
    url,
    async (route) => {
      expect(route.request().method()).toBe('GET');
      arrival.resolve(undefined);
      await release;
      await route.continue();
    },
    { times: 1 },
  );
  return arrival;
}

export async function openPendingAdminList(
  page: Page,
  pageUrl: string,
  arrival: Promise<undefined>,
): Promise<void> {
  const entry = await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
  expect(entry?.status()).toBe(200);
  await arrival;
  await expect(page.getByRole('status')).toHaveText('加载中…');
  await expect(page.getByRole('table')).toHaveCount(0);
}

export async function failAdminList(page: Page, url: string, message: string): Promise<void> {
  await page.route(
    url,
    (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message }),
      }),
    { times: 1 },
  );
}

export async function expectPlatformLogin(page: Page, baseUrl: string): Promise<void> {
  await expect(page).toHaveURL(`${baseUrl}/_platform/login`);
  await expect(page.getByRole('heading', { name: '登录 DSH 团队平台' })).toBeVisible();
}
