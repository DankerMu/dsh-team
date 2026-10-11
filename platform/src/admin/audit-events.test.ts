import { expect, it } from 'vitest';
import { administrator } from '../../test/admin-config-fixture.ts';
import { snapshotAuthState, withApp } from '../../test/auth-fixture.ts';
import { recordAuditEvent } from '../audit/index.ts';

const PATH = '/_platform/api/admin/audit-events';
const INVALID = { statusCode: 400, error: 'Bad Request', message: 'Invalid audit query' };
const FAILURE = {
  statusCode: 500,
  error: 'Internal Server Error',
  message: 'Internal Server Error',
};

it.each([
  'page=0',
  'page=-1',
  'page=1.5',
  'page=9007199254740992',
  'page=no',
  'pageSize=0',
  'pageSize=101',
  'pageSize=1.5',
  'page=9007199254740991&pageSize=100',
  'eventType=',
  `eventType=${'x'.repeat(129)}`,
  `email=${'x'.repeat(255)}`,
  'from=-1',
  'to=-1',
  'from=1.5',
  'to=no',
  'from=9007199254740992',
  'to=9007199254740992',
  'page=1&page=2',
])('rejects invalid audit filter %s without changing audits or echoing input', async (query) => {
  await withApp(async (app, database) => {
    const { cookie } = await administrator(app, database);
    const before = snapshotAuthState(database).audits;

    const response = await app.inject({ url: `${PATH}?${query}`, headers: { cookie } });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(INVALID);
    expect(snapshotAuthState(database).audits).toEqual(before);
  });
});

it('accepts safe boundary values and preserves an explicitly empty email filter', async () => {
  await withApp(async (app, database) => {
    const { cookie } = await administrator(app, database);
    recordAuditEvent(database, { type: 'login.failed', createdAt: 0, actorEmail: '' });
    for (const query of [
      'page=9007199254740991&pageSize=1',
      `pageSize=100&eventType=${'x'.repeat(128)}&email=${'x'.repeat(254)}&from=0&to=9007199254740991`,
    ]) {
      const response = await app.inject({ url: `${PATH}?${query}`, headers: { cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ items: [] });
    }
    const response = await app.inject({ url: `${PATH}?email=%20%20`, headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        {
          id: 2,
          createdAt: 0,
          type: 'login.failed',
          actorEmail: '',
          targetEmail: null,
          target: null,
          sourceAddress: null,
          details: {},
        },
      ],
      page: 1,
      pageSize: 50,
    });
  });
});

const DETAILS_CASES: readonly [string, { reason?: string }][] = [
  ['null', {}],
  ['[]', {}],
  ['"private-content"', {}],
  ['{"password":"private-content"}', {}],
  ...['idle', 'admin', 'disabled', 'error'].map((reason): [string, { reason: string }] => [
    JSON.stringify({ reason, password: 'private-content' }),
    { reason },
  ]),
];
it.each(DETAILS_CASES)(
  'publishes only a validated stop reason from stored details %s',
  async (details, expected) => {
    await withApp(async (app, database) => {
      const { cookie } = await administrator(app, database);
      database.prepare('UPDATE audit_events SET details=?').run(details);
      const before = snapshotAuthState(database).audits;

      const response = await app.inject({ url: PATH, headers: { cookie } });

      expect(response.statusCode).toBe(200);
      expect(
        response.json<{ items: { details: unknown }[] }>().items.map((item) => item.details),
      ).toEqual([expected]);
      expect(response.body).not.toContain('private-content');
      expect(snapshotAuthState(database).audits).toEqual(before);
    });
  },
);

it.each(['private-content', '{"reason":"private-content"}', '{"reason":null}', 'storage'])(
  'fails safely for corrupt audit details or storage: %s',
  async (details) => {
    await withApp(async (app, database, lines) => {
      const { cookie } = await administrator(app, database);
      if (details === 'storage')
        database.exec('ALTER TABLE audit_events RENAME COLUMN details TO private_column');
      else database.prepare('UPDATE audit_events SET details=?').run(details);
      const before = snapshotAuthState(database).audits;

      const response = await app.inject({ url: PATH, headers: { cookie } });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual(FAILURE);
      expect(snapshotAuthState(database).audits).toEqual(before);
      expect(lines.join('')).toContain('Administrator audit query storage failure');
      for (const secret of [
        'private-content',
        'private_column',
        'SQLITE',
        'no such column',
        cookie,
      ])
        expect(response.body + lines.join('')).not.toContain(secret);
    });
  },
);
