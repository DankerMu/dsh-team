// @vitest-environment jsdom
/* global window */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, create } from 'react-test-renderer';

const loads = [];
window.__ModuleLoader__ = { load: (registration) => loads.push(registration) };
await import('./client.js');
Reflect.deleteProperty(window, '__ModuleLoader__');

const GLOBAL = '__DSH_TEAM_KNOWLEDGE_BASE__';
const STATE = 'data-dsh-team-kb-state';
const POLICIES = '0123456789abcdef0123456789abcdef';
const CONTRACTS = 'fedcba9876543210fedcba9876543210';
const EXPENSE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ATTENDANCE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SEEDED = {
  result: 'ok',
  datasets: [
    { id: POLICIES, name: 'Seed-Policies' },
    { id: CONTRACTS, name: '合同库' },
  ],
};
const FILES = {
  result: 'ok',
  total: 2,
  documents: [
    { id: ATTENDANCE, name: 'attendance-policy.txt' },
    { id: EXPENSE, name: 'expense-policy.txt' },
  ],
};
const chunksUrl = (documentId, page, datasetId = POLICIES) =>
  `api/knowledge-base.chunks?datasetId=${datasetId}&documentId=${documentId}` +
  `&page=${String(page)}&pageSize=20`;
const PREVIEW_TEXT = {
  loading: '正在加载内容…',
  'not-configured': '知识库未配置，无法预览文件',
  failed: '内容加载失败',
  empty: '该文件没有可预览的内容',
};

const plugin = loads[0]?.factory(() => React);

let calls;
let responses;
let consoleSpies;
let execute;
/** When set, the fetch mock ignores its abort signal, as a fetch that already has its answer. */
let ignoreAbort;
const mounted = [];
beforeEach(() => {
  calls = [];
  responses = [];
  ignoreAbort = false;
  execute = vi.fn(() => Promise.resolve({ ok: true, value: { result: { kind: 'success' } } }));
  vi.stubGlobal(
    'fetch',
    vi.fn((url, init) => {
      const deferred = Promise.withResolvers();
      if (!ignoreAbort)
        init.signal.addEventListener('abort', () =>
          deferred.reject(new DOMException('aborted', 'AbortError')),
        );
      calls.push({ url, init, deferred });
      return deferred.promise;
    }),
  );
  consoleSpies = ['log', 'info', 'warn', 'error', 'debug'].map((method) =>
    vi.spyOn(console, method),
  );
});
afterEach(() => {
  for (const view of mounted.splice(0)) act(() => view.unmount());
  for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  for (const response of responses) expect(response.text).toHaveBeenCalledTimes(1);
  for (const { url } of calls) expect(url.startsWith('api/knowledge-base.')).toBe(true);
  // Browsing and previewing never write the retrieval scope.
  expect(execute).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, GLOBAL);
});

async function respond(index, body, status = 200) {
  const response = {
    status,
    text: vi.fn(() => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body))),
  };
  responses.push(response);
  await act(async () => {
    calls[index].deferred.resolve(response);
  });
}

function textOf(node) {
  if (typeof node === 'string') return node;
  return node.children.map(textOf).join('');
}

/**
 * The 「知识库」 page with its library list answered and POLICIES expanded on its two files.
 * `scroller` stands in for the scrollable `[data-dsh-team-kb-page]` element.
 */
async function previewPage(scroller = { scrollTop: 0 }) {
  globalThis[GLOBAL] = { available: true };
  const registered = [];
  plugin.apply({
    slots: {
      inject: (_slot, installSlot) => installSlot(),
      register: (options, component) => {
        registered.push({ options, component });
        return () => {};
      },
    },
    remote: { commands: { execute } },
  });
  const Page = registered.find(({ options }) => options.name === 'main').component;
  let view;
  act(() => {
    view = create(React.createElement(Page, {}), {
      createNodeMock: (element) =>
        element.props['data-dsh-team-kb-page'] === undefined ? null : scroller,
    });
  });
  mounted.push(view);
  const root = () => view.root;
  const find = (predicate) => root().findAll(predicate);
  const button = (scope, label) =>
    scope.find((node) => node.type === 'button' && textOf(node) === label);
  const click = async (scope, label) => {
    await act(async () => {
      button(scope, label).props.onClick();
    });
  };
  const preview = () => find((node) => node.props['data-dsh-team-kb-preview'] !== undefined);
  const page = {
    view,
    button,
    click,
    preview,
    previewState: () => preview()[0]?.props[STATE],
    previewText: () => textOf(preview()[0]),
    chunks: () =>
      preview()[0].findAll((node) => node.props['data-dsh-team-kb-chunk'] !== undefined),
    list: () => root().find((node) => node.props['data-dsh-team-kb-datasets'] === ''),
    files: () => find((node) => node.props['data-dsh-team-kb-files'] === POLICIES),
    async open(documentId) {
      const row = root().find((node) => node.props['data-dsh-team-kb-file'] === documentId);
      await act(async () => {
        row.findByType('button').props.onClick();
      });
    },
    async back() {
      await click(preview()[0], '返回列表');
    },
    /** Every ancestor of the library list is shown. */
    listShown() {
      for (let node = page.list(); node !== null; node = node.parent)
        if (node.props?.hidden === true) return false;
      return true;
    },
  };
  await respond(0, SEEDED);
  await click(root(), 'Seed-Policies');
  await respond(1, FILES);
  return page;
}

describe('opening a preview', () => {
  it('requests page 1 of the clicked file and shows its name and chunk texts in order', async () => {
    const page = await previewPage();

    await page.open(EXPENSE);

    expect(calls.map(({ url }) => url).slice(2)).toEqual([chunksUrl(EXPENSE, 1)]);
    expect(page.previewState()).toBe('loading');
    expect(page.previewText()).toContain(PREVIEW_TEXT.loading);
    expect(page.listShown()).toBe(false);
    await respond(2, {
      result: 'ok',
      total: 2,
      chunks: [{ content: '一、费用报销。' }, { content: '二、琥珀报销台。' }],
    });

    expect(page.previewState()).toBe('list');
    expect(page.preview()[0].props['data-dsh-team-kb-preview']).toBe(EXPENSE);
    const heading = page.preview()[0].find((node) => node.type === 'h3');
    expect(textOf(heading)).toBe('expense-policy.txt');
    expect(heading.props.title).toBe('expense-policy.txt');
    expect(page.chunks().map((node) => textOf(node))).toEqual([
      '一、费用报销。',
      '二、琥珀报销台。',
    ]);
  });

  it('renders an HTML-looking chunk literally, as a text child', async () => {
    const page = await previewPage();
    await page.open(EXPENSE);

    await respond(2, { result: 'ok', total: 1, chunks: [{ content: '<b>x</b>' }] });

    const [chunk] = page.chunks();
    expect(chunk.children).toEqual(['<b>x</b>']);
    expect(chunk.findAllByType('b')).toEqual([]);
    expect(
      page.view.root.findAll((node) => node.props.dangerouslySetInnerHTML !== undefined),
    ).toEqual([]);
  });

  it('offers no edit, upload or download: its only action is 「返回列表」 on one page', async () => {
    const page = await previewPage();
    await page.open(EXPENSE);
    await respond(2, { result: 'ok', total: 20, chunks: [{ content: 'a' }] });

    const preview = page.preview()[0];
    expect(preview.findAllByType('button').map((node) => textOf(node))).toEqual(['返回列表']);
    for (const type of ['a', 'input', 'textarea', 'form'])
      expect(preview.findAllByType(type)).toEqual([]);
    expect(preview.findAll((node) => node.props.contentEditable !== undefined)).toEqual([]);
  });
});

describe('preview states', () => {
  it.each([
    ['an empty file', { result: 'ok', total: 0, chunks: [] }, 'empty'],
    ['a page past the end', { result: 'ok', total: 3, chunks: [] }, 'empty'],
    ['not-configured', { result: 'not-configured' }, 'not-configured'],
    ['unavailable', { result: 'unavailable' }, 'failed'],
    ['upstream-error', { result: 'upstream-error' }, 'failed'],
    ['invalid-request', { result: 'invalid-request' }, 'failed'],
    ['a malformed chunk', { result: 'ok', total: 1, chunks: [{ content: 1 }] }, 'failed'],
    ['a chunk list without a total', { result: 'ok', chunks: [] }, 'failed'],
    ['a non-JSON body', 'kb-sentinel', 'failed'],
  ])('shows %s as its own state and text', async (_label, body, state) => {
    const page = await previewPage();
    await page.open(EXPENSE);

    await respond(2, body);

    expect(page.previewState()).toBe(state);
    expect(page.previewText()).toContain(PREVIEW_TEXT[state]);
    expect(page.chunks()).toEqual([]);
    const actions = page
      .preview()[0]
      .findAllByType('button')
      .map((node) => textOf(node));
    expect(actions).toEqual(state === 'failed' ? ['返回列表', '重试'] : ['返回列表']);
  });

  it('shows a non-200 answer as failed', async () => {
    const page = await previewPage();
    await page.open(EXPENSE);

    await respond(2, { result: 'ok', total: 1, chunks: [{ content: 'a' }] }, 502);

    expect(page.previewState()).toBe('failed');
  });

  it('retries a failed preview on the same page', async () => {
    const page = await previewPage();
    await page.open(EXPENSE);
    await respond(2, { result: 'unavailable' });

    await page.click(page.preview()[0], '重试');
    expect(page.previewState()).toBe('loading');
    await respond(3, { result: 'ok', total: 1, chunks: [{ content: 'again' }] });

    expect(calls.map(({ url }) => url).slice(2)).toEqual([
      chunksUrl(EXPENSE, 1),
      chunksUrl(EXPENSE, 1),
    ]);
    expect(page.chunks().map((node) => textOf(node))).toEqual(['again']);
  });
});

describe('paging', () => {
  const twenty = Array.from({ length: 20 }, (_, index) => ({ content: `段 ${String(index)}` }));

  it('shows no paging row for exactly 20 chunks', async () => {
    const page = await previewPage();
    await page.open(EXPENSE);
    await respond(2, { result: 'ok', total: 20, chunks: twenty });

    expect(page.chunks()).toHaveLength(20);
    expect(page.previewText()).not.toMatch(/第 \d+ \/ \d+ 页/);
  });

  it('pages through more than 20 chunks with bounded previous and next', async () => {
    const page = await previewPage();
    await page.open(EXPENSE);
    await respond(2, { result: 'ok', total: 41, chunks: twenty });
    const preview = () => page.preview()[0];

    expect(page.previewText()).toContain('第 1 / 3 页');
    expect(page.button(preview(), '上一页').props.disabled).toBe(true);
    await page.click(preview(), '下一页');
    expect(page.previewState()).toBe('loading');
    await respond(3, { result: 'ok', total: 41, chunks: [{ content: '第三页之前' }] });
    expect(page.previewText()).toContain('第 2 / 3 页');
    await page.click(preview(), '下一页');
    await respond(4, { result: 'ok', total: 41, chunks: [{ content: '末页' }] });

    expect(page.previewText()).toContain('第 3 / 3 页');
    expect(page.button(preview(), '下一页').props.disabled).toBe(true);
    expect(page.chunks().map((node) => textOf(node))).toEqual(['末页']);
    expect(calls.map(({ url }) => url).slice(2)).toEqual([
      chunksUrl(EXPENSE, 1),
      chunksUrl(EXPENSE, 2),
      chunksUrl(EXPENSE, 3),
    ]);
  });
});

describe('returning to the list', () => {
  it('restores the expanded library, its filter and page without a new request', async () => {
    const page = await previewPage();
    const field = () =>
      page.view.root.find(
        (node) => node.type === 'input' && node.props['aria-label'] === '按文件名筛选',
      );
    await act(async () => {
      field().props.onChange({ target: { value: 'policy' } });
    });
    const form = page.files()[0].find((node) => node.type === 'form');
    await act(async () => {
      form.props.onSubmit({ preventDefault: () => undefined });
    });
    await respond(2, { result: 'ok', total: 41, documents: FILES.documents });
    await page.click(page.files()[0], '下一页');
    await respond(3, { result: 'ok', total: 41, documents: FILES.documents });
    expect(textOf(page.files()[0])).toContain('第 2 / 3 页');

    await page.open(EXPENSE);
    await respond(4, { result: 'ok', total: 1, chunks: [{ content: 'a' }] });
    await page.back();

    expect(page.preview()).toEqual([]);
    expect(page.listShown()).toBe(true);
    expect(page.list().props[STATE]).toBe('list');
    expect(page.files()).toHaveLength(1);
    expect(textOf(page.files()[0])).toContain('第 2 / 3 页');
    expect(field().props.value).toBe('policy');
    expect(calls).toHaveLength(5);
    expect(calls[2].url).toContain('&keywords=policy');
  });

  it('returns to the list at the scroll position it was left at', async () => {
    const scroller = { scrollTop: 0 };
    const page = await previewPage(scroller);
    scroller.scrollTop = 480;

    await page.open(EXPENSE);
    await respond(2, { result: 'ok', total: 1, chunks: [{ content: 'a' }] });
    // The hidden list no longer holds the page's height, so the browser clamps the offset.
    scroller.scrollTop = 120;
    await page.back();

    expect(page.listShown()).toBe(true);
    expect(scroller.scrollTop).toBe(480);
  });

  it('aborts an in-flight preview on return and drops its late answer', async () => {
    ignoreAbort = true;
    const page = await previewPage();
    await page.open(EXPENSE);
    await page.back();
    expect(calls[2].init.signal.aborted).toBe(true);

    await page.open(ATTENDANCE);
    await respond(2, { result: 'ok', total: 1, chunks: [{ content: 'expense, superseded' }] });
    expect(page.previewState()).toBe('loading');
    await respond(3, { result: 'ok', total: 1, chunks: [{ content: 'attendance' }] });

    expect(calls[3].url).toBe(chunksUrl(ATTENDANCE, 1));
    expect(page.chunks().map((node) => textOf(node))).toEqual(['attendance']);
  });

  it('aborts a page request still loading when the preview closes', async () => {
    const page = await previewPage();
    await page.open(EXPENSE);
    await respond(2, {
      result: 'ok',
      total: 41,
      chunks: Array.from({ length: 20 }, () => ({ content: 'x' })),
    });
    await page.click(page.preview()[0], '下一页');
    await page.back();

    expect(calls[3].url).toBe(chunksUrl(EXPENSE, 2));
    expect(calls[3].init.signal.aborted).toBe(true);
  });
});
