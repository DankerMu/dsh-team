import { expect, type APIRequestContext, type Page } from '@playwright/test';
import type { DatabaseHandle } from '../src/db/index.ts';
import { readPublicIdentity } from './auth-fixture.ts';

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
