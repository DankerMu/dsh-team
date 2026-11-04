import { afterEach, expect, it, vi } from 'vitest';
import { retrieveRagflow } from './client.ts';

const KEY = 'owned-nonsecret-ragflow-key';
const BASE = 'https://kb.invalid';
const LIST_URL =
  'https://kb.invalid/api/v1/datasets?page=1&page_size=1001&orderby=create_time&desc=false';
const RETRIEVAL_URL = 'https://kb.invalid/api/v1/retrieval';
const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const C = 'c'.repeat(32);
const D = 'd'.repeat(32);
const SETTINGS = {
  baseURL: BASE,
  apiKey: KEY,
  retrievalTopK: 8,
  retrievalSimilarityThreshold: 0.2,
  retrievalKeywordsWeight: 0.7,
  retrievalRerankId: '',
};
const QUESTION = ' 年假怎么申请？ ';

type Send = (request: Request, init: { signal: AbortSignal }) => Promise<Response>;
type Respond = (request: Request, signal: AbortSignal) => Promise<Response> | Response;
/** RAGFlow v1.0.0-rc2 list rows carry far more than the proxy uses. */
function listing(rows: readonly (readonly [string, string])[]): string {
  const data = rows.map(([id, name]) => ({ id, name, avatar: 'data:image/png;base64,AAAA' }));
  return JSON.stringify({ code: 0, data, total_datasets: data.length, message: 'success' });
}
const LISTED = listing([
  [A, '库甲'],
  [C, '库丙'],
]);
/** An rc2 retrieval chunk: every field beside the four the proxy reads is dropped. */
function chunk(datasetId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'e'.repeat(32),
    content: '片段正文',
    content_ltks: '片段 正文',
    document_id: 'f'.repeat(32),
    document_keyword: '制度.pdf',
    dataset_id: datasetId,
    highlight: 'dropped',
    image_id: '',
    important_keywords: ['dropped'],
    questions: ['dropped'],
    similarity: 0.9,
    term_similarity: 0.8,
    vector_similarity: 0.95,
    doc_type_kwd: '',
    positions: [],
    ...extra,
  };
}
function answer(chunks: unknown): string {
  const data = { chunks, doc_aggs: [{ doc_name: 'dropped' }], labels: [], total: 1 };
  return JSON.stringify({ code: 0, data, message: 'success' });
}
/** Answers the preflight list with `list` and the retrieval with `retrieval`. */
function steps(retrieval: Respond, list: Respond = () => new Response(LISTED)) {
  return vi.fn<Send>((request, init) =>
    Promise.resolve(
      request.url.endsWith('/api/v1/retrieval')
        ? retrieval(request, init.signal)
        : list(request, init.signal),
    ),
  );
}
function retrieve(
  send: Send,
  options: { settings?: Partial<typeof SETTINGS>; ids?: string[]; deadlineMs?: number } = {},
) {
  return retrieveRagflow(
    { ...SETTINGS, ...options.settings },
    { question: QUESTION, datasetIds: options.ids ?? [A] },
    new AbortController().signal,
    options.deadlineMs ?? 1_000,
    send,
  );
}
/** The JSON body of the n-th sent request. */
async function sentBody(send: ReturnType<typeof steps>, index: number): Promise<unknown> {
  const request = send.mock.calls[index]?.[0];
  return request === undefined ? undefined : JSON.parse(await request.text());
}
/** Endless zero chunks whose first exceeds `limit` by one byte; `pulls` counts the reads. */
function oversizedBody(limit: number, pulls: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls.push(pulls.length);
      controller.enqueue(new Uint8Array(pulls.length === 1 ? limit + 1 : 1_048_576));
    },
  });
}
/** A body that stays open until the request signal aborts, like undici's fetch body. */
function heldBody(signal: AbortSignal): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"code":0,'));
      signal.addEventListener('abort', () => {
        controller.error(signal.reason);
      });
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

it.each([
  ['an empty address', { baseURL: '' }],
  ['an empty key', { apiKey: '' }],
  ['a key that cannot form a header', { apiKey: `${KEY}\nX-Injected: 1` }],
])('retrieves nothing for %s and reports not-configured', async (_label, settings) => {
  const send = steps(() => new Response(answer([chunk(A)])));

  expect(await retrieve(send, { settings })).toStrictEqual({ result: 'not-configured' });
  expect(send).not.toHaveBeenCalled();
});

it.each([
  ['a rejected key', () => new Response('{"code":401}', { status: 401 }), 'not-configured'],
  ['a refused connection', () => Promise.reject(new TypeError('fetch failed')), 'unavailable'],
  ['a non-zero code', () => new Response('{"code":102,"data":[]}'), 'upstream-error'],
  [
    'a stalled body',
    (_r: Request, signal: AbortSignal) => new Response(heldBody(signal)),
    'timeout',
  ],
] as const)(
  'returns a preflight list failure from %s as the result without retrieving',
  async (_label, list, result) => {
    const send = steps(() => new Response(answer([chunk(A)])), list);

    expect(await retrieve(send, { deadlineMs: 20 })).toStrictEqual({ result });
    expect(send.mock.calls.map(([request]) => request.url)).toEqual([LIST_URL]);
  },
);

it('lists the datasets, then posts one retrieval and returns only the chunk text and names', async () => {
  const send = steps(() => new Response(answer([chunk(A), chunk(C, { content: '第二段' })])));

  const outcome = await retrieve(send, { ids: [A, C] });

  expect(outcome).toStrictEqual({
    result: 'ok',
    excluded: [],
    chunks: [
      { content: '片段正文', documentName: '制度.pdf', datasetName: '库甲' },
      { content: '第二段', documentName: '制度.pdf', datasetName: '库丙' },
    ],
  });
  const [list, retrieval] = send.mock.calls.map(([request]) => request);
  expect(send).toHaveBeenCalledTimes(2);
  expect(list?.url).toBe(LIST_URL);
  expect([retrieval?.method, retrieval?.url, retrieval?.redirect]).toEqual([
    'POST',
    RETRIEVAL_URL,
    'manual',
  ]);
  expect(retrieval?.headers.get('authorization')).toBe(`Bearer ${KEY}`);
  expect(retrieval?.headers.get('content-type')).toBe('application/json');
  expect(await sentBody(send, 1)).toStrictEqual({
    question: QUESTION,
    dataset_ids: [A, C],
    page: 1,
    page_size: 8,
    similarity_threshold: 0.2,
    keywords_similarity_weight: 0.7,
    rerank_candidates_count: 64,
    include_knowledge_compilation: false,
  });
});

it('applies the saved retrieval parameters and sends a non-empty rerank ID verbatim', async () => {
  const send = steps(() => new Response(answer([chunk(A)])));
  const settings = {
    retrievalTopK: 3,
    retrievalSimilarityThreshold: 0.5,
    retrievalKeywordsWeight: 0.3,
    retrievalRerankId: 'bge-reranker-v2-m3@Xinference',
  };

  await retrieve(send, { settings });

  const body = await sentBody(send, 1);
  expect(body).toStrictEqual({
    question: QUESTION,
    dataset_ids: [A],
    page: 1,
    page_size: 3,
    similarity_threshold: 0.5,
    keywords_similarity_weight: 0.3,
    rerank_id: 'bge-reranker-v2-m3@Xinference',
    rerank_candidates_count: 64,
    include_knowledge_compilation: false,
  });
  expect(Object.keys(body as object)).not.toContain('top_k');
  expect(Object.keys(body as object)).not.toContain('vector_similarity_weight');
});

it.each([
  [1, 64],
  [8, 64],
  [64, 64],
  [65, 65],
  [100, 100],
])(
  'sends %i chunks per page with %i rerank candidates, never fewer than rc2 needs',
  async (topK, candidates) => {
    const send = steps(() => new Response(answer([])));

    await retrieve(send, { settings: { retrievalTopK: topK } });

    expect(await sentBody(send, 1)).toMatchObject({
      page: 1,
      page_size: topK,
      rerank_candidates_count: candidates,
    });
  },
);

it('retrieves only the listed datasets in request order and reports the others as excluded', async () => {
  const send = steps(() => new Response(answer([chunk(C)])));

  const outcome = await retrieve(send, { ids: [C, B, A, D] });

  expect(outcome).toStrictEqual({
    result: 'ok',
    excluded: [B, D],
    chunks: [{ content: '片段正文', documentName: '制度.pdf', datasetName: '库丙' }],
  });
  expect(await sentBody(send, 1)).toMatchObject({ dataset_ids: [C, A] });
});

it('reports no-results with every requested ID excluded and never retrieves an empty scope', async () => {
  const send = steps(() => new Response(answer([chunk(B)])));

  const outcome = await retrieve(send, { ids: [B, D] });

  expect(outcome).toStrictEqual({ result: 'no-results', excluded: [B, D] });
  expect(send.mock.calls.map(([request]) => request.url)).toEqual([LIST_URL]);
});

it('reports a retrieval without chunks as no-results, not an error', async () => {
  const send = steps(() => new Response(answer([])));

  expect(await retrieve(send, { ids: [A, B] })).toStrictEqual({
    result: 'no-results',
    excluded: [B],
  });
});

it.each([
  ['an excluded dataset', B],
  ['an unlisted dataset', D],
  ['a listed dataset outside the request', C],
])('fails the whole retrieval when one chunk belongs to %s', async (_label, datasetId) => {
  const send = steps(() => new Response(answer([chunk(A), chunk(datasetId)])));

  expect(await retrieve(send, { ids: [A, B] })).toStrictEqual({ result: 'upstream-error' });
});

it.each([
  ['an empty array', []],
  ['null', null],
  ['a missing field', undefined],
])('omits positions given as %s instead of inventing them', async (_label, positions) => {
  const send = steps(() => new Response(answer([chunk(A, { positions })])));

  const outcome = await retrieve(send);

  expect(outcome).toStrictEqual({
    result: 'ok',
    excluded: [],
    chunks: [{ content: '片段正文', documentName: '制度.pdf', datasetName: '库甲' }],
  });
});

it('returns positions verbatim, up to 1024 five-number tuples', async () => {
  const many = Array.from({ length: 1_024 }, (_value, index) => [index, 1.5, 2, -3, 0]);
  const send = steps(
    () =>
      new Response(
        answer([chunk(A, { positions: [[1, 10, 20, 30, 40]] }), chunk(A, { positions: many })]),
      ),
  );

  const outcome = await retrieve(send, { settings: { retrievalTopK: 2 } });

  expect(outcome).toStrictEqual({
    result: 'ok',
    excluded: [],
    chunks: [
      {
        content: '片段正文',
        documentName: '制度.pdf',
        datasetName: '库甲',
        positions: [[1, 10, 20, 30, 40]],
      },
      { content: '片段正文', documentName: '制度.pdf', datasetName: '库甲', positions: many },
    ],
  });
});

it.each([
  ['a four-number tuple', [[1, 10, 20, 30]]],
  ['a six-number tuple', [[1, 10, 20, 30, 40, 50]]],
  ['a string member', [[1, '10', 20, 30, 40]]],
  ['a null member', [[1, null, 20, 30, 40]]],
  ['a tuple that is not an array', [{ 0: 1, 1: 10, 2: 20, 3: 30, 4: 40, length: 5 }]],
  ['1025 tuples', Array.from({ length: 1_025 }, () => [1, 10, 20, 30, 40])],
  ['an object', { page: 1 }],
  ['a number', 1],
])('fails the whole retrieval on positions with %s', async (_label, positions) => {
  const send = steps(() => new Response(answer([chunk(A), chunk(A, { positions })])));

  expect(await retrieve(send)).toStrictEqual({ result: 'upstream-error' });
});

it('fails the whole retrieval on a position that does not fit a finite number', async () => {
  const body = answer([chunk(A, { positions: [[1, 10, 20, 30, 40]] })]).replace('40', '1e400');
  const send = steps(() => new Response(body));

  expect(body).toContain('1e400');
  expect(await retrieve(send)).toStrictEqual({ result: 'upstream-error' });
});

it('accepts a document name of exactly 1024 UTF-8 bytes and empty chunk text', async () => {
  const name = '库'.repeat(341) + 'x';
  const send = steps(
    () => new Response(answer([chunk(A, { document_keyword: name, content: '' })])),
  );

  expect(Buffer.byteLength(name)).toBe(1_024);
  expect(await retrieve(send)).toStrictEqual({
    result: 'ok',
    excluded: [],
    chunks: [{ content: '', documentName: name, datasetName: '库甲' }],
  });
});

const NINE = Array.from({ length: 9 }, () => chunk(A));
it.each([
  ['more chunks than the saved chunk count', answer(NINE)],
  ['a null data', JSON.stringify({ code: 0, data: null })],
  ['an array data', JSON.stringify({ code: 0, data: [] })],
  ['a missing data', JSON.stringify({ code: 0 })],
  ['non-array chunks', JSON.stringify({ code: 0, data: { chunks: {} } })],
  ['missing chunks', JSON.stringify({ code: 0, data: { total: 0 } })],
  ['a null chunk', answer([null])],
  ['a string chunk', answer(['片段'])],
  ['non-string content', answer([chunk(A, { content: 7 })])],
  ['missing content', answer([chunk(A, { content: undefined })])],
  ['an empty document name', answer([chunk(A, { document_keyword: '' })])],
  ['a numeric document name', answer([chunk(A, { document_keyword: 7 })])],
  ['a missing document name', answer([chunk(A, { document_keyword: undefined })])],
  [
    'a document name over 1024 UTF-8 bytes',
    answer([chunk(A, { document_keyword: '库'.repeat(341) + 'xx' })]),
  ],
  ['a numeric dataset ID', answer([chunk(A, { dataset_id: 7 })])],
  ['a missing dataset ID', answer([chunk(A, { dataset_id: undefined })])],
  ['code 102', '{"code":102,"data":null,"message":"embedding models differ"}'],
  ['code 101', '{"code":101,"data":null,"message":"bad argument"}'],
  ['an unparseable body', '{"code":0,'],
  ['a redirect status', null],
])('reports a retrieval answer with %s as upstream-error', async (_label, body) => {
  const send = steps(() =>
    body === null ? new Response(null, { status: 302 }) : new Response(body),
  );

  expect(await retrieve(send)).toStrictEqual({ result: 'upstream-error' });
  expect(send).toHaveBeenCalledTimes(2);
});

it('maps a rejected key during retrieval (code 401) to not-configured', async () => {
  const send = steps(() => new Response('{"code":401,"message":"Invalid access token"}'));

  expect(await retrieve(send)).toStrictEqual({ result: 'not-configured' });
});

it('reads a retrieval answer larger than 64 KiB and rejects one byte over 8 MiB unread', async () => {
  const pulls: number[] = [];
  const padded = answer([chunk(A, { content_ltks: 'x'.repeat(8_388_608 - 1_000) })]);

  const large = await retrieve(steps(() => new Response(padded)));
  const oversized = await retrieve(steps(() => new Response(oversizedBody(8_388_608, pulls))));

  expect(new TextEncoder().encode(padded).byteLength).toBeLessThanOrEqual(8_388_608);
  expect(new TextEncoder().encode(padded).byteLength).toBeGreaterThan(8_388_608 - 1_000);
  expect(large.result).toBe('ok');
  expect(oversized).toStrictEqual({ result: 'upstream-error' });
  expect(pulls.length).toBeLessThanOrEqual(2);
});

it.each([
  ['a refused connection', () => Promise.reject(new TypeError('fetch failed')), 'unavailable'],
  [
    'a stalled body',
    (_r: Request, signal: AbortSignal) => new Response(heldBody(signal)),
    'timeout',
  ],
] as const)('maps %s during retrieval to its closed result', async (_label, respond, result) => {
  const send = steps(respond);

  expect(await retrieve(send, { deadlineMs: 20 })).toStrictEqual({ result });
  expect(send).toHaveBeenCalledTimes(2);
});

it('gives the preflight list and the retrieval each their own deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  // Each step spends most of the deadline; one shared deadline would expire in the second.
  const spend: Respond = (request, signal) => {
    vi.advanceTimersByTime(900);
    signal.throwIfAborted();
    return new Response(request.url === LIST_URL ? LISTED : answer([chunk(A)]));
  };

  const outcome = await retrieve(steps(spend, spend), { deadlineMs: 1_000 });

  expect(outcome.result).toBe('ok');
});

it.each(['the preflight list', 'the retrieval'])(
  'propagates an external cancellation during %s instead of classifying it',
  async (step) => {
    const owner = new AbortController();
    const held: Respond = (_request, signal) => {
      queueMicrotask(() => {
        owner.abort();
      });
      return new Response(heldBody(signal));
    };
    const send = step === 'the retrieval' ? steps(held) : steps(() => new Response('{}'), held);

    await expect(
      retrieveRagflow(
        SETTINGS,
        { question: QUESTION, datasetIds: [A] },
        owner.signal,
        60_000,
        send,
      ),
    ).rejects.toThrow();
  },
);
