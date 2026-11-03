import { expect, it } from 'vitest';
import { withApp } from '../../test/auth-fixture.ts';
import { instanceToken, seedInstance } from '../../test/instance-token-fixture.ts';
import type { DatabaseHandle } from '../db/index.ts';

const VERSION = '/_platform/instance-api/ragflow/version';

/** The real application in network mode with one running loopback instance and its token. */
async function withVersionRoute(
  run: (
    send: (method: 'GET' | 'HEAD') => Promise<[number, string]>,
    database: DatabaseHandle,
    lines: string[],
  ) => Promise<void>,
): Promise<void> {
  await withApp(
    async (app, database, lines) => {
      const token = instanceToken();
      seedInstance(database, { userId: 'owner', token, host: '127.0.0.1' });
      const send = async (method: 'GET' | 'HEAD'): Promise<[number, string]> => {
        const response = await app.inject({
          method,
          url: VERSION,
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

it('answers not-configured with HTTP 200 while RAGFlow has no saved address', async () => {
  await withVersionRoute(async (send) => {
    const [status, body] = await send('GET');

    expect([status, JSON.parse(body)]).toEqual([200, { result: 'not-configured' }]);
  });
});

it('declares no implicit HEAD route, so HEAD gets the platform 404', async () => {
  await withVersionRoute(async (send) => {
    expect((await send('HEAD'))[0]).toBe(404);
  });
});

it('answers a settings storage failure with the fixed 500 and fixed log text', async () => {
  await withVersionRoute(async (send, database, lines) => {
    database.exec('DROP TABLE settings');

    const [status, body] = await send('GET');

    expect([status, JSON.parse(body)]).toEqual([
      500,
      { statusCode: 500, error: 'Internal Server Error', message: 'Internal Server Error' },
    ]);
    const output = body + lines.join('');
    expect(output).toContain('RAGFlow proxy version failure');
    for (const leak of ['SQLITE', 'no such table', 'settings'])
      expect(output.includes(leak)).toBe(false);
  });
});
