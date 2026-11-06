// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { AccountPage } from './account-page.tsx';
import { KnowledgeBasePage } from './knowledge-base-page.tsx';
import {
  button,
  change,
  click,
  element,
  holdResponseBody,
  renderAccountPage,
  settle,
} from '../test/account-dom-fixture.tsx';

const PATH = '/_platform/admin/knowledge-base';
const RAGFLOW_API = '/_platform/api/admin/ragflow-config';
const RETRIEVAL_API = '/_platform/api/admin/retrieval-config';
const TEST_API = '/_platform/api/admin/ragflow-config/test';
const CONNECTION = { baseURL: 'http://ragflow.intranet:9380', apiKeyConfigured: true };
const RETRIEVAL = {
  retrievalTopK: 8,
  retrievalSimilarityThreshold: 0.2,
  retrievalKeywordsWeight: 0.7,
  retrievalRerankId: '',
};
const HINT = '保存即生效：平台之后的每次知识库请求都使用新配置，不需要重启实例。';
const SAVED = '已保存，立即生效。';
const ADDRESS_INVALID =
  'RAGFlow 地址无效：须以 http:// 或 https:// 开头，不含空白、?、#、@ 或 \\，最长 2048 个字符。';
const PARAMETERS_INVALID =
  '检索参数无效：返回片段数为 1–100 的整数，相似度阈值和关键词权重为 0–1 之间的数，重排模型 ID 前后不能有空白。';
const TEST_FAILED = '连接测试请求失败，请重试。';
const LOAD_FAILED = '知识库配置加载失败，请重试。';
const SECRET = 'typed-ragflow-key-never-rendered';
const BUTTONS = ['保存连接配置', '保存检索参数', '测试连接'] as const;
type Reply = Response | Promise<Response> | (() => Promise<Response>);
const offline = () => Promise.reject(new Error('private-data'));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** Fetch stub keyed by `<method> <url>`; each key replays its queued replies in order. */
function serve(replies: Record<string, Reply[]>) {
  const queues = new Map(Object.entries(replies));
  return vi.fn<typeof fetch>((input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const key = `${init?.method ?? 'GET'} ${url}`;
    const next = queues.get(key)?.shift();
    if (next === undefined) return Promise.reject(new Error(`Unexpected ${key}`));
    return typeof next === 'function' ? next() : Promise.resolve(next);
  });
}
const loads = (connection: Reply = json(CONNECTION), retrieval: Reply = json(RETRIEVAL)) => ({
  [`GET ${RAGFLOW_API}`]: [connection],
  [`GET ${RETRIEVAL_API}`]: [retrieval],
});
async function flush(): Promise<void> {
  for (let round = 0; round < 4; round++) await settle();
}
async function render(replies: Record<string, Reply[]> = loads()) {
  const rendered = renderAccountPage(<KnowledgeBasePage />, PATH, serve(replies));
  await flush();
  return rendered;
}
function input(view: HTMLDivElement, id: string): HTMLInputElement {
  return element(view, `#${id}`, HTMLInputElement);
}
async function type(view: HTMLDivElement, id: string, value: string): Promise<void> {
  await settle(() => {
    change(input(view, id), value);
  });
}
async function press(view: HTMLDivElement, label: string): Promise<void> {
  await click(view, label);
  await flush();
}
function status(view: HTMLDivElement): { role: string | null; text: string } {
  const line = element(view, '#knowledge-base-status', HTMLElement);
  return { role: line.getAttribute('role'), text: line.textContent };
}
function sent(request: ReturnType<typeof serve>, index: number): unknown {
  const body = request.mock.calls[index]?.[1]?.body;
  if (typeof body !== 'string') throw new Error('Missing JSON payload');
  return JSON.parse(body);
}
function calls(request: ReturnType<typeof serve>): string[] {
  return request.mock.calls.map(
    ([input, init]) =>
      `${init?.method ?? 'GET'} ${input instanceof Request ? input.url : input.toString()}`,
  );
}
function expectNoConfiguration(view: HTMLDivElement): void {
  expect(view.querySelector('form, input, fieldset')).toBeNull();
  expect(view.querySelector('button')).toBeNull();
  expect(view.textContent).not.toContain('ragflow.intranet');
  expect(view.textContent).not.toContain('已配置');
  expect(view.textContent).not.toContain(HINT);
}
function retrievalValues(view: HTMLDivElement): string[] {
  return ['retrieval-top-k', 'retrieval-threshold', 'retrieval-weight', 'retrieval-rerank-id'].map(
    (id) => input(view, id).value,
  );
}

it('shows only the loading status, without forms, until both concurrent reads settle', async () => {
  const held = Promise.withResolvers<Response>();
  const { view, request } = await render(loads(held.promise));

  expect(status(view)).toEqual({ role: 'status', text: '加载中…' });
  expect(view.querySelector('form')).toBeNull();
  expect(calls(request)).toEqual([`GET ${RAGFLOW_API}`, `GET ${RETRIEVAL_API}`]);
  await settle(() => {
    held.resolve(json(CONNECTION));
  });
  await flush();
  expect(view.querySelectorAll('form')).toHaveLength(2);
});

it('dispatches the routed page and renders both sections with the fixed texts', async () => {
  const { view, request } = renderAccountPage(
    <AccountPage />,
    PATH,
    serve(loads(json({ ...CONNECTION, apiKeyConfigured: false }))),
  );
  await flush();

  expect(view.querySelector('a[aria-current="page"]')?.getAttribute('href')).toBe(PATH);
  expect(element(view, 'h1', HTMLElement).textContent).toBe('知识库');
  expect(view.textContent).toContain(HINT);
  const hint = [...view.querySelectorAll('p')].find((node) => node.textContent === HINT);
  expect(
    hint !== undefined &&
      Boolean(
        hint.compareDocumentPosition(element(view, 'form', HTMLFormElement)) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      ),
  ).toBe(true);
  expect(input(view, 'ragflow-base-url').value).toBe(CONNECTION.baseURL);
  expect(view.textContent).toContain(
    'RAGFlow 服务的根地址，例如 http://ragflow.intranet:9380；平台会在其后拼接 /api/v1/…',
  );
  const key = input(view, 'ragflow-key');
  expect([key.type, key.autocomplete, key.value]).toEqual(['password', 'new-password', '']);
  expect(element(view, '#ragflow-key-state', HTMLElement).textContent).toBe('未配置');
  expect(view.textContent).toContain('留空保留原密钥。');
  expect(view.textContent).toContain('测试使用上次保存的配置，未保存的修改不参与');
  expect(retrievalValues(view)).toEqual(['8', '0.2', '0.7', '']);
  const topK = input(view, 'retrieval-top-k');
  expect([topK.type, topK.min, topK.max, topK.step]).toEqual(['number', '1', '100', '1']);
  for (const id of ['retrieval-threshold', 'retrieval-weight']) {
    const ratio = input(view, id);
    expect([ratio.type, ratio.min, ratio.max, ratio.step]).toEqual(['number', '0', '1', 'any']);
  }
  expect(input(view, 'retrieval-rerank-id').type).toBe('text');
  expect(view.textContent).toContain('留空即不启用重排序');
  const retrieval = element(view, 'form[aria-label="检索参数"]', HTMLFormElement);
  expect(retrieval.noValidate).toBe(true);
  expect(view.querySelector('form[aria-label="RAGFlow 连接"]')).not.toBeNull();
  expect(status(view).text).toBe('');
  expect(calls(request)).toEqual([`GET ${RAGFLOW_API}`, `GET ${RETRIEVAL_API}`]);
});

it('shows 已配置 for a configured key', async () => {
  const { view } = await render();

  expect(element(view, '#ragflow-key-state', HTMLElement).textContent).toBe('已配置');
});

it('navigates to login exactly once only after both reads and bodies have settled', async () => {
  const sibling = Promise.withResolvers<Response>();
  const rejected = new Response('private-data', { status: 401 });
  const body = holdResponseBody(rejected);
  const { view, navigate } = await render(loads(rejected, sibling.promise));

  await settle(() => {
    sibling.resolve(json(RETRIEVAL));
  });
  await flush();
  expect(navigate).not.toHaveBeenCalled();
  await settle(() => {
    body.resolve(new ArrayBuffer(0));
  });
  await flush();

  expect(navigate.mock.calls).toEqual([['/_platform/login']]);
  expect(view.innerHTML).not.toContain('private-data');
});

it('waits for a pending sibling read before navigating on 401', async () => {
  const sibling = Promise.withResolvers<Response>();
  const { navigate } = await render(loads(json({}, 401), sibling.promise));

  expect(navigate).not.toHaveBeenCalled();
  await settle(() => {
    sibling.resolve(json({}, 403));
  });
  await flush();

  expect(navigate.mock.calls).toEqual([['/_platform/login']]);
});

it.each([
  [json({}, 403), json(RETRIEVAL)],
  [json(CONNECTION), json({}, 403)],
])('shows only 无权限 when a read is forbidden %#', async (connection, retrieval) => {
  const { view, navigate } = await render(loads(connection, retrieval));

  expect(status(view)).toEqual({ role: 'alert', text: '无权限' });
  expectNoConfiguration(view);
  expect(navigate).not.toHaveBeenCalled();
});

it.each([
  ['500', json(CONNECTION), json({ message: 'private-data' }, 500)],
  ['network', offline, json(RETRIEVAL)],
  ['extra field', json({ ...CONNECTION, apiKey: 'private-data' }), json(RETRIEVAL)],
  ['saved count on read', json(CONNECTION), json({ ...RETRIEVAL, runningInstances: 0 })],
  ['string number', json(CONNECTION), json({ ...RETRIEVAL, retrievalTopK: '8' })],
  ['missing field', json({ baseURL: '' }), json(RETRIEVAL)],
  ['string flag', json({ ...CONNECTION, apiKeyConfigured: 'true' }), json(RETRIEVAL)],
  ['numeric address', json({ ...CONNECTION, baseURL: 1 }), json(RETRIEVAL)],
  ['numeric rerank ID', json(CONNECTION), json({ ...RETRIEVAL, retrievalRerankId: 0 })],
  ['array body', json([]), json(RETRIEVAL)],
  ['unreadable', new Response('private-data'), json(RETRIEVAL)],
])('fails the whole page on a %s read and retries both reads', async (_name, first, second) => {
  const { view, request } = await render({
    [`GET ${RAGFLOW_API}`]: [first, json(CONNECTION)],
    [`GET ${RETRIEVAL_API}`]: [second, json(RETRIEVAL)],
  });

  expect(status(view)).toEqual({ role: 'alert', text: LOAD_FAILED });
  expect(view.querySelector('form, input')).toBeNull();
  expect(view.textContent).not.toContain('ragflow.intranet');
  expect(view.innerHTML).not.toContain('private-data');
  await press(view, '重试');
  expect(request).toHaveBeenCalledTimes(4);
  expect(calls(request).slice(2)).toEqual([`GET ${RAGFLOW_API}`, `GET ${RETRIEVAL_API}`]);
  expect(input(view, 'ragflow-base-url').value).toBe(CONNECTION.baseURL);
});

it.each([
  ['', undefined],
  [SECRET, SECRET],
])('saves the connection verbatim with key %j and clears the key box', async (key, apiKey) => {
  const request = serve({
    ...loads(json({ ...CONNECTION, apiKeyConfigured: false })),
    [`PUT ${RAGFLOW_API}`]: [
      json({ baseURL: '  http://other:9380 ', apiKeyConfigured: true, runningInstances: 2 }),
    ],
  });
  const { view } = renderAccountPage(<KnowledgeBasePage />, PATH, request);
  await flush();
  await type(view, 'ragflow-base-url', '  http://other:9380 ');
  await type(view, 'ragflow-key', key);

  await press(view, '保存连接配置');

  expect(request.mock.calls[2]?.[0]).toBe(RAGFLOW_API);
  expect(request.mock.calls[2]?.[1]?.method).toBe('PUT');
  expect(sent(request, 2)).toEqual(
    apiKey === undefined
      ? { baseURL: '  http://other:9380 ' }
      : { baseURL: '  http://other:9380 ', apiKey },
  );
  expect(input(view, 'ragflow-key').value).toBe('');
  expect(element(view, '#ragflow-key-state', HTMLElement).textContent).toBe('已配置');
  expect(status(view)).toEqual({ role: 'status', text: SAVED });
  expect(view.textContent).not.toContain('运行中');
  expect(view.innerHTML).not.toContain(SECRET);
});

it.each([
  ['', SECRET, '请输入 RAGFlow 地址。'],
  [CONNECTION.baseURL, ' \t ', '密钥不能只包含空白字符。'],
])('rejects address %j with key %j without a request', async (address, key, message) => {
  const { view, request } = await render();
  await type(view, 'ragflow-base-url', address);
  await type(view, 'ragflow-key', key);

  await press(view, '保存连接配置');

  expect(request).toHaveBeenCalledTimes(2);
  expect(status(view)).toEqual({ role: 'alert', text: message });
  expect(input(view, 'ragflow-key').value).toBe(key);
});

it('leaves a blank but non-empty address to the server rule', async () => {
  const request = serve({ ...loads(), [`PUT ${RAGFLOW_API}`]: [json({}, 400)] });
  const { view } = renderAccountPage(<KnowledgeBasePage />, PATH, request);
  await flush();
  await type(view, 'ragflow-base-url', '   ');

  await press(view, '保存连接配置');

  expect(sent(request, 2)).toEqual({ baseURL: '   ' });
  expect(status(view)).toEqual({ role: 'alert', text: ADDRESS_INVALID });
});

it.each([
  ['400', json({ message: 'private-data' }, 400), ADDRESS_INVALID],
  ['500', json({ message: 'private-data' }, 500), '保存失败，请重试。'],
  ['network', offline, '保存失败，请重试。'],
  ['missing count', json(CONNECTION), '保存失败，请重试。'],
  ['negative count', json({ ...CONNECTION, runningInstances: -1 }), '保存失败，请重试。'],
  ['fractional count', json({ ...CONNECTION, runningInstances: 0.5 }), '保存失败，请重试。'],
  ['string count', json({ ...CONNECTION, runningInstances: '2' }), '保存失败，请重试。'],
])('reports a %s connection save with its fixed text', async (_name, reply, message) => {
  const { view } = await render({ ...loads(), [`PUT ${RAGFLOW_API}`]: [reply] });
  await type(view, 'ragflow-base-url', 'http://typed:9380');
  await type(view, 'ragflow-key', SECRET);

  await press(view, '保存连接配置');

  expect(status(view)).toEqual({ role: 'alert', text: message });
  expect(input(view, 'ragflow-key').value).toBe('');
  expect(input(view, 'ragflow-base-url').value).toBe('http://typed:9380');
  expect(view.innerHTML).not.toContain('private-data');
  for (const label of BUTTONS) expect(button(view, label).disabled).toBe(false);
});

it('saves the retrieval parameters as numbers and leaves the connection draft untouched', async () => {
  const saved = {
    retrievalTopK: 3,
    retrievalSimilarityThreshold: 0.5,
    retrievalKeywordsWeight: 1,
    retrievalRerankId: ' rr ',
  };
  const request = serve({
    ...loads(),
    [`PUT ${RETRIEVAL_API}`]: [json({ ...saved, runningInstances: 0 })],
  });
  const { view } = renderAccountPage(<KnowledgeBasePage />, PATH, request);
  await flush();
  await type(view, 'ragflow-base-url', 'http://unsaved:9380');
  await type(view, 'retrieval-top-k', '3');
  await type(view, 'retrieval-threshold', '0.50');
  await type(view, 'retrieval-weight', '1');
  await type(view, 'retrieval-rerank-id', ' rr ');

  await press(view, '保存检索参数');

  expect(request.mock.calls[2]?.[0]).toBe(RETRIEVAL_API);
  expect(request.mock.calls[2]?.[1]?.method).toBe('PUT');
  expect(sent(request, 2)).toEqual(saved);
  expect(status(view)).toEqual({ role: 'status', text: SAVED });
  expect(retrievalValues(view)).toEqual(['3', '0.5', '1', ' rr ']);
  expect(input(view, 'ragflow-base-url').value).toBe('http://unsaved:9380');
  expect(element(view, '#ragflow-key-state', HTMLElement).textContent).toBe('已配置');
});

it.each([
  ['retrieval-top-k', ''],
  ['retrieval-threshold', ''],
  ['retrieval-weight', '1e400'],
])('rejects %s value %j without a request', async (id, value) => {
  const { view, request } = await render();
  await type(view, id, value);

  await press(view, '保存检索参数');

  expect(request).toHaveBeenCalledTimes(2);
  expect(status(view)).toEqual({ role: 'alert', text: PARAMETERS_INVALID });
});

it('rejects a non-finite typed number without a request', async () => {
  const { view, request } = await render();
  input(view, 'retrieval-top-k').type = 'text';
  await type(view, 'retrieval-top-k', 'Infinity');

  await press(view, '保存检索参数');

  expect(request).toHaveBeenCalledTimes(2);
  expect(status(view)).toEqual({ role: 'alert', text: PARAMETERS_INVALID });
});

it('sends out-of-range values and shows the parameter line for a 400', async () => {
  const request = serve({
    ...loads(),
    [`PUT ${RETRIEVAL_API}`]: [json({ message: 'private-data' }, 400)],
  });
  const { view } = renderAccountPage(<KnowledgeBasePage />, PATH, request);
  await flush();
  await type(view, 'retrieval-top-k', '0');

  await press(view, '保存检索参数');

  expect(sent(request, 2)).toEqual({ ...RETRIEVAL, retrievalTopK: 0 });
  expect(status(view)).toEqual({ role: 'alert', text: PARAMETERS_INVALID });
  expect(retrievalValues(view)).toEqual(['0', '0.2', '0.7', '']);
  expect(view.innerHTML).not.toContain('private-data');
});

it.each([
  ['500', json({}, 500)],
  ['extra field', json({ ...RETRIEVAL, retrievalTopK: 4, extra: 1, runningInstances: 0 })],
  ['missing count', json(RETRIEVAL)],
  ['nonfinite count', json({ ...RETRIEVAL, runningInstances: null })],
])('reports a %s retrieval save as a failure', async (_name, reply) => {
  const { view } = await render({ ...loads(), [`PUT ${RETRIEVAL_API}`]: [reply] });

  await press(view, '保存检索参数');

  expect(status(view)).toEqual({ role: 'alert', text: '保存失败，请重试。' });
  expect(retrievalValues(view)).toEqual(['8', '0.2', '0.7', '']);
});

it.each([
  ['ok', { result: 'ok', version: 'v1.0.0-rc2' }, 'status', '连接成功，RAGFlow 版本：v1.0.0-rc2'],
  [
    'not-configured',
    { result: 'not-configured' },
    'alert',
    '未配置 RAGFlow 地址或密钥，或密钥被拒绝',
  ],
  ['unavailable', { result: 'unavailable' }, 'alert', '无法连接到 RAGFlow 地址'],
  ['timeout', { result: 'timeout' }, 'alert', '连接 RAGFlow 超时'],
  ['upstream-error', { result: 'upstream-error' }, 'alert', 'RAGFlow 返回了异常结果'],
])('explains the %s test result with its own text', async (_name, body, role, text) => {
  const request = serve({ ...loads(), [`POST ${TEST_API}`]: [json(body)] });
  const { view } = renderAccountPage(<KnowledgeBasePage />, PATH, request);
  await flush();
  await type(view, 'ragflow-base-url', 'http://unsaved:9380');
  await type(view, 'ragflow-key', SECRET);

  await press(view, '测试连接');

  expect(request.mock.calls[2]?.[0]).toBe(TEST_API);
  expect(request.mock.calls[2]?.[1]?.method).toBe('POST');
  expect(sent(request, 2)).toEqual({});
  expect(status(view)).toEqual({ role, text });
  expect(input(view, 'ragflow-key').value).toBe(SECRET);
  expect(input(view, 'ragflow-base-url').value).toBe('http://unsaved:9380');
});

it('renders a printable version as text, never as markup', async () => {
  const version = '<b>x</b>';
  const { view } = await render({
    ...loads(),
    [`POST ${TEST_API}`]: [json({ result: 'ok', version })],
  });

  await press(view, '测试连接');

  expect(status(view).text).toBe(`连接成功，RAGFlow 版本：${version}`);
  expect(view.querySelector('#knowledge-base-status b')).toBeNull();
});

it.each([
  ['ok without version', json({ result: 'ok' })],
  ['empty version', json({ result: 'ok', version: '' })],
  ['65-character version', json({ result: 'ok', version: 'v'.repeat(65) })],
  ['control character', json({ result: 'ok', version: 'v1\u0007' })],
  ['non-ASCII version', json({ result: 'ok', version: 'v1。' })],
  ['numeric version', json({ result: 'ok', version: 1 })],
  ['extra field', json({ result: 'ok', version: 'v1', elapsedMs: 3 })],
  ['failure with version', json({ result: 'timeout', version: 'v1' })],
  ['unknown result', json({ result: 'mystery' })],
  ['__proto__ result', json({ result: '__proto__' })],
  ['constructor result', json({ result: 'constructor' })],
  ['toString result', json({ result: 'toString' })],
  ['non-object', json('ok')],
  ['500', json({ result: 'ok', version: 'v1' }, 500)],
  ['network', offline],
])('treats a %s test answer as a failed request', async (_name, reply) => {
  const { view } = await render({ ...loads(), [`POST ${TEST_API}`]: [reply] });

  await press(view, '测试连接');

  expect(status(view)).toEqual({ role: 'alert', text: TEST_FAILED });
  for (const label of BUTTONS) expect(button(view, label).disabled).toBe(false);
});

it.each([
  ['保存连接配置', `PUT ${RAGFLOW_API}`, 401],
  ['保存连接配置', `PUT ${RAGFLOW_API}`, 403],
  ['保存检索参数', `PUT ${RETRIEVAL_API}`, 401],
  ['保存检索参数', `PUT ${RETRIEVAL_API}`, 403],
  ['测试连接', `POST ${TEST_API}`, 401],
  ['测试连接', `POST ${TEST_API}`, 403],
])('a %s denial (%s %i) removes every form and obeys redirect policy', async (label, key, code) => {
  const request = serve({ ...loads(), [key]: [new Response('private-data', { status: code })] });
  const { view, navigate } = renderAccountPage(<KnowledgeBasePage />, PATH, request);
  await flush();
  await type(view, 'ragflow-key', SECRET);

  await press(view, label);

  expect(status(view)).toEqual({ role: 'alert', text: '无权限' });
  expectNoConfiguration(view);
  expect(view.innerHTML).not.toContain(SECRET);
  expect(view.innerHTML).not.toContain('private-data');
  expect(navigate.mock.calls).toEqual(code === 401 ? [['/_platform/login']] : []);
  expect(request).toHaveBeenCalledTimes(3);
});

it.each([
  ['保存连接配置', `PUT ${RAGFLOW_API}`, '正在保存…'],
  ['保存检索参数', `PUT ${RETRIEVAL_API}`, '正在保存…'],
  ['测试连接', `POST ${TEST_API}`, '正在测试连接…'],
])('fences every control while %s is pending', async (label, key, pending) => {
  const held = Promise.withResolvers<Response>();
  const request = serve({ ...loads(), [key]: [held.promise] });
  const { view } = renderAccountPage(<KnowledgeBasePage />, PATH, request);
  await flush();
  await settle(() => {
    button(view, label).click();
    button(view, label).click();
  });

  expect(status(view)).toEqual({ role: 'status', text: pending });
  for (const name of BUTTONS) expect(button(view, name).matches(':disabled')).toBe(true);
  expect([...view.querySelectorAll('fieldset')].every((node) => node.disabled)).toBe(true);
  await settle(() => {
    for (const form of view.querySelectorAll('form'))
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    button(view, '测试连接').click();
  });
  expect(request).toHaveBeenCalledTimes(3);
  await settle(() => {
    held.resolve(json({}, 500));
  });
  await flush();
  for (const name of BUTTONS) expect(button(view, name).matches(':disabled')).toBe(false);
  expect(request).toHaveBeenCalledTimes(3);
});

it('keeps the fence until the save response body has been read', async () => {
  const response = json({ ...CONNECTION, runningInstances: 0 });
  const body = Promise.withResolvers<unknown>();
  vi.spyOn(response, 'json').mockReturnValue(body.promise);
  const { view } = await render({ ...loads(), [`PUT ${RAGFLOW_API}`]: [response] });

  await press(view, '保存连接配置');
  expect(status(view).text).toBe('正在保存…');
  expect(button(view, '测试连接').disabled).toBe(true);
  await settle(() => {
    body.resolve({ ...CONNECTION, runningInstances: 0 });
  });
  await flush();

  expect(status(view).text).toBe(SAVED);
});

it.each([
  ['load', undefined],
  ['connection', '保存连接配置'],
  ['retrieval', '保存检索参数'],
  ['test', '测试连接'],
] as const)(
  'unmounting aborts the in-flight %s and its late completion changes nothing',
  async (_stage, label) => {
    const pending = Promise.withResolvers<Response>();
    const replies =
      label === undefined
        ? loads(pending.promise)
        : {
            ...loads(),
            [`PUT ${RAGFLOW_API}`]: [pending.promise],
            [`PUT ${RETRIEVAL_API}`]: [pending.promise],
            [`POST ${TEST_API}`]: [pending.promise],
          };
    const request = serve(replies);
    const { view, unmount, navigate } = renderAccountPage(<KnowledgeBasePage />, PATH, request);
    await flush();
    if (label !== undefined) await click(view, label);
    const signal = request.mock.calls.at(-1)?.[1]?.signal;

    unmount();
    await settle(() => {
      pending.resolve(json({}, 401));
    });
    await flush();

    expect(signal?.aborted).toBe(true);
    expect(view.innerHTML).toBe('');
    expect(navigate).not.toHaveBeenCalled();
  },
);
