import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { performance } from 'node:perf_hooks';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { writeSettings } from '../src/db/index.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import { testRagflowConnection } from '../src/ragflow-proxy/index.ts';
import { jsonRequestHeaders, withApp } from './auth-fixture.ts';
import { administrator, delayedConfigBody, settingsRows } from './admin-config-fixture.ts';
import { refusedOrigin, startModelUpstream } from './model-upstream-fixture.ts';
import type { ModelUpstream } from './model-upstream-fixture.ts';

const PATH = '/_platform/api/admin/ragflow-config/test';
const VERSION_PATH = '/api/v1/system/version';
const MODELS_PATH = '/api/v1/users/me/models';
const RAGFLOW_KEY = `owned-ragflow-key-${randomBytes(8).toString('hex')}`;
const MARKER = `owned-upstream-marker-${randomBytes(8).toString('hex')}`;
type Handler = Parameters<ModelUpstream['setHandler']>[0];
let upstream: ModelUpstream;
let texts: string[];

/** Answers like RAGFlow v1.0.0-rc2: open version endpoint, bearer-checked tenant models. */
function ragflowHandler(version: Record<string, unknown> = { data: 'v1.0.0-rc2' }): Handler {
  return (request, response) => {
    const answer = (status: number, body: Record<string, unknown>) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: MARKER, ...body }));
    };
    if (request.method === 'GET' && request.path === VERSION_PATH)
      answer(200, { code: 0, ...version });
    else if (request.method !== 'GET' || request.path !== MODELS_PATH) answer(404, { code: 404 });
    else if (request.headers.authorization !== `Bearer ${RAGFLOW_KEY}`)
      answer(401, { code: 401, data: null });
    else
      answer(200, {
        code: 0,
        data: {
          tenant_id: MARKER,
          name: MARKER,
          llm_id: MARKER,
          parser_ids: MARKER,
          role: 'owner',
        },
      });
  };
}

beforeEach(async () => {
  texts = [];
  upstream = await startModelUpstream(ragflowHandler());
});
afterEach(async () => {
  await upstream.close();
});

async function test(base: string, cookie: string) {
  const response = await fetch(`${base}${PATH}`, {
    method: 'POST',
    headers: jsonRequestHeaders({ cookie }),
    body: '{}',
  });
  const text = await response.text();
  texts.push(text);
  return { status: response.status, text };
}
function snapshot(database: DatabaseHandle) {
  return {
    settings: settingsRows(database),
    audits: database.prepare('SELECT * FROM audit_events ORDER BY id').all(),
  };
}
function expectNoLeak(output: string, values: readonly string[]): void {
  for (const value of values) expect(output.includes(value)).toBe(false);
}
interface Admin {
  readonly base: string;
  readonly cookie: string;
  readonly userId: string;
  readonly app: FastifyInstance;
  readonly database: DatabaseHandle;
}
/**
 * Real TCP listener and administrator over saved RAGFlow settings. Afterwards settings and audit
 * rows are unchanged and neither responses nor logs carry the address, key or upstream text.
 */
async function withAdmin(
  run: (admin: Admin) => Promise<void>,
  options: {
    baseURL?: string;
    apiKey?: string;
    beforeAdmission?: (app: FastifyInstance) => void;
  } = {},
): Promise<void> {
  await withApp(async (app, database, lines) => {
    // The application closes its database; a case that closes it is compared at preClose.
    let closing: ReturnType<typeof snapshot> | undefined;
    app.addHook('preClose', (done) => {
      closing ??= snapshot(database);
      done();
    });
    options.beforeAdmission?.(app);
    const { user, cookie } = await administrator(app, database);
    const baseURL = options.baseURL ?? `${upstream.origin}/`;
    const apiKey = options.apiKey ?? RAGFLOW_KEY;
    writeSettings(database, { ragflowBaseUrl: baseURL, ragflowApiKey: apiKey });
    const before = snapshot(database);
    const base = await app.listen({ host: '127.0.0.1', port: 0 });

    await run({ base, cookie, userId: user.id, app, database });

    expect(closing ?? snapshot(database)).toEqual(before);
    const authority = new URL(baseURL).host;
    expectNoLeak(texts.join('') + lines.join(''), [apiKey, RAGFLOW_KEY, MARKER, authority]);
  });
}
function result(text: string): unknown {
  return JSON.parse(text);
}

it("reads the version without the key, then the key's tenant models with it", async () => {
  await withAdmin(async ({ base, cookie }) => {
    const response = await test(base, cookie);

    expect([response.status, result(response.text)]).toEqual([
      200,
      { result: 'ok', version: 'v1.0.0-rc2' },
    ]);
    expect(upstream.requests.map(({ method, path }) => [method, path])).toEqual([
      ['GET', VERSION_PATH],
      ['GET', MODELS_PATH],
    ]);
    expect(upstream.requests[0]?.headers.authorization).toBeUndefined();
    expect(upstream.requests[1]?.headers.authorization).toBe(`Bearer ${RAGFLOW_KEY}`);
  });
});

it.each([
  ['missing', {}],
  ['not a string', { data: 102 }],
  ['longer than 64 characters', { data: `v${'1'.repeat(64)}` }],
])('reports a version that is %s as upstream-error after one request', async (_label, version) => {
  upstream.setHandler(ragflowHandler(version));
  await withAdmin(async ({ base, cookie }) => {
    const response = await test(base, cookie);

    expect(result(response.text)).toEqual({ result: 'upstream-error' });
    expect(upstream.requests.map(({ path }) => path)).toEqual([VERSION_PATH]);
  });
});

it('reports HTTP 200 with a non-zero code as upstream-error', async () => {
  upstream.setHandler((request, response, socket) => {
    if (request.path !== MODELS_PATH) {
      ragflowHandler()(request, response, socket);
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ code: 102, data: false, message: MARKER }));
  });
  await withAdmin(async ({ base, cookie }) => {
    const response = await test(base, cookie);

    expect(result(response.text)).toEqual({ result: 'upstream-error' });
    expect(upstream.requests).toHaveLength(2);
  });
});

it('reports a rejected saved key as not-configured', async () => {
  const wrong = `wrong-owned-key-${randomBytes(8).toString('hex')}`;
  await withAdmin(
    async ({ base, cookie }) => {
      const response = await test(base, cookie);

      expect(result(response.text)).toEqual({ result: 'not-configured' });
      expect(upstream.requests[1]?.headers.authorization).toBe(`Bearer ${wrong}`);
    },
    { apiKey: wrong },
  );
});

it('reports a refused port as unavailable', async () => {
  const refused = await refusedOrigin();
  await withAdmin(
    async ({ base, cookie }) => {
      const response = await test(base, cookie);

      expect(result(response.text)).toEqual({ result: 'unavailable' });
    },
    { baseURL: refused },
  );
});

it('does not follow a redirect and never reaches its target', async () => {
  const target = await startModelUpstream(ragflowHandler());
  try {
    upstream.setHandler((_request, response) => {
      response.writeHead(302, { location: `${target.origin}${VERSION_PATH}` });
      response.end(MARKER);
    });
    await withAdmin(async ({ base, cookie }) => {
      const response = await test(base, cookie);

      expect(result(response.text)).toEqual({ result: 'upstream-error' });
      expect(upstream.requests).toHaveLength(1);
      expect(target.requests).toEqual([]);
      expectNoLeak(response.text, [target.origin.replace('http://', '')]);
    });
  } finally {
    await target.close();
  }
});

it('reaches the per-request deadline before a status and while the key body stalls', async () => {
  const settings = { baseURL: upstream.origin, apiKey: RAGFLOW_KEY };
  upstream.setHandler(() => undefined);
  const silent = await testRagflowConnection(settings, new AbortController().signal, 200);
  await upstream.socketClosed(1);
  upstream.setHandler((request, response, socket) => {
    if (request.path !== MODELS_PATH) {
      ragflowHandler()(request, response, socket);
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"code":0,');
  });
  const stalled = await testRagflowConnection(settings, new AbortController().signal, 200);

  expect(silent).toEqual({ result: 'timeout' });
  expect(stalled).toEqual({ result: 'timeout' });
  expect(upstream.requests.map(({ path }) => path)).toEqual([
    VERSION_PATH,
    VERSION_PATH,
    MODELS_PATH,
  ]);
  await upstream.socketClosed(3);
});

it.each(['revoked', 'demoted'] as const)(
  'rechecks the administrator after a delayed body: %s makes no upstream request',
  async (state) => {
    let send: ReturnType<typeof delayedConfigBody> | undefined;
    await withAdmin(
      async ({ base, cookie, userId, database }) => {
        const response = await send?.(base, cookie, '{}', () => {
          if (state === 'revoked')
            database.prepare('DELETE FROM platform_sessions WHERE user_id=?').run(userId);
          else database.prepare("UPDATE users SET role='employee' WHERE id=?").run(userId);
        });
        texts.push(response?.body ?? '');

        expect(response?.status).toBe(state === 'revoked' ? 401 : 403);
        expect(upstream.requests).toEqual([]);
      },
      {
        beforeAdmission: (app) => {
          send = delayedConfigBody(app, PATH, 'POST');
        },
      },
    );
  },
);

it('aborts the upstream request promptly when the administrator disconnects', async () => {
  upstream.setHandler(() => undefined);
  await withAdmin(async ({ base, cookie }) => {
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

it('application close aborts an in-flight test with the fixed 500', async () => {
  upstream.setHandler(() => undefined);
  await withAdmin(async ({ base, cookie, app }) => {
    const pending = test(base, cookie);
    await upstream.received(1);
    const started = performance.now();

    await app.close();
    const response = await pending;
    await upstream.socketClosed(1);

    expect(performance.now() - started).toBeLessThan(5_000);
    expect([response.status, result(response.text)]).toEqual([
      500,
      { statusCode: 500, error: 'Internal Server Error', message: 'Internal Server Error' },
    ]);
  });
});
