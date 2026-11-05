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
const FILE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DATASETS_URL = 'api/knowledge-base.datasets';
const documentsUrl = (id, page, keywords) =>
  `api/knowledge-base.documents?datasetId=${id}&page=${page}&pageSize=20` +
  (keywords === undefined ? '' : `&keywords=${encodeURIComponent(keywords)}`);
const SEEDED = {
  result: 'ok',
  datasets: [
    { id: POLICIES, name: 'Seed-Policies' },
    { id: CONTRACTS, name: '合同库' },
  ],
};

const required = [];
const plugin = loads[0]?.factory((id) => {
  required.push(id);
  return React;
});

/** Runs the client's apply with the page global as given, recording slot use. */
function install(value, present = true) {
  if (present) globalThis[GLOBAL] = value;
  const injected = [];
  const registered = [];
  plugin.apply({
    slots: {
      inject: (slot, installSlot) => {
        injected.push(slot);
        installSlot();
      },
      register: (options, component) => {
        registered.push({ options, component });
        return () => {};
      },
    },
  });
  return { injected, registered };
}

let calls;
let responses;
let consoleSpies;
/** When set, the fetch mock ignores its abort signal, as a fetch that already has its answer. */
let ignoreAbort;
const mounted = [];
beforeEach(() => {
  calls = [];
  responses = [];
  ignoreAbort = false;
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
  // Every answer the client received was read to its end.
  for (const response of responses) expect(response.text).toHaveBeenCalledTimes(1);
  for (const { url } of calls) expect(url.startsWith('api/knowledge-base.')).toBe(true);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, GLOBAL);
});

/** Answers request `index` with an HTTP status and a body (JSON unless already a string). */
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

function renderPage() {
  const { registered } = install({ available: true });
  const Page = registered.find(({ options }) => options.name === 'main').component;
  let view;
  act(() => {
    view = create(React.createElement(Page, {}));
  });
  mounted.push(view);
  const datasets = () => view.root.find((node) => node.props['data-dsh-team-kb-datasets'] === '');
  const files = (id) => view.root.findAll((node) => node.props['data-dsh-team-kb-files'] === id);
  const button = (scope, label) =>
    scope.find((node) => node.type === 'button' && textOf(node) === label);
  const buttons = (scope, label) =>
    scope.findAll((node) => node.type === 'button' && textOf(node) === label);
  const input = (label) =>
    view.root.find((node) => node.type === 'input' && node.props['aria-label'] === label);
  return {
    view,
    datasets,
    files,
    state: () => datasets().props[STATE],
    text: () => textOf(datasets()),
    async click(scope, label) {
      await act(async () => {
        button(scope, label).props.onClick();
      });
    },
    buttons,
    button,
    async type(label, value) {
      await act(async () => {
        input(label).props.onChange({ target: { value } });
      });
    },
    inputs: (label) =>
      view.root.findAll((node) => node.type === 'input' && node.props['aria-label'] === label),
    async submit(id) {
      const form = files(id)[0].find((node) => node.type === 'form');
      const preventDefault = vi.fn();
      await act(async () => {
        form.props.onSubmit({ preventDefault });
      });
      expect(preventDefault).toHaveBeenCalled();
    },
  };
}

describe('registration', () => {
  it('loads one classic-script registration that needs slots, the command remote and React', () => {
    expect(loads).toHaveLength(1);
    expect(loads[0].id).toBe('@dsh-team/knowledge-base');
    expect(Object.keys(loads[0])).toEqual(['id', 'factory']);
    // As the released plan client: the command remote is reached through `remote`.
    expect(plugin.inject).toEqual(['slots', 'remote', 'remote.commands']);
    expect(required).toEqual(['react']);
  });

  it('registers the sidebar panel row and the main page under one key when available', () => {
    const { injected, registered } = install({ available: true });

    // The scope control and its command renderer are client-scope.test.js's.
    expect(injected).toEqual([
      'main',
      'sidebar.panellist',
      'conversation.input.left',
      'conversation.chat.commandview',
    ]);
    const [main, row] = registered.map(({ options }) => options);
    expect(main).toEqual({ name: 'main', key: 'knowledge-base' });
    expect(row).toMatchObject({ name: 'sidebar.panellist', id: 'knowledge-base', order: 20 });
    expect(Object.keys(row)).toEqual(['name', 'id', 'order', 'label']);
    expect(row.label()).toBe('知识库');
    expect(row.id).toBe(main.key);
    expect(calls).toEqual([]);
  });

  it.each([
    ['a missing global', undefined, false],
    ['a null global', null, true],
    ['a boolean global', true, true],
    ['a string global', 'available', true],
    ['an unavailable instance', { available: false }, true],
    ['a string flag', { available: 'true' }, true],
    ['a numeric flag', { available: 1 }, true],
    ['an empty object', {}, true],
  ])('registers nothing and sends nothing for %s', (_label, value, present) => {
    const { injected, registered } = install(value, present);

    expect(injected).toEqual([]);
    expect(registered).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('renders the panel row glyph at the requested size with an inline icon', () => {
    const { registered } = install({ available: true });
    const Icon = registered.find(({ options }) => options.name === 'sidebar.panellist').component;
    for (const [size, active] of [
      [16, false],
      [18, true],
    ]) {
      let view;
      act(() => {
        view = create(React.createElement(Icon, { size, active }));
      });
      mounted.push(view);
      const svg = view.root.findByType('svg');
      expect(svg.props).toMatchObject({ width: size, height: size, 'aria-hidden': true });
      expect(svg.findAllByType('path').length).toBeGreaterThan(0);
    }
  });
});

describe('dataset list', () => {
  it('shows loading, then the list, with distinct texts for all six displays', async () => {
    const texts = new Map();
    const page = renderPage();
    expect(calls.map(({ url }) => url)).toEqual([DATASETS_URL]);
    expect(page.state()).toBe('loading');
    texts.set('loading', page.text());

    await respond(0, { result: 'not-configured' });
    texts.set('not-configured', page.text());
    await act(async () => {
      page.view.unmount();
    });
    mounted.splice(0);

    const failed = renderPage();
    await respond(1, { result: 'unavailable' });
    texts.set(failed.state(), failed.text());

    const empty = renderPage();
    await respond(2, { result: 'ok', datasets: [] });
    texts.set(empty.state(), empty.text());

    const listed = renderPage();
    await respond(3, SEEDED);
    texts.set(listed.state(), listed.text());
    await listed.type('按库名搜索', 'kb-nothing');
    texts.set(listed.state(), listed.text());

    expect([...texts.keys()]).toEqual([
      'loading',
      'not-configured',
      'failed',
      'empty',
      'list',
      'no-match',
    ]);
    expect(new Set(texts.values()).size).toBe(6);
    expect(texts.get('not-configured')).toContain('知识库未配置');
  });

  it('shows not-configured without a list, a search box or a retry button, but with refresh', async () => {
    const page = renderPage();
    await respond(0, { result: 'not-configured' });

    expect(page.state()).toBe('not-configured');
    const buttons = page.view.root.findAll((node) => node.type === 'button');
    expect(buttons.map((node) => textOf(node))).toEqual(['刷新']);
    expect(page.inputs('按库名搜索')).toEqual([]);
  });

  it('lists the libraries after refresh once the route answers ok', async () => {
    const page = renderPage();
    await respond(0, { result: 'not-configured' });

    await page.click(page.view.root, '刷新');
    expect(calls.map(({ url }) => url)).toEqual([DATASETS_URL, DATASETS_URL]);
    expect(page.state()).toBe('loading');
    await respond(1, SEEDED);

    expect(page.state()).toBe('list');
    expect(page.inputs('按库名搜索')).toHaveLength(1);
    expect(page.text()).toContain('Seed-Policies');
  });

  it.each([
    ['unavailable', { result: 'unavailable' }, 200],
    ['timeout', { result: 'timeout' }, 200],
    ['upstream-error', { result: 'upstream-error' }, 200],
    ['invalid-request', { result: 'invalid-request' }, 200],
    ['an unknown result', { result: 'kb-sentinel' }, 200],
    ['an ok answer without a list', { result: 'ok' }, 200],
    ['a malformed entry', { result: 'ok', datasets: [{ id: POLICIES }] }, 200],
    ['a non-object answer', [], 200],
    ['unparseable JSON', 'kb-sentinel', 200],
    ['a non-200 status', { result: 'ok', datasets: [] }, 403],
  ])('shows a retryable failure for %s and retries the list', async (_label, body, status) => {
    const page = renderPage();
    await respond(0, body, status);
    expect(page.state()).toBe('failed');

    await page.click(page.datasets(), '重试');
    expect(page.state()).toBe('loading');
    expect(calls.map(({ url }) => url)).toEqual([DATASETS_URL, DATASETS_URL]);
    await respond(1, SEEDED);
    expect(page.state()).toBe('list');
  });

  it('shows a retryable failure when the request itself fails', async () => {
    const page = renderPage();
    await act(async () => {
      calls[0].deferred.reject(new TypeError('Failed to fetch'));
    });

    expect(page.state()).toBe('failed');
  });

  it('filters library names case-insensitively on the client and restores the list', async () => {
    const page = renderPage();
    await respond(0, SEEDED);
    const names = () =>
      page.datasets().findAll((node) => node.props['data-dsh-team-kb-dataset'] !== undefined);

    expect(names().map((node) => node.props['data-dsh-team-kb-dataset'])).toEqual([
      POLICIES,
      CONTRACTS,
    ]);
    await page.type('按库名搜索', 'policies');
    expect(names().map((node) => textOf(node))).toEqual(['Seed-Policies']);
    await page.type('按库名搜索', '合同');
    expect(names().map((node) => node.props['data-dsh-team-kb-dataset'])).toEqual([CONTRACTS]);
    await page.type('按库名搜索', 'kb-nothing');
    expect(page.state()).toBe('no-match');
    await page.type('按库名搜索', '   ');
    expect(page.state()).toBe('list');
    expect(names()).toHaveLength(2);
    expect(calls).toHaveLength(1);
  });

  it('refreshes the list and collapses every expanded library', async () => {
    const page = renderPage();
    await respond(0, SEEDED);
    await page.click(page.datasets(), 'Seed-Policies');
    await respond(1, { result: 'ok', total: 1, documents: [{ id: FILE, name: 'a.txt' }] });
    expect(page.files(POLICIES)).toHaveLength(1);

    await page.click(page.view.root, '刷新');
    expect(calls[2].url).toBe(DATASETS_URL);
    expect(page.state()).toBe('loading');
    await respond(2, SEEDED);

    expect(page.state()).toBe('list');
    expect(page.files(POLICIES)).toEqual([]);
  });

  it('discards a superseded list answer and aborts its request', async () => {
    const page = renderPage();
    await page.click(page.view.root, '刷新');
    expect(calls[0].init.signal.aborted).toBe(true);
    await respond(1, { result: 'ok', datasets: [] });
    expect(page.state()).toBe('empty');
  });

  it('aborts an in-flight request when the page unmounts', async () => {
    const page = renderPage();
    await act(async () => {
      page.view.unmount();
    });
    mounted.splice(0);

    expect(calls[0].init.signal.aborted).toBe(true);
  });
});

/** A listed page whose library POLICIES is expanded: request 1 is its first documents page. */
async function expandedPolicies() {
  const page = renderPage();
  await respond(0, SEEDED);
  await page.click(page.datasets(), 'Seed-Policies');
  const files = () => page.files(POLICIES)[0];
  return {
    ...page,
    files,
    fileState: () => files().props[STATE],
    fileText: () => textOf(files()),
    fileNames: () =>
      files()
        .findAll((node) => node.props['data-dsh-team-kb-file'] !== undefined)
        .map((node) => textOf(node)),
  };
}

const documents = (count, offset = 0) =>
  Array.from({ length: count }, (_, index) => ({
    id: String(index + offset).padStart(32, '0'),
    name: `file-${String(index + offset)}.txt`,
  }));

describe('expanded library', () => {
  it('requests its first page of 20 and shows distinct texts for all six displays', async () => {
    const texts = new Map();
    const page = await expandedPolicies();
    expect(calls[1].url).toBe(documentsUrl(POLICIES, 1));
    expect(page.fileState()).toBe('loading');
    texts.set('loading', page.fileText());
    await respond(1, { result: 'not-configured' });
    texts.set(page.fileState(), page.fileText());
    expect(page.buttons(page.files(), '重试')).toEqual([]);

    await page.click(page.datasets(), 'Seed-Policies');
    await page.click(page.datasets(), 'Seed-Policies');
    await respond(2, { result: 'timeout' });
    texts.set(page.fileState(), page.fileText());
    await page.click(page.files(), '重试');
    expect(calls[3].url).toBe(documentsUrl(POLICIES, 1));
    await respond(3, { result: 'ok', total: 0, documents: [] });
    texts.set(page.fileState(), page.fileText());

    await page.type('按文件名筛选', 'kb-nothing');
    await page.submit(POLICIES);
    expect(calls[4].url).toBe(documentsUrl(POLICIES, 1, 'kb-nothing'));
    await respond(4, { result: 'ok', total: 0, documents: [] });
    texts.set(page.fileState(), page.fileText());

    await page.type('按文件名筛选', 'file');
    await page.submit(POLICIES);
    await respond(5, { result: 'ok', total: 2, documents: documents(2) });
    texts.set(page.fileState(), page.fileText());

    expect([...texts.keys()]).toEqual([
      'loading',
      'not-configured',
      'failed',
      'empty',
      'no-match',
      'list',
    ]);
    expect(new Set(texts.values()).size).toBe(6);
    expect(page.fileNames()).toEqual(['file-0.txt', 'file-1.txt']);
    // The list's own texts stay apart from the library's.
    expect(page.text()).not.toContain('正在加载知识库');
  });

  it.each([
    ['unavailable', { result: 'unavailable' }, 200],
    ['upstream-error', { result: 'upstream-error' }, 200],
    ['invalid-request', { result: 'invalid-request' }, 200],
    ['a malformed total', { result: 'ok', total: -1, documents: [] }, 200],
    ['a malformed entry', { result: 'ok', total: 1, documents: [{ name: 'a' }] }, 200],
    ['a non-200 status', 'kb-sentinel', 500],
  ])('shows a retryable failure for %s and retries the same page', async (_label, body, status) => {
    const page = await expandedPolicies();
    await respond(1, { result: 'ok', total: 45, documents: documents(20) });
    await page.click(page.files(), '下一页');
    expect(calls[2].url).toBe(documentsUrl(POLICIES, 2));
    await respond(2, body, status);
    expect(page.fileState()).toBe('failed');

    await page.click(page.files(), '重试');
    expect(calls[3].url).toBe(documentsUrl(POLICIES, 2));
  });

  it('pages forward and back within the bounds of the total', async () => {
    const page = await expandedPolicies();
    await respond(1, { result: 'ok', total: 45, documents: documents(20) });
    const nav = (label) => page.button(page.files(), label).props.disabled;

    expect(page.fileText()).toContain('第 1 / 3 页');
    expect([nav('上一页'), nav('下一页')]).toEqual([true, false]);
    await page.click(page.files(), '下一页');
    await respond(2, { result: 'ok', total: 45, documents: documents(20, 20) });
    expect(page.fileText()).toContain('第 2 / 3 页');
    expect([nav('上一页'), nav('下一页')]).toEqual([false, false]);
    await page.click(page.files(), '下一页');
    await respond(3, { result: 'ok', total: 45, documents: documents(5, 40) });
    expect(page.fileText()).toContain('第 3 / 3 页');
    expect([nav('上一页'), nav('下一页')]).toEqual([false, true]);
    await page.click(page.files(), '上一页');
    expect(calls[4].url).toBe(documentsUrl(POLICIES, 2));
    await respond(4, { result: 'ok', total: 45, documents: documents(20, 20) });
    expect(page.fileNames()[0]).toBe('file-20.txt');
  });

  it('returns to page 1 when a filter is submitted', async () => {
    const page = await expandedPolicies();
    await respond(1, { result: 'ok', total: 45, documents: documents(20) });
    await page.click(page.files(), '下一页');
    await respond(2, { result: 'ok', total: 45, documents: documents(20, 20) });

    await page.type('按文件名筛选', 'expense');
    // The filter button submits its form, as Enter in the field does.
    expect(page.button(page.files(), '筛选').props.type).toBe('submit');
    await page.submit(POLICIES);
    expect(calls[3].url).toBe(documentsUrl(POLICIES, 1, 'expense'));
    await respond(3, { result: 'ok', total: 1, documents: documents(1) });
    expect(page.fileText()).toContain('第 1 / 1 页');
  });

  it('treats a blank filter as clearing it', async () => {
    const page = await expandedPolicies();
    await respond(1, { result: 'ok', total: 1, documents: documents(1) });
    await page.type('按文件名筛选', 'expense');
    await page.submit(POLICIES);
    await respond(2, { result: 'ok', total: 1, documents: documents(1) });

    await page.type('按文件名筛选', ' 　\u0085 ');
    await page.submit(POLICIES);
    expect(calls[3].url).toBe(documentsUrl(POLICIES, 1));
  });

  it('refuses a filter over 256 UTF-8 bytes with its own hint and no request', async () => {
    const page = await expandedPolicies();
    await respond(1, { result: 'ok', total: 1, documents: documents(1) });
    const hint = () =>
      page.files().findAll((node) => node.props['data-dsh-team-kb-hint'] === 'keywords-too-long');

    await page.type('按文件名筛选', 'é'.repeat(129));
    await page.submit(POLICIES);
    expect(calls).toHaveLength(2);
    expect(page.fileState()).toBe('list');
    expect(hint().map((node) => textOf(node))).toEqual(['筛选词过长']);

    await page.type('按文件名筛选', 'a'.repeat(256));
    await page.submit(POLICIES);
    expect(calls[2].url).toBe(documentsUrl(POLICIES, 1, 'a'.repeat(256)));
    expect(hint()).toEqual([]);
  });

  it('falls back once to the last page when the requested page is past the end', async () => {
    const page = await expandedPolicies();
    await respond(1, { result: 'ok', total: 60, documents: documents(20) });
    await page.click(page.files(), '下一页');
    await respond(2, { result: 'ok', total: 60, documents: documents(20, 20) });
    await page.click(page.files(), '下一页');
    // Files were deleted between the two requests: page 3 is now past the end.
    await respond(3, { result: 'ok', total: 30, documents: [] });
    expect(calls[4].url).toBe(documentsUrl(POLICIES, 2));
    expect(page.fileState()).toBe('loading');
    await respond(4, { result: 'ok', total: 30, documents: documents(10, 20) });
    expect(page.fileState()).toBe('list');
    expect(page.fileText()).toContain('第 2 / 2 页');
  });

  it.each([
    ['empty without a filter', undefined, 'empty'],
    ['no-match with a filter', 'file', 'no-match'],
  ])('settles as %s when the fallback page is still empty', async (_label, keywords, state) => {
    const page = await expandedPolicies();
    if (keywords !== undefined) {
      await page.type('按文件名筛选', keywords);
      await page.submit(POLICIES);
    }
    const first = calls.length - 1;
    await respond(first, { result: 'ok', total: 45, documents: documents(20) });
    await page.click(page.files(), '下一页');
    await respond(first + 1, { result: 'ok', total: 45, documents: documents(20, 20) });
    await page.click(page.files(), '下一页');
    await respond(first + 2, { result: 'ok', total: 10, documents: [] });
    expect(calls[first + 3].url).toBe(documentsUrl(POLICIES, 1, keywords));
    await respond(first + 3, { result: 'ok', total: 10, documents: [] });

    expect(calls).toHaveLength(first + 4);
    expect(page.fileState()).toBe(state);
  });

  it('does not fall back twice when the fallback page is past the end as well', async () => {
    const page = await expandedPolicies();
    await respond(1, { result: 'ok', total: 60, documents: documents(20) });
    await page.click(page.files(), '下一页');
    await respond(2, { result: 'ok', total: 60, documents: documents(20, 20) });
    await page.click(page.files(), '下一页');
    await respond(3, { result: 'ok', total: 30, documents: [] });
    await respond(4, { result: 'ok', total: 10, documents: [] });

    expect(calls).toHaveLength(5);
    expect(page.fileState()).toBe('empty');
  });

  it('shows an empty page within the total as it is, without a fallback', async () => {
    const page = await expandedPolicies();
    await respond(1, { result: 'ok', total: 45, documents: documents(20) });
    await page.click(page.files(), '下一页');
    await respond(2, { result: 'ok', total: 45, documents: [] });

    expect(calls).toHaveLength(3);
    expect(page.fileState()).toBe('empty');
  });

  it('discards a superseded documents answer and aborts its request', async () => {
    const page = await expandedPolicies();
    await page.type('按文件名筛选', 'expense');
    await page.submit(POLICIES);
    expect(calls[1].init.signal.aborted).toBe(true);
    await respond(2, { result: 'ok', total: 1, documents: documents(1) });
    expect(page.fileNames()).toEqual(['file-0.txt']);
  });

  it('keeps each library to its own requests', async () => {
    const page = await expandedPolicies();
    await page.click(page.datasets(), '合同库');
    expect(calls.map(({ url }) => url).slice(1)).toEqual([
      documentsUrl(POLICIES, 1),
      documentsUrl(CONTRACTS, 1),
    ]);
    expect(calls[1].init.signal.aborted).toBe(false);
    await respond(2, { result: 'ok', total: 0, documents: [] });
    await respond(1, { result: 'ok', total: 1, documents: documents(1) });

    const contracts = page.view.root.find(
      (node) => node.props['data-dsh-team-kb-files'] === CONTRACTS,
    );
    expect(contracts.props[STATE]).toBe('empty');
    expect(page.fileState()).toBe('list');
  });
});

/** The blank check precedes the byte limit: a blank draft only ever clears the filter. */
describe('filter length', () => {
  it('clears a blank filter over 256 UTF-8 bytes instead of calling it too long', async () => {
    const page = await expandedPolicies();
    await respond(1, { result: 'ok', total: 1, documents: documents(1) });
    await page.type('按文件名筛选', 'expense');
    await page.submit(POLICIES);
    await respond(2, { result: 'ok', total: 1, documents: documents(1) });
    const blank = '　'.repeat(100);
    expect(new TextEncoder().encode(blank).byteLength).toBeGreaterThan(256);

    await page.type('按文件名筛选', blank);
    await page.submit(POLICIES);
    expect(calls[3].url).toBe(documentsUrl(POLICIES, 1));
    expect(
      page.files().findAll((node) => node.props['data-dsh-team-kb-hint'] === 'keywords-too-long'),
    ).toEqual([]);
  });
});

/** Requests whose fetch ignores its abort signal: only the latest answer may render. */
describe('late superseded answers', () => {
  it('never renders a superseded list answer that arrives after the latest one', async () => {
    ignoreAbort = true;
    const page = renderPage();
    await page.click(page.view.root, '刷新');
    await respond(1, { result: 'ok', datasets: [] });
    expect(page.state()).toBe('empty');

    // Request A ignored its abort and answers last; its body is read and then dropped.
    await respond(0, SEEDED);
    expect(page.state()).toBe('empty');
    expect(page.text()).not.toContain('Seed-Policies');
  });

  it('never renders a superseded documents answer that arrives after the latest one', async () => {
    ignoreAbort = true;
    const page = await expandedPolicies();
    await page.type('按文件名筛选', 'expense');
    await page.submit(POLICIES);
    await respond(2, { result: 'ok', total: 1, documents: documents(1) });
    expect(page.fileNames()).toEqual(['file-0.txt']);

    // Request A (the unfiltered first page) ignored its abort and answers last.
    await respond(1, { result: 'ok', total: 45, documents: documents(20, 100) });
    expect(page.fileNames()).toEqual(['file-0.txt']);
    expect(page.fileText()).toContain('第 1 / 1 页');
  });
});
