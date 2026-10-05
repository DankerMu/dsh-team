import type * as NodeCrypto from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { cryptoBarrier } from './auth-crypto-fixture.ts';
import {
  PASSWORD,
  postJson,
  registerAccount,
  successfulLogin,
  withListeningApp,
} from './auth-tcp-fixture.ts';
import {
  EMAIL,
  expectGuardRejection,
  rejectedMutationRequests,
  sendRejectedRequest,
} from './origin-fixture.ts';
import {
  BACKDATE_ACTIVITY,
  NEW_PASSWORD,
  snapshotPasswordState,
} from './password-change-fixture.ts';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>();
  // Static imports are not initialized when Vitest executes this hoisted mock factory.
  const { controlledScrypt } = await import('./auth-crypto-fixture.ts');
  return { ...actual, scrypt: controlledScrypt(actual.scrypt) };
});

afterAll(() => {
  vi.doUnmock('node:crypto');
});

describe('Origin guard before real password derivation over TCP', () => {
  it('rejects all mutation guard failures before crypto while permitted credential flows derive normally', async () => {
    await withListeningApp(async (baseUrl, app, database) => {
      await registerAccount(app, EMAIL);
      const login = await successfulLogin(baseUrl, EMAIL);
      const cookie = `platform_session=${login.token}`;
      database.exec(BACKDATE_ACTIVITY);
      const before = snapshotPasswordState(database);
      const baseline = cryptoBarrier.calls;

      for (const testCase of rejectedMutationRequests(cookie)) {
        const response = await sendRejectedRequest(baseUrl, testCase);
        await expectGuardRejection(response, database, before, testCase.status, testCase.label);
        expect(cryptoBarrier.calls, testCase.label).toBe(baseline);
      }
      const registered = await postJson(`${baseUrl}/_platform/api/register`, {
        email: 'fresh@example.com',
        password: PASSWORD,
      });
      expect(registered.status).toBe(201);
      expect(await registered.json()).toMatchObject({
        email: 'fresh@example.com',
        role: 'employee',
      });
      expect(cryptoBarrier.calls).toBe(baseline + 1);
      const permittedLogin = await postJson(`${baseUrl}/_platform/api/login`, {
        email: EMAIL,
        password: PASSWORD,
      });
      expect(permittedLogin.status).toBe(200);
      expect(await permittedLogin.json()).toMatchObject({ email: EMAIL, role: 'employee' });
      expect(cryptoBarrier.calls).toBe(baseline + 2);
      const changed = await postJson(
        `${baseUrl}/_platform/api/change-password`,
        {
          currentPassword: PASSWORD,
          newPassword: NEW_PASSWORD,
        },
        { cookie },
      );
      expect(changed.status).toBe(204);
      expect(await changed.text()).toBe('');
      expect(cryptoBarrier.calls).toBe(baseline + 4);
    });
  });
});
