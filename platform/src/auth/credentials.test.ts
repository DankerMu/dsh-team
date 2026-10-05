import type { LightMyRequestResponse } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  cookieHeaders,
  injectLogin,
  injectRegister,
  tableCounts,
  withApp,
} from '../../test/auth-fixture.ts';
import { queryAuditEvents } from '../audit/index.ts';
import type { DatabaseHandle } from '../db/index.ts';

const PASSWORD = 'passw0rd';
const ASTRAL = '😀';

function expectRejected(
  response: LightMyRequestResponse,
  database: DatabaseHandle,
  lines: readonly string[],
  secrets: readonly string[],
): void {
  expect(response.statusCode).toBe(400);
  // JSON.parse is typed as any; the HTTP body is JSON text.
  const parsed = JSON.parse(response.body) as unknown;
  expect(parsed).toMatchObject({ statusCode: 400 });
  expect(cookieHeaders(response)).toEqual([]);
  expect(tableCounts(database)).toEqual({
    users: 0,
    sessions: 0,
    audits: 0,
  });
  const written = `${response.body}${lines.join('')}`;
  for (const secret of secrets) {
    expect(written).not.toContain(secret);
  }
}

describe('POST /_platform/api/register input boundaries', () => {
  it.each([
    ['numeric email', { email: 123, password: PASSWORD }, [PASSWORD]],
    ['numeric password', { email: 'numpass@example.com', password: 123456 }, ['123456']],
    ['array email', { email: ['a@b.com'], password: PASSWORD }, [PASSWORD]],
    ['array password', { email: 'arrpass@example.com', password: ['passw0rd'] }, [PASSWORD]],
    ['null email', { email: null, password: PASSWORD }, [PASSWORD]],
    ['null password', { email: 'nullpass@example.com', password: null }, []],
    ['object email', { email: { local: 'user' }, password: PASSWORD }, [PASSWORD]],
    ['object password', { email: 'objpass@example.com', password: { secret: 'x' } }, []],
  ] as const)(
    'rejects %s before coercion with 400 and no persisted rows',
    async (_label, payload, secrets) => {
      await withApp(async (app, database, lines) => {
        expectRejected(await injectRegister(app, payload), database, lines, secrets);
      });
    },
  );

  it.each([
    ['missing @', 'not-an-email'],
    ['empty local', '@example.com'],
    ['empty domain', 'user@'],
    ['multiple @', 'a@b@c.com'],
    ['internal space', 'user @example.com'],
  ] as const)('rejects an email with %s as 400 and creates no account', async (_label, email) => {
    await withApp(async (app, database, lines) => {
      expectRejected(await injectRegister(app, { email, password: PASSWORD }), database, lines, [
        PASSWORD,
      ]);
    });
  });

  it.each([
    ['5 ASCII', '12345'],
    ['257 ASCII', 'z'.repeat(257)],
    ['5 Unicode', ASTRAL.repeat(5)],
    ['257 Unicode', ASTRAL.repeat(257)],
  ] as const)(
    'rejects a %s password as 400 without creating an account',
    async (_label, password) => {
      await withApp(async (app, database, lines) => {
        expectRejected(
          await injectRegister(app, { email: 'bound@example.com', password }),
          database,
          lines,
          [password],
        );
      });
    },
  );

  it.each([
    ['6 ASCII', 'ok6ascii@example.com', '123456'],
    ['256 ASCII', 'ok256ascii@example.com', 'z'.repeat(256)],
    ['6 Unicode', 'ok6unicode@example.com', ASTRAL.repeat(6)],
    ['256 Unicode', 'ok256unicode@example.com', ASTRAL.repeat(256)],
  ] as const)('accepts a %s password and creates one employee', async (_label, email, password) => {
    await withApp(async (app, database) => {
      const response = await injectRegister(app, { email, password });
      expect(response.statusCode).toBe(201);
      expect(cookieHeaders(response)).toHaveLength(1);
      expect(tableCounts(database)).toEqual({ users: 1, sessions: 1, audits: 1 });
    });
  });
});

describe('POST /_platform/api/login input boundaries', () => {
  it('rejects a numeric password before coercion with 400 and no persisted rows', async () => {
    await withApp(async (app, database, lines) => {
      expectRejected(
        await injectLogin(app, { email: 'numpass@example.com', password: 123456 }),
        database,
        lines,
        ['123456'],
      );
    });
  });

  it('rejects an email with missing @ as 400 and writes no login.failed audit', async () => {
    await withApp(async (app, database, lines) => {
      expectRejected(
        await injectLogin(app, { email: 'not-an-email', password: PASSWORD }),
        database,
        lines,
        [PASSWORD],
      );
      expect(
        queryAuditEvents(database, { page: 1, pageSize: 10, eventType: 'login.failed' }),
      ).toEqual([]);
    });
  });
});
