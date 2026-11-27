import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { listRagflowChunks } from '../src/ragflow-proxy/index.ts';
import { refusedOrigin, startModelUpstream } from './model-upstream-fixture.ts';
import type { ModelUpstream } from './model-upstream-fixture.ts';
import { UNAUTHORIZED, rawBody, withProxy as withRagflowProxy } from './ragflow-proxy-fixture.ts';
import type { Proxy } from './ragflow-proxy-fixture.ts';

const DATASETS = '/_platform/instance-api/ragflow/datasets';
const RAGFLOW_KEY = `owned-ragflow-key-${randomBytes(8).toString('hex')}`;
const MARKER = `owned-upstream-marker-${randomBytes(8).toString('hex')}`;
const DATASET = randomBytes(16).toString('hex');
const DOCUMENT = randomBytes(16).toString('hex');
const OTHER = randomBytes(16).toString('hex');
const CHUNKS = `${DATASETS}/${DATASET}/documents/${DOCUMENT}/chunks`;
const TEXTS = ['一、员工因公发生的费用可申请报销。', '二、报销须上传发票照片与费用明细。'] as const;
type Handler = Parameters<ModelUpstream['setHandler']>[0];
/** The fields of a pino log line that the log assertions compare. */
interface Line {
  readonly msg: string;
  readonly req?: { readonly url: unknown };
}

/** The upstream target for one page; the proxy sends exactly these two parameters. */
function upstreamPath(page: number, pageSize: number, document = DOCUMENT): string {
  return (
    `/api/v1/datasets/${DATASET}/documents/${document}/chunks` +
    `?page=${String(page)}&page_size=${String(pageSize)}`
  );
}

/**
 * An rc2 list-chunks row as its Go service sends it: `chunk_id` and `content_with_weight`, no
 * `content` or `document_id`; every other field carries the marker.
 */
function row(index: 0 | 1): Record<string, unknown> {
  return {
    chunk_id: randomBytes(8).toString('hex'),
    content_with_weight: TEXTS[index],
    docnm_kwd: MARKER,
    important_kwd: [MARKER],
    question_kwd: [],
    img_id: MARKER,
    available_int: 1,
    positions: [],
  };
}

/**
 * Answers like RAGFlow v1.0.0-rc2's bearer-checked list of one document's chunks, paging the two
 * rows; any other document or dataset is rc2's HTTP 500 with code 500.
 */
function ragflowHandler(doc: Record<string, unknown> = {}): Handler {
  return (request, response) => {
    const answer = (status: number, body: Record<string, unknown>) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: MARKER, ...body }));
    };
    const target = new URL(request.path ?? '/', 'http://upstream.invalid');
    if (request.headers.authorization !== `Bearer ${RAGFLOW_KEY}`)
      answer(401, { code: 401, data: null });
    else if (request.method !== 'GET' || target.pathname !== upstreamPath(1, 1).split('?')[0])
      answer(500, { code: 500, data: null });
    else {
      const page = Number(target.searchParams.get('page'));
      const size = Number(target.searchParams.get('page_size'));
      const chunks = [row(0), row(1)].slice((page - 1) * size, page * size);
      const summary = { id: DOCUMENT, dataset_id: DATASET, name: MARKER, location: MARKER, ...doc };
      answer(200, { code: 0, data: { chunks, doc: summary, total: 2 } });
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

/** The proxy over the owned fake RAGFlow; the marker may reach no response or log line. */
function withProxy(
  run: (proxy: Proxy) => Promise<void>,
  options: { readonly baseURL?: string } = {},
): Promise<void> {
  return withRagflowProxy(
    { upstream, key: RAGFLOW_KEY, markers: [MARKER], baseURL: options.baseURL },
    run,
  );
}

it('reads one page once with the key and returns only the total and the chunk texts', async () => {
  await withProxy(async ({ send }) => {
    const answer = await send(`${CHUNKS}?page=1&page_size=20`);

    expect(answer.status).toBe(200);
    expect(answer.body).toBe(
      JSON.stringify({
        result: 'ok',
        total: 2,
        chunks: [{ content: TEXTS[0] }, { content: TEXTS[1] }],
      }),
    );
    expect(upstream.requests.map(({ method, path }) => [method, path])).toEqual([
      ['GET', upstreamPath(1, 20)],
    ]);
    expect(upstream.requests[0]?.headers.authorization).toBe(`Bearer ${RAGFLOW_KEY}`);
  });
});

it('reads a later page and a page past the end with the upstream total', async () => {
  await withProxy(async ({ send }) => {
    const second = await send(`${CHUNKS}?page=2&page_size=1`);
    const beyond = await send(`${CHUNKS}?page=3&page_size=1`);

    expect(JSON.parse(second.body)).toEqual({
      result: 'ok',
      total: 2,
      chunks: [{ content: TEXTS[1] }],
    });
    expect(JSON.parse(beyond.body)).toEqual({ result: 'ok', total: 2, chunks: [] });
  });
});

it.each([
  ['another document', { id: OTHER }],
  ['a document of another dataset', { dataset_id: OTHER }],
])('answers an upstream page about %s with upstream-error and no chunk', async (_label, doc) => {
  upstream.setHandler(ragflowHandler(doc));
  await withProxy(async ({ send }) => {
    const answer = await send(`${CHUNKS}?page=1&page_size=20`);

    expect([answer.status, answer.body]).toEqual([200, '{"result":"upstream-error"}']);
    expect(upstream.requests).toHaveLength(1);
  });
});

it("answers a document RAGFlow does not have (rc2's HTTP 500) with upstream-error", async () => {
  await withProxy(async ({ send }) => {
    const answer = await send(
      `${DATASETS}/${DATASET}/documents/${OTHER}/chunks?page=1&page_size=20`,
    );

    expect([answer.status, JSON.parse(answer.body)]).toEqual([200, { result: 'upstream-error' }]);
    expect(upstream.requests.map(({ path }) => path)).toEqual([upstreamPath(1, 20, OTHER)]);
  });
});

it.each([403, 404])(
  'answers a dataset the key cannot see (HTTP 200, code %i) with invalid-request',
  async (code) => {
    upstream.setHandler((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code, data: null, message: MARKER }));
    });
    await withProxy(async ({ send }) => {
      const answer = await send(`${CHUNKS}?page=1&page_size=20`);

      expect([answer.status, JSON.parse(answer.body)]).toEqual([
        200,
        { result: 'invalid-request' },
      ]);
    });
  },
);

it.each([
  ['an uppercase document ID', `${DATASETS}/${DATASET}/documents/ABC/chunks?page=1&page_size=20`],
  ['a page size over 100', `${CHUNKS}?page=1&page_size=101`],
  ['keywords', `${CHUNKS}?page=1&page_size=20&keywords=${MARKER}`],
])('answers %s with invalid-request without contacting RAGFlow', async (_label, path) => {
  await withProxy(async ({ send }) => {
    const answer = await send(path);

    expect([answer.status, JSON.parse(answer.body)]).toEqual([200, { result: 'invalid-request' }]);
    expect(upstream.requests).toEqual([]);
  });
});

it('answers a fragment-bearing raw target with invalid-request without contacting RAGFlow', async () => {
  await withProxy(async (proxy) => {
    const text = await proxy.raw(
      `GET ${CHUNKS}?page=1&page_size=20#x HTTP/1.1\r\nHost: h\r\n` +
        `Authorization: Bearer ${proxy.token}\r\nConnection: close\r\n\r\n`,
    );

    expect(text).toMatch(/^HTTP\/1\.1 200 /);
    expect(JSON.parse(rawBody(text))).toEqual({ result: 'invalid-request' });
    expect(upstream.requests).toEqual([]);
  });
});

it('keeps the query out of the request log line', async () => {
  await withProxy(async (proxy) => {
    const answer = await proxy.send(`${CHUNKS}?page=1&page_size=20`);

    expect(JSON.parse(answer.body)).toMatchObject({ result: 'ok', total: 2 });
    expect(upstream.requests).toHaveLength(1);

    // pino writes one JSON object per line.
    const urls = proxy.lines
      .map((line) => JSON.parse(line) as Line)
      .filter(({ msg }) => msg === 'incoming request')
      .map(({ req }) => req?.url);
    expect(urls).toEqual([`${CHUNKS}?[redacted]`]);
  });
});

it('answers a request without a token with the fixed 401 and no RAGFlow request', async () => {
  await withProxy(async ({ send }) => {
    const answer = await send(`${CHUNKS}?page=1&page_size=20`, { token: false });

    expect([answer.status, JSON.parse(answer.body)]).toEqual([401, UNAUTHORIZED]);
    expect(upstream.requests).toEqual([]);
  });
});

it.each(['HEAD', 'POST', 'DELETE'])(
  'declares no %s route for the chunks path and sends nothing to RAGFlow',
  async (method) => {
    await withProxy(async ({ send }) => {
      const answer = await send(`${CHUNKS}?page=1&page_size=20`, { method });

      expect(answer.status).toBe(404);
      expect(upstream.requests).toEqual([]);
    });
  },
);

it('answers not-configured without contacting RAGFlow while no address is saved', async () => {
  await withProxy(
    async ({ send }) => {
      const answer = await send(`${CHUNKS}?page=1&page_size=20`);

      expect([answer.status, JSON.parse(answer.body)]).toEqual([200, { result: 'not-configured' }]);
      expect(upstream.requests).toEqual([]);
    },
    { baseURL: '' },
  );
});

it('reports a refused port as unavailable', async () => {
  const refused = await refusedOrigin();
  await withProxy(
    async ({ send }) => {
      const answer = await send(`${CHUNKS}?page=1&page_size=20`);

      expect([answer.status, JSON.parse(answer.body)]).toEqual([200, { result: 'unavailable' }]);
    },
    { baseURL: refused },
  );
});

it('reaches the deadline before a status', async () => {
  upstream.setHandler(() => undefined);

  const outcome = await listRagflowChunks(
    { baseURL: upstream.origin, apiKey: RAGFLOW_KEY },
    DATASET,
    DOCUMENT,
    { page: 1, pageSize: 20 },
    new AbortController().signal,
    200,
  );

  expect(outcome).toEqual({ result: 'timeout' });
  expect(upstream.requests.map(({ path }) => path)).toEqual([upstreamPath(1, 20)]);
  await upstream.socketClosed(1);
});
