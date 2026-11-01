import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { probeModel } from '../src/admin/index.ts';
import { writeSettings } from '../src/db/index.ts';
import type { DatabaseHandle, Settings } from '../src/db/index.ts';
import { modelSnapshot, type ModelSnapshot } from '../src/managed-config/index.ts';
import { jsonRequestHeaders, withApp } from './auth-fixture.ts';
import { registerAccount } from './auth-tcp-fixture.ts';
import { administrator, delayedConfigBody } from './admin-config-fixture.ts';
import { createSession } from '../src/auth/index.ts';
import {
  completionHandler,
  refusedOrigin,
  startModelUpstream,
  UPSTREAM_KEY,
  UPSTREAM_MODEL,
} from './model-upstream-fixture.ts';
import type { ModelUpstream } from './model-upstream-fixture.ts';

const PATH = '/_platform/api/admin/model-config/test';
const MARKER = `owned-upstream-marker-${randomBytes(8).toString('hex')}`;
let upstream: ModelUpstream;

beforeEach(async () => {
  upstream = await startModelUpstream(completionHandler('/v1/chat/completions', MARKER));
});
afterEach(async () => {
  await upstream.close();
});

function save(database: DatabaseHandle, patch: Partial<Settings> = {}): void {
  writeSettings(database, {
    modelBaseUrl: `${upstream.origin}/v1`,
    modelApiKey: UPSTREAM_KEY,
    models: [{ name: 'other' }, { name: UPSTREAM_MODEL }],
    defaultModel: UPSTREAM_MODEL,
    ...patch,
  });
}
async function test(base: string, cookie: string | undefined, init: RequestInit = {}) {
  const response = await fetch(`${base}${PATH}`, {
    method: 'POST',
    headers: jsonRequestHeaders({ cookie }),
    body: '{}',
    ...init,
  });
  return { status: response.status, text: await response.text() };
}
/** Real TCP listener plus administrator session over the in-memory application database. */
async function withAdmin(
  run: (base: string, cookie: string, database: DatabaseHandle, lines: string[]) => Promise<void>,
): Promise<void> {
  await withApp(async (app, database, lines) => {
    const { cookie } = await administrator(app, database);
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    await run(base, cookie, database, lines);
  });
}
function expectNoLeak(output: string, values: readonly string[]): void {
  for (const value of values) expect(output.includes(value)).toBe(false);
}

it('sends exactly one DSH-shaped completion and reports ok without leaking the key or body', async () => {
  await withAdmin(async (base, cookie, database, lines) => {
    save(database);
    const audits = database.prepare('SELECT * FROM audit_events ORDER BY id').all();

    const response = await test(base, cookie);

    expect(response.status).toBe(200);
    const body: unknown = JSON.parse(response.text);
    expect(body).toMatchObject({ result: 'ok', httpStatus: 200 });
    expect(upstream.requests).toHaveLength(1);
    const [received] = upstream.requests;
    expect(received?.method).toBe('POST');
    expect(received?.path).toBe('/v1/chat/completions');
    expect(received?.headers['content-type']).toBe('application/json');
    expect(received?.headers.authorization).toBe(`Bearer ${UPSTREAM_KEY}`);
    expect(JSON.parse(received?.body ?? '')).toEqual({
      model: UPSTREAM_MODEL,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: false,
    });
    const after = database.prepare('SELECT * FROM audit_events ORDER BY id').all();
    expect(after).toEqual(audits);
    expectNoLeak(response.text + lines.join('') + JSON.stringify(after), [
      UPSTREAM_KEY,
      MARKER,
      upstream.origin,
    ]);
  });
});

it.each([
  ['/v1', '/v1/chat/completions'],
  ['/v1/', '/v1/chat/completions'],
  ['/prefix/api', '/prefix/api/chat/completions'],
  ['', '/chat/completions'],
])(
  'appends the completion path to saved address suffix %j exactly as DSH',
  async (suffix, path) => {
    await withAdmin(async (base, cookie, database) => {
      save(database, { modelBaseUrl: `${upstream.origin}${suffix}` });

      const response = await test(base, cookie);

      expect(upstream.requests.map((request) => request.path)).toEqual([path]);
      expect(JSON.parse(response.text)).toMatchObject({
        result: path === '/v1/chat/completions' ? 'ok' : 'not-found',
        httpStatus: path === '/v1/chat/completions' ? 200 : 404,
      });
    });
  },
);

it.each([
  [401, 'unauthorized'],
  [403, 'unauthorized'],
  [404, 'not-found'],
  [400, 'rejected'],
  [429, 'rejected'],
  [500, 'server-error'],
  [502, 'server-error'],
] as const)(
  'classifies upstream HTTP %i as %s without echoing its body',
  async (status, result) => {
    await withAdmin(async (base, cookie, database, lines) => {
      save(database);
      upstream.setHandler((_request, response) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: MARKER } }));
      });

      const response = await test(base, cookie);

      expect(JSON.parse(response.text)).toMatchObject({ result, httpStatus: status });
      expectNoLeak(response.text + lines.join(''), [MARKER, UPSTREAM_KEY, upstream.origin]);
      expect(lines.join('')).toContain(`"result":"${result}"`);
    });
  },
);

it('reports a wrong saved key as unauthorized', async () => {
  await withAdmin(async (base, cookie, database) => {
    save(database, { modelApiKey: 'wrong-owned-key' });

    expect(JSON.parse((await test(base, cookie)).text)).toMatchObject({
      result: 'unauthorized',
      httpStatus: 401,
    });
  });
});

it('does not follow a redirect and never reaches its target', async () => {
  await withAdmin(async (base, cookie, database) => {
    save(database);
    upstream.setHandler((request, response, socket) => {
      if (request.path === '/target/chat/completions') {
        completionHandler('/target/chat/completions')(request, response, socket);
        return;
      }
      response.writeHead(307, { location: `${upstream.origin}/target/chat/completions` });
      response.end();
    });

    const response = await test(base, cookie);

    expect(JSON.parse(response.text)).toMatchObject({ result: 'bad-response', httpStatus: 307 });
    expect(upstream.requests.map((request) => request.path)).toEqual(['/v1/chat/completions']);
  });
});

it.each([
  ['non-JSON', 'not a completion'],
  ['choices-less JSON', JSON.stringify({ data: [], marker: MARKER })],
  ['64 KiB plus one byte', `{"choices":[],"p":"${'x'.repeat(65_537 - 21)}"}`],
])('classifies a 2xx %s body as bad-response', async (_label, body) => {
  await withAdmin(async (base, cookie, database, lines) => {
    save(database);
    upstream.setHandler((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(body);
    });

    const response = await test(base, cookie);

    expect(JSON.parse(response.text)).toMatchObject({ result: 'bad-response', httpStatus: 200 });
    expectNoLeak(response.text + lines.join(''), [MARKER]);
  });
});

it('accepts a completion body of exactly 64 KiB', async () => {
  await withAdmin(async (base, cookie, database) => {
    save(database);
    const body = `{"choices":[],"p":"${'x'.repeat(65_536 - 21)}"}`;
    expect(Buffer.byteLength(body)).toBe(65_536);
    upstream.setHandler((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(body);
    });

    expect(JSON.parse((await test(base, cookie)).text)).toMatchObject({ result: 'ok' });
  });
});

it('reports a refused port as unreachable without disclosing its address', async () => {
  const refused = await refusedOrigin();
  await withAdmin(async (base, cookie, database, lines) => {
    save(database, { modelBaseUrl: `${refused}/v1` });

    const response = await test(base, cookie);

    expect(JSON.parse(response.text)).toMatchObject({ result: 'unreachable', httpStatus: null });
    expectNoLeak(response.text + lines.join(''), [refused, refused.replace('http://', '')]);
  });
});

it('reports a connection reset after the status as unreachable with that status', async () => {
  await withAdmin(async (base, cookie, database) => {
    save(database);
    upstream.setHandler((_request, response, socket) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"choices":');
      setTimeout(() => socket.destroy(), 20);
    });

    expect(JSON.parse((await test(base, cookie)).text)).toMatchObject({
      result: 'unreachable',
      httpStatus: 200,
    });
  });
});

it.each<[string, Partial<Settings>]>([
  ['invalid-address', { modelBaseUrl: 'www.dmxapi.cn/v1' }],
  ['invalid-address', { modelBaseUrl: 'ftp://127.0.0.1/v1' }],
  ['invalid-key', { modelApiKey: `${UPSTREAM_KEY}\r\nX-Injected: 1` }],
  ['unconfigured', { modelApiKey: '' }],
  ['unconfigured', { models: [], defaultModel: '' }],
])('returns %s with zero upstream requests for %j', async (result, patch) => {
  await withAdmin(async (base, cookie, database, lines) => {
    save(database, patch);

    const response = await test(base, cookie);

    expect(JSON.parse(response.text)).toEqual({ result, httpStatus: null, elapsedMs: 0 });
    expect(upstream.requests).toEqual([]);
    expectNoLeak(response.text + lines.join(''), [UPSTREAM_KEY, 'www.dmxapi.cn']);
  });
});

it('reaches the deadline before and after the status at the probe seam', async () => {
  const snapshot: ModelSnapshot = modelSnapshot({
    idleMinutes: 30,
    cpuCores: 2,
    memoryMiB: 4096,
    maxRunningInstances: 60,
    defaultPermissionTier: 'yolo',
    models: [{ name: UPSTREAM_MODEL }],
    modelBaseUrl: `${upstream.origin}/v1`,
    modelApiKey: UPSTREAM_KEY,
    defaultModel: UPSTREAM_MODEL,
    pluginCatalog: {},
    pluginRegistries: ['https://registry.npmjs.org/', 'https://registry.npmmirror.com/'],
    registryProbeEnabled: true,
    webToolsEnabled: false,
  });
  upstream.setHandler(() => undefined);
  const silent = await probeModel(snapshot, new AbortController().signal, 150);
  upstream.setHandler((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"choices":');
  });
  const stalled = await probeModel(snapshot, new AbortController().signal, 150);

  expect(silent).toMatchObject({ result: 'timeout', httpStatus: null });
  expect(stalled).toMatchObject({ result: 'timeout', httpStatus: 200 });
  expect(silent.elapsedMs).toBeGreaterThanOrEqual(100);
  await upstream.socketClosed(1);
  await upstream.socketClosed(2);
});

it('rejects anonymous, employee, wrong-body and wrong-media requests without contacting the model', async () => {
  await withApp(async (app, database) => {
    const { cookie } = await administrator(app, database);
    const employee = await registerAccount(app, 'employee@example.com');
    const employeeCookie = `platform_session=${createSession(database, employee.id, Date.now())}`;
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    save(database);

    const statuses = [
      (await test(base, undefined)).status,
      (await test(base, employeeCookie)).status,
      (await test(base, cookie, { body: '{"baseURL":"x"}' })).status,
      (
        await test(base, cookie, {
          headers: { ...jsonRequestHeaders({ cookie }), 'content-type': 'text/plain' },
        })
      ).status,
      (await test(base, cookie, { headers: { cookie, 'content-type': 'application/json' } }))
        .status,
    ];

    expect(statuses).toEqual([401, 403, 400, 415, 403]);
    expect(upstream.requests).toEqual([]);
  });
});

it.each(['revoked', 'demoted'] as const)(
  'rechecks the administrator after a delayed body: %s makes no upstream request',
  async (state) => {
    await withApp(async (app, database) => {
      const send = delayedConfigBody(app, PATH, 'POST');
      const { user, cookie } = await administrator(app, database);
      const base = await app.listen({ host: '127.0.0.1', port: 0 });
      save(database);

      const response = await send(base, cookie, '{}', () => {
        if (state === 'revoked')
          database.prepare('DELETE FROM platform_sessions WHERE user_id=?').run(user.id);
        else database.prepare("UPDATE users SET role='employee' WHERE id=?").run(user.id);
      });

      expect(response.status).toBe(state === 'revoked' ? 401 : 403);
      expect(upstream.requests).toEqual([]);
    });
  },
);

it('aborts the upstream request promptly when the administrator disconnects', async () => {
  await withAdmin(async (base, cookie, database) => {
    save(database);
    upstream.setHandler(() => undefined);
    const client = httpRequest(`${base}${PATH}`, {
      method: 'POST',
      headers: jsonRequestHeaders({ cookie }),
    });
    client.on('error', () => undefined);
    client.end('{}');
    await upstream.received(1);
    const started = performance.now();

    client.destroy();
    await upstream.socketClosed(1);

    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

it('runs concurrent tests independently', async () => {
  await withAdmin(async (base, cookie, database) => {
    save(database);
    const held = Promise.withResolvers<undefined>();
    upstream.setHandler((request, response, socket) => {
      void held.promise.then(() => {
        completionHandler()(request, response, socket);
      });
    });

    const both = Promise.all([test(base, cookie), test(base, cookie)]);
    await upstream.received(2);
    held.resolve(undefined);
    const results = await both;

    expect(results.map((result) => JSON.parse(result.text) as unknown)).toMatchObject([
      { result: 'ok' },
      { result: 'ok' },
    ]);
  });
});

it('application close aborts an in-flight test without waiting for the deadline', async () => {
  await withApp(async (app, database, lines) => {
    const { cookie } = await administrator(app, database);
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    save(database);
    upstream.setHandler(() => undefined);
    const pending = test(base, cookie);
    await upstream.received(1);
    const started = performance.now();

    await app.close();
    const response = await pending;
    await upstream.socketClosed(1);

    expect(performance.now() - started).toBeLessThan(5_000);
    expect(response.status).toBe(500);
    expectNoLeak(response.text + lines.join(''), [UPSTREAM_KEY, upstream.origin]);
  });
});
