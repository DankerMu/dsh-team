import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, expect, it } from 'vitest';
import { createSession, createSourceAddressResolver } from '../src/auth/index.ts';
import type { PlatformConfig } from '../src/config.ts';
import { writeSettings } from '../src/db/index.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import type { GatewayUpstreamResolver } from '../src/gateway/index.ts';
import { withApp } from './auth-fixture.ts';
import { rejectedUpgrade } from './gateway-http-fixture.ts';
import { instanceToken, instanceTokenHash, seedInstance } from './instance-token-fixture.ts';
import { startModelUpstream } from './model-upstream-fixture.ts';
import type { ModelUpstream } from './model-upstream-fixture.ts';

const PREFIX = '/_platform/instance-api/ragflow';
const VERSION = `${PREFIX}/version`;
const RAGFLOW_VERSION_PATH = '/api/v1/system/version';
const RAGFLOW_KEY = `owned-ragflow-key-${randomBytes(8).toString('hex')}`;
const MARKER = `owned-upstream-marker-${randomBytes(8).toString('hex')}`;
const UNAUTHORIZED = { statusCode: 401, error: 'Unauthorized', message: 'Unauthorized' };
const FAILURE = {
  statusCode: 500,
  error: 'Internal Server Error',
  message: 'Internal Server Error',
};
type Handler = Parameters<ModelUpstream['setHandler']>[0];

/** Answers like RAGFlow v1.0.0-rc2's open version endpoint; anything else is a marked 404. */
const ragflowHandler: Handler = (request, response) => {
  const found = request.method === 'GET' && request.path === RAGFLOW_VERSION_PATH;
  response.writeHead(found ? 200 : 404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ code: found ? 0 : 404, data: 'v1.0.0-rc2', message: MARKER }));
};

let upstream: ModelUpstream;
// The gateway must never resolve an instance for this prefix, in any case of this file.
let resolutions = 0;
const resolveUpstream: GatewayUpstreamResolver = () => {
  resolutions += 1;
  return { outcome: 'stopped' };
};
beforeEach(async () => {
  upstream = await startModelUpstream(ragflowHandler);
});
afterEach(async () => {
  await upstream.close();
});
afterAll(() => {
  expect(resolutions).toBe(0);
});

interface Answer {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: string;
}
interface Proxy {
  readonly base: string;
  readonly app: FastifyInstance;
  readonly database: DatabaseHandle;
  readonly token: string;
  readonly lines: string[];
  readonly send: (path: string, init?: RequestInit) => Promise<Answer>;
}
interface ProxyOptions {
  readonly upstreamMode?: PlatformConfig['upstreamMode'];
  readonly trustedProxies?: readonly string[];
  readonly configured?: boolean;
  readonly host?: string;
  readonly status?: 'running' | 'starting' | 'stopped';
  readonly userStatus?: 'active' | 'disabled';
}

/**
 * Real loopback listener with one seeded instance and its token. Afterwards neither responses
 * nor logs carry the token, its stored hash or the fake RAGFlow authority.
 */
async function withProxy(
  run: (proxy: Proxy) => Promise<void>,
  options: ProxyOptions = {},
): Promise<void> {
  await withApp(
    async (app, database, lines) => {
      const token = instanceToken();
      seedInstance(database, {
        userId: 'owner',
        token: options.status === 'stopped' ? null : token,
        host: options.host ?? '127.0.0.1',
        status: options.status ?? 'running',
        userStatus: options.userStatus ?? 'active',
      });
      if (options.configured !== false)
        writeSettings(database, { ragflowBaseUrl: upstream.origin, ragflowApiKey: RAGFLOW_KEY });
      const base = await app.listen({ host: '127.0.0.1', port: 0 });
      const texts: string[] = [];
      const send = async (path: string, init: RequestInit = {}): Promise<Answer> => {
        const response = await fetch(`${base}${path}`, { redirect: 'manual', ...init });
        const body = await response.text();
        texts.push(body);
        return { status: response.status, contentType: response.headers.get('content-type'), body };
      };

      await run({ base, app, database, token, lines, send });

      const output = texts.join('') + lines.join('');
      const leaks = [token, instanceTokenHash(token), new URL(upstream.origin).host, RAGFLOW_KEY];
      for (const leak of [...leaks, MARKER]) expect(output.includes(leak)).toBe(false);
    },
    false,
    options.trustedProxies ?? [],
    resolveUpstream,
    { upstreamMode: options.upstreamMode ?? 'network' },
  );
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

it('answers not-configured for a valid token without contacting RAGFlow', async () => {
  await withProxy(
    async ({ send, token }) => {
      const answer = await send(VERSION, { headers: bearer(token) });

      expect([answer.status, JSON.parse(answer.body)]).toEqual([200, { result: 'not-configured' }]);
      expect(upstream.requests).toEqual([]);
    },
    { configured: false },
  );
});

it('reads the configured RAGFlow version once, without the RAGFlow key', async () => {
  await withProxy(async ({ send, token }) => {
    const answer = await send(VERSION, { headers: bearer(token) });

    expect([answer.status, JSON.parse(answer.body)]).toEqual([
      200,
      { result: 'ok', version: 'v1.0.0-rc2' },
    ]);
    expect(upstream.requests.map(({ method, path }) => [method, path])).toEqual([
      ['GET', RAGFLOW_VERSION_PATH],
    ]);
    expect(upstream.requests[0]?.headers.authorization).toBeUndefined();
  });
});

it('ignores a platform session cookie that accompanies a valid token', async () => {
  await withProxy(async ({ send, token, database }) => {
    const cookie = `platform_session=${createSession(database, 'owner', Date.now())}`;

    const answer = await send(VERSION, { headers: { ...bearer(token), cookie } });

    expect([answer.status, JSON.parse(answer.body)]).toEqual([
      200,
      { result: 'ok', version: 'v1.0.0-rc2' },
    ]);
    expect(resolutions).toBe(0);
  });
});

type Rejection = [label: string, options: ProxyOptions, request: (proxy: Proxy) => Promise<Answer>];
const rejections: Rejection[] = [
  ['no token', {}, ({ send }) => send(VERSION)],
  ['a malformed token', {}, ({ send, token }) => send(VERSION, { headers: bearer(`${token}0`) })],
  [
    'only a valid platform session',
    {},
    ({ send, database }) =>
      send(VERSION, {
        headers: { cookie: `platform_session=${createSession(database, 'owner', Date.now())}` },
      }),
  ],
  [
    'the old token of a stopped instance',
    { status: 'stopped' },
    ({ send, token }) => send(VERSION, { headers: bearer(token) }),
  ],
  [
    'the previous token after a restart rotated it',
    {},
    ({ send, token, database }) => {
      database
        .prepare('UPDATE instances SET instance_token_hash = ? WHERE user_id = ?')
        .run(instanceTokenHash(instanceToken()), 'owner');
      return send(VERSION, { headers: bearer(token) });
    },
  ],
  [
    'the token of a starting instance',
    { status: 'starting' },
    ({ send, token }) => send(VERSION, { headers: bearer(token) }),
  ],
  [
    'a disabled account with a running row',
    { userStatus: 'disabled' },
    ({ send, token }) => send(VERSION, { headers: bearer(token) }),
  ],
  [
    'another instance address',
    { host: '127.0.0.2' },
    ({ send, token }) => send(VERSION, { headers: bearer(token) }),
  ],
  [
    'a trusted forwarded address naming the instance',
    { host: '127.0.0.2', trustedProxies: ['127.0.0.1'] },
    ({ send, token }) =>
      send(VERSION, { headers: { ...bearer(token), 'x-forwarded-for': '127.0.0.2' } }),
  ],
  [
    'published-loopback mode',
    { upstreamMode: 'published-loopback' },
    ({ send, token }) => send(VERSION, { headers: bearer(token) }),
  ],
  [
    'a POST to an undeclared retrieval path without token or Origin',
    {},
    ({ send }) =>
      send(`${PREFIX}/retrieval`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
  ],
];

it('answers every rejection reason with one byte-identical 401 and no RAGFlow request', async () => {
  const answers: Answer[] = [];
  for (const [, options, request] of rejections)
    await withProxy(async (proxy) => {
      answers.push(await request(proxy));
    }, options);

  expect(answers).toHaveLength(rejections.length);
  for (const answer of answers)
    expect(answer).toEqual({
      status: 401,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(UNAUTHORIZED),
    });
  expect(upstream.requests).toEqual([]);
});

it('is a control: the audit source resolver would trust that forwarded address', () => {
  const resolve = createSourceAddressResolver(['127.0.0.1']);

  expect(resolve({ ip: '127.0.0.1', headers: { 'x-forwarded-for': '127.0.0.2' } })).toBe(
    '127.0.0.2',
  );
});

it.each([
  ['GET', `${PREFIX}/datasets-x`],
  ['DELETE', VERSION],
  ['POST', VERSION],
  ['HEAD', VERSION],
])('answers authenticated %s %s with the platform 404', async (method, path) => {
  await withProxy(async ({ send, token }) => {
    const answer = await send(path, { method, headers: bearer(token) });

    expect(answer.status).toBe(404);
    expect(upstream.requests).toEqual([]);
  });
});

it.each([
  `${PREFIX.replace('ragflow', 'ragflo%77')}/version`,
  VERSION.replace('platform', 'platfor%6d'),
])('authenticates the encoded variant %s before answering like the plain path', async (path) => {
  await withProxy(async ({ send, token }) => {
    const anonymous = await send(path);
    expect([anonymous.status, upstream.requests.length]).toEqual([401, 0]);

    const admitted = await send(path, { headers: bearer(token) });

    expect([admitted.status, JSON.parse(admitted.body)]).toEqual([
      200,
      { result: 'ok', version: 'v1.0.0-rc2' },
    ]);
  });
});

it('answers an anonymous HTML navigation with 401 rather than the login redirect', async () => {
  await withProxy(async ({ send }) => {
    const answer = await send(VERSION, { headers: { accept: 'text/html' } });

    expect([answer.status, JSON.parse(answer.body)]).toEqual([401, UNAUTHORIZED]);
    expect(resolutions).toBe(0);
  });
});

it('leaves a WebSocket upgrade under the prefix to the gateway platform 404', async () => {
  await withProxy(async ({ base, token }) => {
    const head = await rejectedUpgrade(
      base,
      '',
      ['Upgrade: websocket', `Authorization: Bearer ${token}`, `Origin: ${base}`],
      VERSION,
    );

    expect(head).toMatch(/^HTTP\/1\.1 404 /);
    expect(resolutions).toBe(0);
    expect(upstream.requests).toEqual([]);
  });
});

it('answers a token store failure with the fixed 500, not a rejected token', async () => {
  await withProxy(async ({ send, token, database, lines }) => {
    // No table references instances, so foreign keys do not block the drop.
    database.exec('DROP TABLE instances');

    const answer = await send(VERSION, { headers: bearer(token) });

    expect([answer.status, JSON.parse(answer.body)]).toEqual([500, FAILURE]);
    expect(lines.join('')).toContain('RAGFlow proxy authentication storage failure');
    for (const leak of ['SQLITE', 'no such table', 'instances', 'instance_token_hash'])
      expect((answer.body + lines.join('')).includes(leak)).toBe(false);
    expect(upstream.requests).toEqual([]);
  });
});

it('application close aborts an in-flight version read with the fixed 500', async () => {
  upstream.setHandler(() => undefined);
  await withProxy(async ({ send, token, app }) => {
    const pending = send(VERSION, { headers: bearer(token) });
    await upstream.received(1);
    const started = performance.now();

    await app.close();
    const answer = await pending;
    await upstream.socketClosed(1);

    expect(performance.now() - started).toBeLessThan(5_000);
    expect([answer.status, JSON.parse(answer.body)]).toEqual([500, FAILURE]);
  });
});
