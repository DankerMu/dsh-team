import { expect, it } from 'vitest';
import { withApp } from '../../test/auth-fixture.ts';
import { instanceToken, seedInstance } from '../../test/instance-token-fixture.ts';
import type { DatabaseHandle } from '../db/index.ts';

const VERSION = '/_platform/instance-api/ragflow/version';
const DATASETS = '/_platform/instance-api/ragflow/datasets';
const DATASET = 'd'.repeat(32);
const DOCUMENTS = `${DATASETS}/${DATASET}/documents`;
const PAGE = `${DOCUMENTS}?page=1&page_size=10`;
const RETRIEVAL = '/_platform/instance-api/ragflow/retrieval';
/** One retrieval POST with `payload` sent verbatim and the given headers beside the token. */
type Post = (
  payload: string | undefined,
  headers?: Record<string, string>,
) => Promise<[number, string]>;

/** The real application in network mode with one running loopback instance and its token. */
async function withProxyRoutes(
  run: (
    send: (method: 'GET' | 'HEAD', url: string) => Promise<[number, string]>,
    database: DatabaseHandle,
    lines: string[],
    post: Post,
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
      // A string payload keeps light-my-request from adding its own JSON Content-Type.
      const post: Post = async (payload, headers = { 'content-type': 'application/json' }) => {
        const response = await app.inject({
          method: 'POST',
          url: RETRIEVAL,
          remoteAddress: '127.0.0.1',
          headers: { authorization: `Bearer ${token}`, ...headers },
          ...(payload === undefined ? {} : { payload }),
        });
        return [response.statusCode, response.body];
      };
      await run(send, database, lines, post);
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

const INTERNAL = {
  statusCode: 500,
  error: 'Internal Server Error',
  message: 'Internal Server Error',
};
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
  ['NEL-only keywords', '?page=1&page_size=10&keywords=%C2%85'],
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

const UNSUPPORTED = {
  statusCode: 415,
  error: 'Unsupported Media Type',
  message: 'JSON request body required',
};
const TOO_LARGE = {
  statusCode: 413,
  error: 'Payload Too Large',
  message: 'Request body too large',
};
const VALID = JSON.stringify({ question: '年假怎么申请？', datasetIds: [DATASET] });
const QUESTION_4096 = '库'.repeat(1_365) + 'x';
const ids = (count: number) =>
  Array.from({ length: count }, (_value, index) => index.toString(16).padStart(32, '0'));
const retrievalBody = (fields: Record<string, unknown>) =>
  JSON.stringify({ question: '年假怎么申请？', datasetIds: [DATASET], ...fields });

it.each([
  ['no Content-Type with a body', VALID, {}],
  ['no Content-Type and no body', undefined, {}],
  ['text/plain', VALID, { 'content-type': 'text/plain' }],
  ['application/vnd.api+json', VALID, { 'content-type': 'application/vnd.api+json' }],
  ['a JSON parameter without the JSON type', VALID, { 'content-type': 'text/plain; x=json' }],
])(
  'answers a retrieval with %s with the fixed 415 before reading settings',
  async (_label, payload, headers) => {
    await withProxyRoutes(async (_send, database, _lines, post) => {
      database.exec('DROP TABLE settings');

      const [status, body] = await post(payload, headers);

      expect([status, JSON.parse(body)]).toEqual([415, UNSUPPORTED]);
    });
  },
);

it('answers a retrieval body over 64 KiB with the fixed 413 before reading settings', async () => {
  await withProxyRoutes(async (_send, database, _lines, post) => {
    database.exec('DROP TABLE settings');
    const payload = retrievalBody({ padding: 'x'.repeat(65_536) });

    const [status, body] = await post(payload);

    expect([status, JSON.parse(body)]).toEqual([413, TOO_LARGE]);
  });
});

it.each([
  ['unparseable JSON', '{"question":'],
  ['an empty body', ''],
  ['a __proto__ key', '{"__proto__":{"x":1},"question":"q","datasetIds":[]}'],
  ['a constructor.prototype key', '{"constructor":{"prototype":{"x":1}}}'],
  ['JSON null', 'null'],
  ['a JSON array', JSON.stringify([VALID])],
  ['a JSON string', JSON.stringify(VALID)],
  ['a missing question', JSON.stringify({ datasetIds: [DATASET] })],
  ['missing dataset IDs', JSON.stringify({ question: 'q' })],
  ['an added top_k', retrievalBody({ top_k: 1024 })],
  ['an added similarity_threshold', retrievalBody({ similarity_threshold: 0 })],
  ['an added page_size', retrievalBody({ page_size: 100 })],
  ['an added rerank_id', retrievalBody({ rerank_id: 'x' })],
  ['an added unknown key', retrievalBody({ x: 1 })],
  ['an empty question', retrievalBody({ question: '' })],
  ['a whitespace-only question', retrievalBody({ question: ' \t\n　' })],
  ['a NEL-only question', retrievalBody({ question: '\u0085' })],
  ['a question over 4096 UTF-8 bytes', retrievalBody({ question: QUESTION_4096 + 'x' })],
  ['a numeric question', retrievalBody({ question: 7 })],
  ['an empty dataset scope', retrievalBody({ datasetIds: [] })],
  ['1001 dataset IDs', retrievalBody({ datasetIds: ids(1_001) })],
  ['a repeated dataset ID', retrievalBody({ datasetIds: [DATASET, DATASET] })],
  ['an uppercase dataset ID', retrievalBody({ datasetIds: ['D'.repeat(32)] })],
  ['a 31-character dataset ID', retrievalBody({ datasetIds: ['d'.repeat(31)] })],
  ['a numeric dataset ID', retrievalBody({ datasetIds: [7] })],
  ['dataset IDs that are an object', retrievalBody({ datasetIds: { 0: DATASET } })],
  ['dataset IDs that are the string "abc"', retrievalBody({ datasetIds: 'abc' })],
])(
  'answers a retrieval with %s as invalid-request before reading settings',
  async (_label, payload) => {
    await withProxyRoutes(async (_send, database, _lines, post) => {
      database.exec('DROP TABLE settings');

      const [status, body] = await post(payload);

      expect([status, JSON.parse(body)]).toEqual([200, { result: 'invalid-request' }]);
    });
  },
);

it.each([
  ['a question of exactly 4096 UTF-8 bytes', retrievalBody({ question: QUESTION_4096 }), {}],
  ['a question with surrounding whitespace', retrievalBody({ question: ' a ' }), {}],
  ['exactly 1000 dataset IDs', retrievalBody({ datasetIds: ids(1_000) }), {}],
  ['a charset parameter', VALID, { 'content-type': 'application/json; charset=utf-8' }],
  ['a mixed-case media type', VALID, { 'content-type': 'Application/JSON' }],
])(
  'admits a retrieval with %s past validation to the saved settings',
  async (_label, payload, headers) => {
    expect(Buffer.byteLength(QUESTION_4096)).toBe(4_096);
    await withProxyRoutes(async (_send, _database, _lines, post) => {
      const [status, body] = await post(payload, {
        'content-type': 'application/json',
        ...headers,
      });

      // Nothing is saved, so an admitted request stops at the settings it would read.
      expect([status, JSON.parse(body)]).toEqual([200, { result: 'not-configured' }]);
    });
  },
);

it('answers a retrieval without a token with the fixed 401 even when its body is not JSON', async () => {
  await withApp(
    async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: RETRIEVAL,
        remoteAddress: '127.0.0.1',
        headers: { 'content-type': 'text/plain' },
        payload: 'not json',
      });

      expect([response.statusCode, JSON.parse(response.body)]).toEqual([
        401,
        { statusCode: 401, error: 'Unauthorized', message: 'Unauthorized' },
      ]);
    },
    false,
    [],
    undefined,
    { upstreamMode: 'network' },
  );
});

it('answers a settings storage failure on a valid retrieval with the fixed 500 and log text', async () => {
  await withProxyRoutes(async (_send, database, lines, post) => {
    database.exec('DROP TABLE settings');

    const [status, body] = await post(VALID);

    expect([status, JSON.parse(body)]).toEqual([500, INTERNAL]);
    const output = body + lines.join('');
    expect(output).toContain('RAGFlow proxy retrieval failure');
    for (const leak of ['SQLITE', 'no such table', 'settings', '年假'])
      expect(output.includes(leak)).toBe(false);
  });
});

it('answers any other body error with the fixed 500 and logs only fixed text', async () => {
  await withProxyRoutes(async (_send, _database, lines, post) => {
    // A declared length that differs from the sent body is a body error the route does not map.
    const [status, body] = await post(VALID, {
      'content-type': 'application/json',
      'content-length': '5',
    });

    expect([status, JSON.parse(body)]).toEqual([500, INTERNAL]);
    const output = body + lines.join('');
    expect(output).toContain('RAGFlow proxy retrieval request failure');
    for (const leak of ['FST_ERR', 'Content-Length', 'did not match', '年假'])
      expect(output.includes(leak)).toBe(false);
  });
});

it.each(['GET', 'HEAD'] as const)('declares no %s route for retrieval', async (method) => {
  await withProxyRoutes(async (send) => {
    expect((await send(method, RETRIEVAL))[0]).toBe(404);
  });
});
