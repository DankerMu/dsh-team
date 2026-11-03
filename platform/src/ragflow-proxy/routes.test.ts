import { expect, it } from 'vitest';
import { withApp } from '../../test/auth-fixture.ts';
import { instanceToken, seedInstance } from '../../test/instance-token-fixture.ts';
import type { DatabaseHandle } from '../db/index.ts';

const VERSION = '/_platform/instance-api/ragflow/version';
const DATASETS = '/_platform/instance-api/ragflow/datasets';

/** The real application in network mode with one running loopback instance and its token. */
async function withProxyRoutes(
  run: (
    send: (method: 'GET' | 'HEAD', url: string) => Promise<[number, string]>,
    database: DatabaseHandle,
    lines: string[],
  ) => Promise<void>,
): Promise<void> {
  await withApp(
    async (app, database, lines) => {
      const token = instanceToken();
      seedInstance(database, { userId: 'owner', token, host: '127.0.0.1' });
      const send = async (method: 'GET' | 'HEAD', url: string): Promise<[number, string]> => {
        const response = await app.inject({
          method,
          url,
          remoteAddress: '127.0.0.1',
          headers: { authorization: `Bearer ${token}` },
        });
        return [response.statusCode, response.body];
      };
      await run(send, database, lines);
    },
    false,
    [],
    undefined,
    { upstreamMode: 'network' },
  );
}

it.each([VERSION, DATASETS])(
  'answers %s with not-configured and HTTP 200 while RAGFlow has no saved address',
  async (url) => {
    await withProxyRoutes(async (send) => {
      const [status, body] = await send('GET', url);

      expect([status, JSON.parse(body)]).toEqual([200, { result: 'not-configured' }]);
    });
  },
);

it.each([VERSION, DATASETS])(
  'declares no implicit HEAD route for %s, so HEAD gets the platform 404',
  async (url) => {
    await withProxyRoutes(async (send) => {
      expect((await send('HEAD', url))[0]).toBe(404);
    });
  },
);

// Injection drops a bare trailing "?" from the URL; the integration test sends it over TCP.
it.each(['?page=2', '?=', '?page_size=1001&orderby=create_time'])(
  'answers a dataset list request with query %j as invalid-request before reading settings',
  async (query) => {
    await withProxyRoutes(async (send, database) => {
      // A settings read would now fail; an invalid request never reaches it.
      database.exec('DROP TABLE settings');

      const [status, body] = await send('GET', `${DATASETS}${query}`);

      expect([status, JSON.parse(body)]).toEqual([200, { result: 'invalid-request' }]);
    });
  },
);

it.each([
  [VERSION, 'RAGFlow proxy version failure'],
  [DATASETS, 'RAGFlow proxy datasets failure'],
])('answers a settings storage failure on %s with the fixed 500 and log text', async (url, log) => {
  await withProxyRoutes(async (send, database, lines) => {
    database.exec('DROP TABLE settings');

    const [status, body] = await send('GET', url);

    expect([status, JSON.parse(body)]).toEqual([
      500,
      { statusCode: 500, error: 'Internal Server Error', message: 'Internal Server Error' },
    ]);
    const output = body + lines.join('');
    expect(output).toContain(log);
    for (const leak of ['SQLITE', 'no such table', 'settings'])
      expect(output.includes(leak)).toBe(false);
  });
});
