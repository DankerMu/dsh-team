import { expect, it } from 'vitest';
import { deleteUserSessions } from '../auth/index.ts';
import { withApp } from '../../test/auth-fixture.ts';
import { administrator } from '../../test/admin-config-fixture.ts';

const PATH = '/_platform/api/admin/users';
const INSTANCES_PATH = '/_platform/api/admin/instances';

it.each(
  [PATH, INSTANCES_PATH].flatMap((path) =>
    (['demoted', 'disabled', 'expired', 'revoked'] as const).map((state) => ({ path, state })),
  ),
)(
  'rejects a previously authorized administrator at $path after $state without caching authority',
  async ({ path, state }) => {
    await withApp(async (app, database) => {
      const { user, cookie } = await administrator(app, database);
      expect((await app.inject({ url: path, headers: { cookie } })).statusCode).toBe(200);
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
        url: `${path}?page=invalid&role=admin`,
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

it.each(
  [PATH, INSTANCES_PATH].flatMap((path) =>
    ['session', 'query'].map((boundary) => ({ path, boundary })),
  ),
)(
  'fails closed without database details at $path when administrator $boundary storage fails',
  async ({ path, boundary }) => {
    await withApp(async (app, database, lines) => {
      const { cookie } = await administrator(app, database);
      if (boundary === 'session') database.exec('DROP TABLE platform_sessions');
      else database.exec('ALTER TABLE users RENAME COLUMN created_at TO unavailable_column');

      const response = await app.inject({ url: path, headers: { cookie } });

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
          : path === PATH
            ? 'Administrator account query storage failure'
            : 'Administrator instance query storage failure',
      );
    });
  },
);

it('reads fresh persisted instance history on every administrator request', async () => {
  await withApp(async (app, database) => {
    const { user, cookie } = await administrator(app, database);
    const item = {
      userId: user.id,
      email: user.email,
      status: 'not-created',
      lastStartedAt: null,
      lastActivityAt: null,
      lastError: null,
    };
    const missing = await app.inject({ url: INSTANCES_PATH, headers: { cookie } });
    expect(missing.statusCode).toBe(200);
    expect(missing.json()).toEqual({ items: [item] });
    database
      .prepare(
        "INSERT INTO instances(user_id,status,last_started_at,last_activity_at,last_error) VALUES (?,'stopped',1700000000123,1700000000456,'Previous readiness failure')",
      )
      .run(user.id);
    const stopped = await app.inject({ url: INSTANCES_PATH, headers: { cookie } });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toEqual({
      items: [
        {
          ...item,
          status: 'stopped',
          lastStartedAt: 1700000000123,
          lastActivityAt: 1700000000456,
          lastError: 'Previous readiness failure',
        },
      ],
    });
    database
      .prepare(
        "UPDATE instances SET status = 'running', last_activity_at = 1700000000789, last_error = NULL",
      )
      .run();

    const running = await app.inject({ url: INSTANCES_PATH, headers: { cookie } });

    expect(running.statusCode).toBe(200);
    expect(running.json()).toEqual({
      items: [
        {
          ...item,
          status: 'running',
          lastStartedAt: 1700000000123,
          lastActivityAt: 1700000000789,
        },
      ],
    });
  });
});
