import { expect, it } from 'vitest';
import { withApp } from '../../test/auth-fixture.ts';
import { instanceToken, seedInstance } from '../../test/instance-token-fixture.ts';
import type { DatabaseHandle } from '../db/index.ts';

const VERSION = '/_platform/instance-api/ragflow/version';
const DATASETS = '/_platform/instance-api/ragflow/datasets';
const DATASET = 'd'.repeat(32);
const DOCUMENTS = `${DATASETS}/${DATASET}/documents`;
const PAGE = `${DOCUMENTS}?page=1&page_size=10`;

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

it.each([VERSION, DATASETS, PAGE])(
  'answers %s with not-configured and HTTP 200 while RAGFlow has no saved address',
  async (url) => {
    await withProxyRoutes(async (send) => {
      const [status, body] = await send('GET', url);

      expect([status, JSON.parse(body)]).toEqual([200, { result: 'not-configured' }]);
    });
  },
);

it.each([VERSION, DATASETS, PAGE])(
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
  [PAGE, 'RAGFlow proxy documents failure'],
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

it.each([
  ['31 hex characters', 'd'.repeat(31)],
  ['33 hex characters', 'd'.repeat(33)],
  ['uppercase hex', 'D'.repeat(32)],
  ['an encoded slash', `${'d'.repeat(15)}%2F${'d'.repeat(16)}`],
  ['an encoded slash in place of a character', `${'d'.repeat(16)}%2F${'d'.repeat(15)}`],
])(
  'answers a document request whose dataset ID has %s as invalid-request before reading settings',
  async (_label, id) => {
    await withProxyRoutes(async (send, database) => {
      // A settings read would now fail; an invalid request never reaches it.
      database.exec('DROP TABLE settings');

      const [status, body] = await send('GET', `${DATASETS}/${id}/documents?page=1&page_size=10`);

      expect([status, JSON.parse(body)]).toEqual([200, { result: 'invalid-request' }]);
    });
  },
);

const OVERLONG_KEYWORDS = encodeURIComponent('库'.repeat(85) + 'xx');
it.each([
  ['no query', ''],
  ['a missing page', '?page_size=10'],
  ['a missing page size', '?page=1'],
  ['page 0', '?page=0&page_size=10'],
  ['a zero-padded page', '?page=01&page_size=10'],
  ['page 1000000', '?page=1000000&page_size=10'],
  ['a signed page', '?page=%2B1&page_size=10'],
  ['page size 0', '?page=1&page_size=0'],
  ['page size 101', '?page=1&page_size=101'],
  ['a fractional page size', '?page=1&page_size=1.5'],
  ['empty keywords', '?page=1&page_size=10&keywords='],
  ['whitespace-only keywords', '?page=1&page_size=10&keywords=%20%20'],
  ['plus-encoded whitespace-only keywords', '?page=1&page_size=10&keywords=++'],
  ['keywords over 256 UTF-8 bytes', `?page=1&page_size=10&keywords=${OVERLONG_KEYWORDS}`],
  ['an invalid escape', '?page=1&page_size=10&keywords=%zz'],
  ['an escape that is not UTF-8', '?page=1&page_size=10&keywords=%ff'],
  ['a truncated UTF-8 escape', '?page=1&page_size=10&keywords=%C3'],
  ['an invalid escape in a name', '?page=1&page_size=10&%zz=1'],
  ['a repeated page', '?page=1&page=2&page_size=10'],
  ['repeated keywords', '?page=1&page_size=10&keywords=a&keywords=b'],
  ['an unknown key', '?page=1&page_size=10&x=1'],
  ['an item without "="', '?page&page=1&page_size=10'],
  ['an empty item', '?page=1&&page_size=10'],
  ['a trailing "&"', '?page=1&page_size=10&'],
  [
    'a key spelled with an escape that decodes to another key',
    '?page=1&page%5Fsize=10&page_size=10',
  ],
])(
  'answers a document request with %s as invalid-request before reading settings',
  async (_label, query) => {
    await withProxyRoutes(async (send, database) => {
      database.exec('DROP TABLE settings');

      const [status, body] = await send('GET', `${DOCUMENTS}${query}`);

      expect([status, JSON.parse(body)]).toEqual([200, { result: 'invalid-request' }]);
    });
  },
);

it.each([
  ['page 1 and page size 1', '?page=1&page_size=1'],
  ['page 999999 and page size 100', '?page=999999&page_size=100'],
  ['keys in another order', '?page_size=10&page=2'],
  [
    'keywords of exactly 256 UTF-8 bytes',
    `?page=1&page_size=10&keywords=${encodeURIComponent('库'.repeat(85) + 'x')}`,
  ],
  ['keywords with surrounding whitespace', '?page=1&page_size=10&keywords=+a+'],
  ['keywords with an encoded "=" and "&"', '?page=1&page_size=10&keywords=a%3Db%26c'],
  ['a raw "=" inside the keywords value', '?page=1&page_size=10&keywords=a=b'],
])(
  'admits a document request with %s past validation to the saved settings',
  async (_label, query) => {
    await withProxyRoutes(async (send) => {
      const [status, body] = await send('GET', `${DOCUMENTS}${query}`);

      // Nothing is saved, so an admitted request stops at the settings it would read.
      expect([status, JSON.parse(body)]).toEqual([200, { result: 'not-configured' }]);
    });
  },
);
