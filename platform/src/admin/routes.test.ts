import { expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DatabaseHandle } from '../db/index.ts';
import { createSession, deleteUserSessions } from '../auth/index.ts';
import { withApp } from '../../test/auth-fixture.ts';
import { registerAccount } from '../../test/auth-tcp-fixture.ts';

const PATH = '/_platform/api/admin/users';
async function administrator(app: FastifyInstance, database: DatabaseHandle) {
  const user = await registerAccount(app, 'admin@example.com');
  database.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
  const cookie = `platform_session=${createSession(database, user.id, Date.now())}`;
  return { user, cookie };
}

it.each(['demoted', 'disabled', 'expired', 'revoked'] as const)(
  'rejects a previously authorized administrator after %s without caching authority',
  async (state) => {
    await withApp(async (app, database) => {
      const { user, cookie } = await administrator(app, database);
      expect((await app.inject({ url: PATH, headers: { cookie } })).statusCode).toBe(200);
      if (state === 'demoted')
        database.prepare("UPDATE users SET role = 'employee' WHERE id = ?").run(user.id);
      else if (state === 'disabled')
        database.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(user.id);
      else if (state === 'expired')
        database
          .prepare('UPDATE platform_sessions SET last_activity_at = ?')
          .run(Date.now() - 8 * 86400000);
      else deleteUserSessions(database, user.id);

      const response = await app.inject({
        url: `${PATH}?page=invalid&role=admin`,
        headers: { cookie, 'x-user-role': 'admin' },
      });

      expect(response.statusCode).toBe(state === 'demoted' ? 403 : 401);
      expect(response.json()).toMatchObject({ statusCode: response.statusCode });
      expect((await app.inject('/healthz')).statusCode).toBe(200);
    });
  },
);

it.each([
  'page=0',
  'page=1.5',
  'page=9007199254740992',
  'pageSize=101',
  'pageSize=0',
  'page=9007199254740991&pageSize=100',
  `search=${'x'.repeat(255)}`,
])('rejects invalid administrator pagination or search: %s', async (query) => {
  await withApp(async (app, database) => {
    const { cookie } = await administrator(app, database);

    const response = await app.inject({ url: `${PATH}?${query}`, headers: { cookie } });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ statusCode: 400 });
  });
});

it.each(['session', 'query'])(
  'fails closed without database details when administrator %s storage fails',
  async (boundary) => {
    await withApp(async (app, database, lines) => {
      const { cookie } = await administrator(app, database);
      if (boundary === 'session') database.exec('DROP TABLE platform_sessions');
      else database.exec('ALTER TABLE users RENAME COLUMN created_at TO unavailable_column');

      const response = await app.inject({ url: PATH, headers: { cookie } });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        statusCode: 500,
        error: 'Internal Server Error',
        message: 'Internal Server Error',
      });
      const output = response.body + lines.join('');
      for (const privateValue of [cookie, 'no such table', 'no such column', 'unavailable_column'])
        expect(output.includes(privateValue)).toBe(false);
      expect(lines.join('')).toContain(
        boundary === 'session'
          ? 'Administrator authorization storage failure'
          : 'Administrator account query storage failure',
      );
    });
  },
);
