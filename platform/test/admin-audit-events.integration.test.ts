import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { recordAuditEvent } from '../src/audit/index.ts';
import { administrator } from './admin-config-fixture.ts';
import { jsonRequestHeaders, snapshotAuthState } from './auth-fixture.ts';
import { expectUnauthorizedResponse, withListeningApp } from './auth-tcp-fixture.ts';

const PATH = '/_platform/api/admin/audit-events';

it('rejects unauthenticated audit queries before query validation', async () => {
  await withListeningApp(async (base) => {
    const response = await fetch(`${base}/_platform/api/admin/audit-events?page=invalid`);

    await expectUnauthorizedResponse(response);
  });
});

it('filters audit actors or targets, intersects inclusive times and returns stable read-only pages', async () => {
  await withListeningApp(async (base, app, database) => {
    const { cookie } = await administrator(app, database);
    const alice = 'alice@example.com';
    const bob = 'bob@example.com';
    recordAuditEvent(database, { type: 'login.succeeded', createdAt: 1000, actorEmail: alice });
    recordAuditEvent(database, { type: 'login.succeeded', createdAt: 2000, targetEmail: alice });
    recordAuditEvent(database, {
      type: 'login.succeeded',
      createdAt: 2000,
      actorEmail: alice,
      targetEmail: alice,
    });
    recordAuditEvent(database, {
      type: 'account.disabled',
      createdAt: 2000,
      actorEmail: bob,
      targetEmail: bob,
      target: alice,
    });
    recordAuditEvent(database, { type: 'login.succeeded', createdAt: 3000, actorEmail: bob });
    recordAuditEvent(database, {
      type: 'instance.stopped',
      createdAt: 3000,
      targetEmail: alice,
      target: 'user-x',
      sourceAddress: '192.0.2.20',
      details: { reason: 'admin', password: 'private-content' },
    });
    const before = snapshotAuthState(database).audits;
    const headers = { cookie };
    const queries: readonly [string, readonly number[]][] = [
      ['', [7, 6, 5, 4, 3, 2]],
      ['&email=%20ALICE%40EXAMPLE.COM%20', [7, 4, 3, 2]],
      ['&eventType=login.succeeded', [6, 4, 3, 2]],
      ['&email=alice@example.com&eventType=login.succeeded&from=2000&to=2000', [4, 3]],
      ['&pageSize=2&page=1', [7, 6]],
      ['&pageSize=2&page=2', [5, 4]],
      ['&pageSize=2&page=3', [3, 2]],
      ['&pageSize=2&page=4', []],
      ['&email=unknown@example.com', []],
      ['&eventType=unknown', []],
      ['&email=', []],
      ['&from=3000&to=1000', []],
      ['&eventType=%27%20OR%201%3D1%20--', []],
    ];
    for (const [query, ids] of queries) {
      const parameters = new URLSearchParams({ from: '1000', to: '3000' });
      for (const [name, value] of new URLSearchParams(query)) parameters.set(name, value);
      const response = await fetch(`${base}${PATH}?${parameters.toString()}`, { headers });
      expect(response.status).toBe(200);
      // Response.json is untyped; the expected IDs/envelope and generated DTO are asserted here.
      const body = (await response.json()) as {
        items: { id: number }[];
        page: number;
        pageSize: number;
      };
      expect(body.items.map((item) => item.id)).toEqual(ids);
      expect(Object.keys(body).sort()).toEqual(['items', 'page', 'pageSize']);
      expect(body.page).toBe(Number(parameters.get('page') ?? 1));
      expect(body.pageSize).toBe(Number(parameters.get('pageSize') ?? 50));
    }
    const stopped = await fetch(`${base}${PATH}?eventType=instance.stopped`, { headers });
    expect(await stopped.json()).toEqual({
      items: [
        {
          id: 7,
          createdAt: 3000,
          type: 'instance.stopped',
          actorEmail: null,
          targetEmail: alice,
          target: 'user-x',
          sourceAddress: '192.0.2.20',
          details: { reason: 'admin' },
        },
      ],
      page: 1,
      pageSize: 50,
    });
    for (const query of ['page=0', 'page=9007199254740991&pageSize=100', 'from=-1']) {
      const response = await fetch(`${base}${PATH}?${query}`, { headers });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Invalid audit query',
      });
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await fetch(`${base}${PATH}`, {
        method,
        headers: jsonRequestHeaders({ cookie }),
        body: '{}',
      });
      expect(response.status).toBe(404);
      await response.arrayBuffer();
    }
    expect(snapshotAuthState(database).audits).toEqual(before);
  });
});

it.each(['demote', 'disable', 'expire', 'revoke'] as const)(
  'uses current administrator authority before invalid queries after %s',
  async (change) => {
    await withListeningApp(async (base, app, database) => {
      const { user, cookie } = await administrator(app, database);
      const before = snapshotAuthState(database).audits;
      expect((await fetch(`${base}${PATH}`, { headers: { cookie } })).status).toBe(200);
      if (change === 'demote')
        database.prepare("UPDATE users SET role='employee' WHERE id=?").run(user.id);
      else if (change === 'disable')
        database.prepare("UPDATE users SET status='disabled' WHERE id=?").run(user.id);
      else if (change === 'expire')
        database
          .prepare('UPDATE platform_sessions SET last_activity_at=?')
          .run(Date.now() - 8 * 86400000);
      else database.prepare('DELETE FROM platform_sessions').run();

      const response = await fetch(`${base}${PATH}?page=invalid`, {
        headers: { cookie, 'x-user-role': 'admin' },
      });

      expect(response.status).toBe(change === 'demote' ? 403 : 401);
      expect(await response.json()).toEqual({
        statusCode: change === 'demote' ? 403 : 401,
        error: change === 'demote' ? 'Forbidden' : 'Unauthorized',
        message: change === 'demote' ? 'Forbidden' : 'Unauthorized',
      });
      if (change === 'demote') {
        database.prepare("UPDATE users SET role='admin' WHERE id=?").run(user.id);
        const promoted = await fetch(`${base}${PATH}?eventType=absent`, { headers: { cookie } });
        expect(promoted.status).toBe(200);
        expect(await promoted.json()).toEqual({ items: [], page: 1, pageSize: 50 });
      }
      expect(snapshotAuthState(database).audits).toEqual(before);
    });
  },
);

it('returns a safe storage failure over TCP without changing malformed audits or leaking details', async () => {
  await withListeningApp(async (base, app, database, lines) => {
    const { cookie } = await administrator(app, database);
    database.prepare('UPDATE audit_events SET details=?').run('private-corrupt-json');
    const before = snapshotAuthState(database).audits;

    const response = await fetch(`${base}${PATH}`, { headers: { cookie } });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Internal Server Error',
    });
    expect(lines.join('')).toContain('Administrator audit query storage failure');
    expect(lines.join('')).not.toContain('private-corrupt-json');
    expect(snapshotAuthState(database).audits).toEqual(before);
  });
});

function responseFields(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return [];
  const entries: [string, unknown][] = Object.entries(value);
  return entries.flatMap(([key, child]) => [
    ...(key === 'properties' && typeof child === 'object' && child !== null
      ? Object.keys(child)
      : []),
    ...responseFields(child),
  ]);
}

it('declares only audit reads and no administrator employee-content or credential response surface', () => {
  const prefix = '/_platform/api/admin/';
  // This repository-generated artifact has OpenAPI path operations; narrow only the inspected fields.
  const contract = JSON.parse(
    readFileSync(new URL('../../schemas/openapi.json', import.meta.url), 'utf8'),
  ) as { paths: Record<string, Record<string, { responses?: unknown }>> };
  const paths = Object.fromEntries(
    Object.entries(contract.paths).filter(([path]) => path.startsWith(prefix)),
  );
  const audit = paths[PATH];
  expect(audit).toHaveProperty('get');
  expect(
    Object.keys(audit ?? {}).filter((method) => !['get', 'head', 'options'].includes(method)),
  ).toEqual([]);
  for (const [path, methods] of Object.entries(paths)) {
    expect(path).not.toMatch(/\/(?:files|sessions|conversations|messages)(?:\/|$)/i);
    for (const operation of Object.values(methods)) {
      expect(
        responseFields(operation.responses).filter((field) =>
          /password|token|cookie|^apiKey$|fileContent|sessionContent|conversation|^messages$/i.test(
            field,
          ),
        ),
      ).toEqual([]);
    }
  }
});
