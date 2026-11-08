import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { listRagflowDocuments } from '../src/ragflow-proxy/index.ts';
import { refusedOrigin, startModelUpstream } from './model-upstream-fixture.ts';
import type { ModelUpstream } from './model-upstream-fixture.ts';
import { UNAUTHORIZED, rawBody, withProxy as withRagflowProxy } from './ragflow-proxy-fixture.ts';
import type { Proxy } from './ragflow-proxy-fixture.ts';

const DATASETS = '/_platform/instance-api/ragflow/datasets';
const RAGFLOW_KEY = `owned-ragflow-key-${randomBytes(8).toString('hex')}`;
const MARKER = `owned-upstream-marker-${randomBytes(8).toString('hex')}`;
// ASCII so it survives percent-encoding unchanged in a request log line.
const KEYWORD_MARKER = `kwmarker${randomBytes(6).toString('hex')}`;
const DATASET = randomBytes(16).toString('hex');
const DOCUMENTS = `${DATASETS}/${DATASET}/documents`;
const IDS = [randomBytes(16).toString('hex'), randomBytes(16).toString('hex')] as const;
const NAMES = ['制度.pdf', '产品手册.docx'] as const;
type Handler = Parameters<ModelUpstream['setHandler']>[0];
/** The fields of a pino log line that the log assertions compare. */
interface Line {
  readonly msg: string;
  readonly req?: {
    readonly method: unknown;
    readonly url: unknown;
    readonly remoteAddress: unknown;
  };
}

/** The upstream target for one page, in the proxy's fixed parameter order. */
function upstreamPath(page: number, pageSize: number, keywords?: string): string {
  const filter = keywords === undefined ? '' : `&keywords=${keywords}`;
  return (
    `/api/v1/datasets/${DATASET}/documents?page=${String(page)}&page_size=${String(pageSize)}` +
    `&orderby=create_time&desc=false${filter}`
  );
}

/** An rc2 document row: every field beside `id`, `name` and `dataset_id` carries the marker. */
function row(index: 0 | 1): Record<string, unknown> {
  return {
    id: IDS[index],
    name: NAMES[index],
    dataset_id: DATASET,
    thumbnail: `data:image/png;base64,${MARKER}`,
    location: MARKER,
    nickname: MARKER,
    created_by: randomBytes(16).toString('hex'),
    meta_fields: { note: MARKER },
    size: 1024,
  };
}

/**
 * Answers like RAGFlow v1.0.0-rc2's bearer-checked document list of one dataset, paging the two
 * rows by `page`/`page_size`; another dataset is rc2's HTTP 200 with code 404.
 */
function ragflowHandler(): Handler {
  return (request, response) => {
    const answer = (status: number, body: Record<string, unknown>) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: MARKER, ...body }));
    };
    const target = new URL(request.path ?? '/', 'http://upstream.invalid');
    if (request.headers.authorization !== `Bearer ${RAGFLOW_KEY}`)
      answer(401, { code: 401, data: null });
    else if (request.method !== 'GET' || target.pathname !== upstreamPath(1, 1).split('?')[0])
      answer(200, { code: 404, data: null });
    else {
      const page = Number(target.searchParams.get('page'));
      const size = Number(target.searchParams.get('page_size'));
      const rows = [row(0), row(1)].slice((page - 1) * size, page * size);
      answer(200, { code: 0, data: { total: 2, docs: rows } });
    }
  };
}

let upstream: ModelUpstream;
beforeEach(async () => {
  upstream = await startModelUpstream(ragflowHandler());
});
afterEach(async () => {
  await upstream.close();
});

/** The proxy over the owned fake RAGFlow; neither marker may reach a response or a log line. */
function withProxy(
  run: (proxy: Proxy) => Promise<void>,
  options: { readonly baseURL?: string } = {},
): Promise<void> {
  return withRagflowProxy(
    { upstream, key: RAGFLOW_KEY, markers: [MARKER, KEYWORD_MARKER], baseURL: options.baseURL },
    run,
  );
}

/** A raw HTTP/1.1 request with `target` written verbatim, authenticated unless anonymous. */
function rawGet(
  proxy: Proxy,
  target: string,
  {
    method = 'GET',
    anonymous = false,
  }: { readonly method?: string; readonly anonymous?: boolean } = {},
): Promise<string> {
  const authorization = anonymous ? '' : `Authorization: Bearer ${proxy.token}\r\n`;
  return proxy.raw(
    `${method} ${target} HTTP/1.1\r\nHost: h\r\n${authorization}Connection: close\r\n\r\n`,
  );
}

/** The URL of every request log line so far, in order. */
function loggedUrls(proxy: Proxy): unknown[] {
  // pino writes one JSON object per line.
  return proxy.lines
    .map((line) => JSON.parse(line) as Line)
    .filter(({ msg }) => msg === 'incoming request')
    .map(({ req }) => req?.url);
}

it('reads one page once with the key and returns only the total, ids and names', async () => {
  await withProxy(async ({ send }) => {
    const answer = await send(`${DOCUMENTS}?page=1&page_size=10`);

    expect(answer.status).toBe(200);
    expect(answer.body).toBe(
      JSON.stringify({
        result: 'ok',
        total: 2,
        documents: [
          { id: IDS[0], name: NAMES[0] },
          { id: IDS[1], name: NAMES[1] },
        ],
      }),
    );
    expect(upstream.requests.map(({ method, path }) => [method, path])).toEqual([
      ['GET', upstreamPath(1, 10)],
    ]);
    expect(upstream.requests[0]?.headers.authorization).toBe(`Bearer ${RAGFLOW_KEY}`);
  });
});

it('reads later pages and a page past the end with the upstream total', async () => {
  await withProxy(async ({ send }) => {
    const second = await send(`${DOCUMENTS}?page=2&page_size=1`);
    const beyond = await send(`${DOCUMENTS}?page=3&page_size=1`);

    expect(JSON.parse(second.body)).toEqual({
      result: 'ok',
      total: 2,
      documents: [{ id: IDS[1], name: NAMES[1] }],
    });
    expect(JSON.parse(beyond.body)).toEqual({ result: 'ok', total: 2, documents: [] });
    expect(upstream.requests.map(({ path }) => path)).toEqual([
      upstreamPath(2, 1),
      upstreamPath(3, 1),
    ]);
  });
});

it.each([
  ['a "+" as a space', 'a+b', 'a%20b'],
  ['an encoded "+" as a plus sign', 'a%2Bb', 'a%2Bb'],
])('forwards keywords with %s', async (_label, sent, forwarded) => {
  await withProxy(async ({ send }) => {
    const answer = await send(`${DOCUMENTS}?page=1&page_size=10&keywords=${sent}`);

    expect(JSON.parse(answer.body)).toMatchObject({ result: 'ok' });
    expect(upstream.requests.map(({ path }) => path)).toEqual([upstreamPath(1, 10, forwarded)]);
  });
});

it.each([
  ['an uppercase dataset ID', `${DATASETS}/ABC/documents?page=1&page_size=10`],
  ['a page size over 100', `${DOCUMENTS}?page=1&page_size=101`],
])('answers %s with invalid-request without contacting RAGFlow', async (_label, path) => {
  await withProxy(async ({ send }) => {
    const answer = await send(path);

    expect([answer.status, JSON.parse(answer.body)]).toEqual([200, { result: 'invalid-request' }]);
    expect(upstream.requests).toEqual([]);
  });
});

it.each([
  ['a dot segment', `${DATASETS}/../documents?page=1&page_size=10`],
  ['an encoded dot segment', `${DATASETS}/%2e%2e/documents?page=1&page_size=10`],
  ['a fragment after the query', `${DOCUMENTS}?page=1&page_size=10#x`],
  ['a fragment without a query', `${DOCUMENTS}#${KEYWORD_MARKER}`],
])(
  'answers a raw target with %s with invalid-request without contacting RAGFlow',
  async (_label, target) => {
    await withProxy(async (proxy) => {
      const text = await rawGet(proxy, target);

      expect(text).toMatch(/^HTTP\/1\.1 200 /);
      expect(JSON.parse(rawBody(text))).toEqual({ result: 'invalid-request' });
      expect(upstream.requests).toEqual([]);
    });
  },
);

it('keeps keywords out of every log line for plain, encoded and absolute-form targets', async () => {
  const query = `?page=1&page_size=10&keywords=${KEYWORD_MARKER}`;
  const encoded = `/_platform/instance-api/ragflo%77/datasets/${DATASET}/documents${query}`;
  await withProxy(async (proxy) => {
    const bodies = [
      (await proxy.send(`${DOCUMENTS}${query}`)).body,
      (await proxy.send(encoded)).body,
      rawBody(await rawGet(proxy, `http://h${DOCUMENTS}${query}`)),
    ];

    expect(bodies.map((body) => (JSON.parse(body) as { result: string }).result)).toEqual([
      'ok',
      'ok',
      'ok',
    ]);
    // pino writes one JSON object per line.
    const lines = proxy.lines.map((line) => JSON.parse(line) as Line);
    const requests = lines
      .filter(({ msg }) => msg === 'incoming request')
      .map(({ req }) => ({
        method: req?.method,
        url: req?.url,
        remoteAddress: req?.remoteAddress,
      }));
    expect(requests).toEqual(
      [
        DOCUMENTS,
        `/_platform/instance-api/ragflo%77/datasets/${DATASET}/documents`,
        `http://h${DOCUMENTS}`,
      ].map((path) => ({ method: 'GET', url: `${path}?[redacted]`, remoteAddress: '127.0.0.1' })),
    );
    expect(lines.filter(({ msg }) => msg === 'request completed')).toHaveLength(3);
    expect(upstream.requests).toHaveLength(3);
  });
});

it('authenticates every router spelling of the prefix and redacts its logged query', async () => {
  const query = `?keywords=${KEYWORD_MARKER}`;
  await withProxy(async (proxy) => {
    const encoded = await proxy.send(`/%5Fplatform/instance-api/ragflow/x${query}`, {
      token: false,
    });
    const decoded = await proxy.send('/_platform/instance-api/ragflo%77/x', { token: false });
    const absolute = await rawGet(proxy, `http://h/_platform/instance-api/ragflow/x${query}`, {
      anonymous: true,
    });
    const escaped = await proxy.send('/_platform/instance-api/ragflow%2Fversion', { token: false });

    expect(loggedUrls(proxy)).toEqual([
      '/%5Fplatform/instance-api/ragflow/x?[redacted]',
      '/_platform/instance-api/ragflo%77/x',
      'http://h/_platform/instance-api/ragflow/x?[redacted]',
      '/_platform/instance-api/ragflow%2Fversion',
    ]);
    expect(
      [encoded, decoded].map(({ status, body }) => [status, JSON.parse(body) as unknown]),
    ).toEqual([
      [401, UNAUTHORIZED],
      [401, UNAUTHORIZED],
    ]);
    expect(absolute).toMatch(/^HTTP\/1\.1 401 /);
    expect(JSON.parse(rawBody(absolute))).toEqual(UNAUTHORIZED);
    expect(escaped.status).toBe(404);
    expect(upstream.requests).toEqual([]);
  });
});

it('redacts the logged query of an absolute-form target no proxy route matches', async () => {
  const query = `?keywords=${KEYWORD_MARKER}`;
  await withProxy(async (proxy) => {
    const head = await rawGet(proxy, `http://h${DOCUMENTS}${query}`, { method: 'HEAD' });
    const slashed = await rawGet(proxy, `http://h${DOCUMENTS}/${query}`);

    expect(head).toMatch(/^HTTP\/1\.1 404 /);
    expect(slashed).toMatch(/^HTTP\/1\.1 404 /);
    expect(loggedUrls(proxy)).toEqual([
      `http://h${DOCUMENTS}?[redacted]`,
      `http://h${DOCUMENTS}/?[redacted]`,
    ]);
    expect(upstream.requests).toEqual([]);
  });
});

it('answers a dataset RAGFlow does not have (code 404) with invalid-request', async () => {
  await withProxy(async ({ send }) => {
    const answer = await send(`${DATASETS}/${'0'.repeat(32)}/documents?page=1&page_size=10`);

    expect([answer.status, JSON.parse(answer.body)]).toEqual([200, { result: 'invalid-request' }]);
    expect(upstream.requests).toHaveLength(1);
  });
});

it('reports HTTP 200 with a non-zero code as upstream-error', async () => {
  upstream.setHandler((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ code: 102, data: null, message: MARKER }));
  });
  await withProxy(async ({ send }) => {
    const answer = await send(`${DOCUMENTS}?page=1&page_size=10`);

    expect([answer.status, JSON.parse(answer.body)]).toEqual([200, { result: 'upstream-error' }]);
    expect(upstream.requests).toHaveLength(1);
  });
});

it('reaches the deadline before a status', async () => {
  upstream.setHandler(() => undefined);

  const outcome = await listRagflowDocuments(
    { baseURL: upstream.origin, apiKey: RAGFLOW_KEY },
    DATASET,
    { page: 1, pageSize: 10 },
    new AbortController().signal,
    200,
  );

  expect(outcome).toEqual({ result: 'timeout' });
  expect(upstream.requests.map(({ path }) => path)).toEqual([upstreamPath(1, 10)]);
  await upstream.socketClosed(1);
});

it('reports a refused port as unavailable', async () => {
  const refused = await refusedOrigin();
  await withProxy(
    async ({ send }) => {
      const answer = await send(`${DOCUMENTS}?page=1&page_size=10`);

      expect([answer.status, JSON.parse(answer.body)]).toEqual([200, { result: 'unavailable' }]);
    },
    { baseURL: refused },
  );
});

it('answers a request without a token with the fixed 401 and no RAGFlow request', async () => {
  await withProxy(async ({ send }) => {
    const answer = await send(`${DOCUMENTS}?page=1&page_size=10`, { token: false });

    expect([answer.status, JSON.parse(answer.body)]).toEqual([401, UNAUTHORIZED]);
    expect(upstream.requests).toEqual([]);
  });
});
