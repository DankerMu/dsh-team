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
const SCOPE = 'data-dsh-team-kb-scope';
const SESSION = 'session-1';
const POLICIES = '0123456789abcdef0123456789abcdef';
const CONTRACTS = 'fedcba9876543210fedcba9876543210';
const STALE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DATASETS_URL = 'api/knowledge-base.datasets';
const SEEDED = {
  result: 'ok',
  datasets: [
    { id: POLICIES, name: 'Seed-Policies' },
    { id: CONTRACTS, name: '合同库' },
  ],
};
const FAILURE = '范围保存失败，请重试';
const line = (datasetIds) => `/kb-scope ${JSON.stringify({ datasetIds })}`;

const plugin = loads[0]?.factory(() => React);

let calls;
let executions;
let consoleSpies;
const mounted = [];
beforeEach(() => {
  calls = [];
  executions = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url, init) => {
      const deferred = Promise.withResolvers();
      init.signal.addEventListener('abort', () =>
        deferred.reject(new DOMException('aborted', 'AbortError')),
      );
      calls.push({ url, deferred });
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
  for (const { url } of calls) expect(url).toBe(DATASETS_URL);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, GLOBAL);
});

/** Applies the client with a recording command remote; returns the scope-related registrations. */
function install() {
  globalThis[GLOBAL] = { available: true };
  const registered = [];
  const execute = vi.fn((sessionId, commandLine, attachments) => {
    const deferred = Promise.withResolvers();
    executions.push({ sessionId, line: commandLine, attachments, deferred });
    return deferred.promise;
  });
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
  const find = (name) => registered.find(({ options }) => options.name === name);
  return { find, execute };
}

function textOf(node) {
  if (typeof node === 'string') return node;
  return node.children.map(textOf).join('');
}

/** Renders the composer entry with the given projection view; `project` swaps the view. */
function renderScope(initial) {
  const { find, execute } = install();
  const Entry = find('conversation.input.left').component;
  let projected = initial;
  let session = SESSION;
  const keys = [];
  const useProjection = (key) => {
    keys.push(key);
    return projected;
  };
  const element = () => React.createElement(Entry, { sessionId: session, useProjection });
  let view;
  act(() => {
    view = create(element());
  });
  mounted.push(view);
  const root = () => view.root.findAll((node) => node.props[SCOPE] !== undefined);
  const control = () => root()[0];
  const byLabel = (label) =>
    control().find((node) => node.type === 'button' && textOf(node) === label);
  const box = (id) =>
    control().find(
      (node) => node.type === 'input' && node.props['data-dsh-team-kb-scope-dataset'] === id,
    );
  return {
    view,
    keys,
    execute,
    root,
    control,
    byLabel,
    box,
    label: () => textOf(control().find((node) => node.props['aria-haspopup'] === 'dialog')),
    list: () => control().find((node) => node.props['data-dsh-team-kb-scope-state'] !== undefined),
    error: () => control().findAll((node) => node.props['data-dsh-team-kb-scope-error'] === ''),
    project(next) {
      projected = next;
      act(() => view.update(element()));
    },
    rebind(next) {
      session = next;
      act(() => view.update(element()));
    },
    async click(label) {
      await act(async () => {
        byLabel(label).props.onClick();
      });
    },
    async toggle(id) {
      await act(async () => {
        box(id).props.onChange();
      });
    },
    /** Toggles the popover; `null` leaves the list request unanswered. */
    async open(answer = SEEDED) {
      await act(async () => {
        control()
          .find((node) => node.props['aria-haspopup'] === 'dialog')
          .props.onClick();
      });
      if (answer !== null) await respond(calls.length - 1, answer);
    },
  };
}

async function respond(index, body, status = 200) {
  const text = vi.fn(() => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)));
  await act(async () => {
    calls[index].deferred.resolve({ status, text });
  });
  expect(text).toHaveBeenCalledTimes(1);
}

async function settle(index, value) {
  await act(async () => {
    executions[index].deferred.resolve(value);
  });
}

const success = (kind = 'success') => ({
  ok: true,
  value: { commandId: 'cmd-1', result: { kind, text: 'x' } },
});

describe('registration', () => {
  it('registers the composer entry and a hidden kb-scope command row', () => {
    const { find } = install();

    expect(find('conversation.input.left').options).toEqual({
      name: 'conversation.input.left',
      id: 'knowledge-base-scope',
      order: 100,
    });
    const row = find('conversation.chat.commandview');
    expect(row.options).toEqual({ name: 'conversation.chat.commandview', key: 'kb-scope' });
    expect(row.component({ node: { name: 'kb-scope' } })).toBeNull();
  });
});

describe('button', () => {
  it.each([
    ['a missing projection', undefined],
    ['a null projection', null],
    ['a child Session', { child: true, selection: null, turn: null }],
    ['a malformed view', { child: false, selection: 'all', turn: null }],
  ])('renders nothing for %s', (_label, value) => {
    const scope = renderScope(value);

    expect(scope.view.toJSON()).toBeNull();
    expect(scope.keys.every((key) => key === 'kbScope')).toBe(true);
    expect(calls).toEqual([]);
  });

  it.each([
    [null, '知识库：全部', 'all'],
    [[], '知识库：不检索', 'none'],
    [[POLICIES, STALE], '知识库：2 个', 'some'],
  ])('labels the selection %j as %s', (selection, label, state) => {
    const scope = renderScope({ child: false, selection, turn: null });

    expect(scope.label()).toBe(label);
    expect(scope.control().props[SCOPE]).toBe(state);
    expect(calls).toEqual([]);
  });

  it('follows the projection, not a local copy', () => {
    const scope = renderScope({ child: false, selection: null, turn: null });
    scope.project({ child: false, selection: [CONTRACTS], turn: { turn: 1, scope: null } });

    expect(scope.label()).toBe('知识库：1 个');
    scope.project({ child: true, selection: [CONTRACTS], turn: null });
    expect(scope.view.toJSON()).toBeNull();
  });
});

describe('popover list', () => {
  it('loads the libraries on opening and checks every one for the whole scope', async () => {
    const scope = renderScope({ child: false, selection: null, turn: null });
    await scope.open(null);

    expect(scope.list().props['data-dsh-team-kb-scope-state']).toBe('loading');
    expect(textOf(scope.list())).toBe('正在加载知识库…');
    await respond(0, SEEDED);
    expect(scope.list().props['data-dsh-team-kb-scope-state']).toBe('list');
    expect([scope.box(POLICIES).props.checked, scope.box(CONTRACTS).props.checked]).toEqual([
      true,
      true,
    ]);
    expect(textOf(scope.list())).toBe('Seed-Policies合同库');
  });

  it.each([
    [
      'not configured',
      { result: 'not-configured' },
      'not-configured',
      '知识库未配置，请联系管理员',
    ],
    ['empty', { result: 'ok', datasets: [] }, 'empty', '暂无知识库'],
    ['failed', { result: 'unavailable' }, 'failed', '知识库加载失败重试'],
  ])('shows the %s list state', async (_label, answer, state, text) => {
    const scope = renderScope({ child: false, selection: [], turn: null });
    await scope.open(answer);

    expect(scope.list().props['data-dsh-team-kb-scope-state']).toBe(state);
    expect(textOf(scope.list())).toBe(text);
  });

  it('retries a failed list and closes on a second click', async () => {
    const scope = renderScope({ child: false, selection: [], turn: null });
    await scope.open({ result: 'timeout' });
    await scope.click('重试');
    await respond(1, SEEDED);

    expect(scope.list().props['data-dsh-team-kb-scope-state']).toBe('list');
    expect([scope.box(POLICIES).props.checked, scope.box(CONTRACTS).props.checked]).toEqual([
      false,
      false,
    ]);
    await scope.open(null);
    expect(scope.control().findAll((node) => node.props['data-dsh-team-kb-scope-state'])).toEqual(
      [],
    );
  });
});

describe('writes', () => {
  it.each([
    ['全选', [POLICIES], null],
    ['取消全选', null, []],
  ])('writes %s through the command remote', async (label, selection, written) => {
    const scope = renderScope({ child: false, selection, turn: null });
    await scope.open();
    await scope.click(label);

    expect(scope.execute).toHaveBeenCalledTimes(1);
    expect(executions[0]).toMatchObject({
      sessionId: SESSION,
      line: line(written),
      attachments: [],
    });
  });

  it.each([
    ['unchecking one from the whole scope', null, POLICIES, [CONTRACTS]],
    ['checking one', [POLICIES], CONTRACTS, [POLICIES, CONTRACTS]],
    ['unchecking one', [CONTRACTS, POLICIES], CONTRACTS, [POLICIES]],
    [
      'checking beside a deleted library',
      [STALE, POLICIES],
      CONTRACTS,
      [STALE, POLICIES, CONTRACTS],
    ],
    ['unchecking beside a deleted library', [STALE, POLICIES], POLICIES, [STALE]],
  ])('writes the list for %s', async (_label, selection, id, written) => {
    const scope = renderScope({ child: false, selection, turn: null });
    await scope.open();
    await scope.toggle(id);

    expect(executions.map(({ line: sent }) => sent)).toEqual([line(written)]);
  });

  it('disables every action while a write is pending and sends nothing more', async () => {
    const scope = renderScope({ child: false, selection: null, turn: null });
    await scope.open();
    await scope.toggle(POLICIES);

    expect(scope.byLabel('全选').props.disabled).toBe(true);
    expect(scope.byLabel('取消全选').props.disabled).toBe(true);
    expect(scope.box(CONTRACTS).props.disabled).toBe(true);
    // A second synchronous attempt before React re-renders is refused by the in-flight flag.
    await act(async () => {
      scope.byLabel('取消全选').props.onClick();
      scope.box(CONTRACTS).props.onChange();
    });
    expect(executions).toHaveLength(1);
    await settle(0, success());
    // No optimistic update: the label waits for the projection, and so do the actions, so a
    // second change cannot start from the stale selection.
    expect(scope.label()).toBe('知识库：全部');
    expect(scope.error()).toEqual([]);
    expect(scope.byLabel('全选').props.disabled).toBe(true);
    await act(async () => {
      scope.box(CONTRACTS).props.onChange();
    });
    expect(executions).toHaveLength(1);
    scope.project({ child: false, selection: [CONTRACTS], turn: null });
    expect(scope.label()).toBe('知识库：1 个');
    expect(scope.byLabel('全选').props.disabled).toBe(false);
  });

  it('waits for the written list in any order, not for an unrelated projection change', async () => {
    const scope = renderScope({ child: false, selection: [], turn: null });
    await scope.open();
    await scope.click('全选');
    await settle(0, success());
    // A turn snapshot alone is not the written selection.
    scope.project({ child: false, selection: [], turn: { turn: 1, scope: [] } });
    expect(scope.byLabel('取消全选').props.disabled).toBe(true);
    scope.project({ child: false, selection: null, turn: { turn: 1, scope: [] } });
    expect(scope.byLabel('取消全选').props.disabled).toBe(false);
    await scope.toggle(POLICIES);
    expect(executions[1].line).toBe(line([CONTRACTS]));
    await settle(1, success());
    scope.project({ child: false, selection: [POLICIES, CONTRACTS], turn: null });
    expect(scope.byLabel('全选').props.disabled).toBe(true);
    scope.project({ child: false, selection: [CONTRACTS], turn: null });
    expect(scope.byLabel('全选').props.disabled).toBe(false);
    scope.project({ child: false, selection: [STALE], turn: null });
    await scope.toggle(POLICIES);
    expect(executions[2].line).toBe(line([STALE, POLICIES]));
    await settle(2, success());
    scope.project({ child: false, selection: [POLICIES, STALE], turn: null });
    expect(scope.byLabel('全选').props.disabled).toBe(false);
  });

  it('re-enables after a bounded wait when the projection never catches up', async () => {
    vi.useFakeTimers();
    try {
      const scope = renderScope({ child: false, selection: [], turn: null });
      await scope.open();
      await scope.click('全选');
      await settle(0, success());
      await act(async () => {
        vi.advanceTimersByTime(1_999);
      });
      expect(scope.byLabel('全选').props.disabled).toBe(true);
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(scope.byLabel('全选').props.disabled).toBe(false);
      expect(scope.label()).toBe('知识库：不检索');
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-enables when the control moves to another Session', async () => {
    const scope = renderScope({ child: false, selection: [], turn: null });
    await scope.open();
    await scope.click('全选');
    await settle(0, success());
    expect(scope.byLabel('全选').props.disabled).toBe(true);
    scope.rebind('session-2');
    expect(scope.byLabel('全选').props.disabled).toBe(false);
  });

  it.each([
    ['a failed remote call', { ok: false, error: { code: 'session/agent-busy', message: 'm' } }],
    ['an unknown command', { ok: true, value: undefined }],
    // A JSON carrier may turn the absent execution into null; the fence must still clear.
    ['a null execution', { ok: true, value: null }],
    ['an execution without a result', { ok: true, value: { commandId: 'cmd-1' } }],
    ['a refused argument', success('error')],
  ])('shows the one failure text for %s', async (_label, result) => {
    const scope = renderScope({ child: false, selection: [], turn: null });
    await scope.open();
    await scope.click('全选');
    await settle(0, result);

    expect(scope.error().map(textOf)).toEqual([FAILURE]);
    expect(scope.byLabel('全选').props.disabled).toBe(false);
    expect(scope.label()).toBe('知识库：不检索');
    // The next successful write clears it.
    await scope.click('全选');
    await settle(1, success());
    expect(scope.error()).toEqual([]);
  });

  it('shows the failure text when the remote rejects', async () => {
    const scope = renderScope({ child: false, selection: [], turn: null });
    await scope.open();
    await scope.click('全选');
    await act(async () => {
      executions[0].deferred.reject(new Error('socket closed'));
    });

    expect(scope.error().map(textOf)).toEqual([FAILURE]);
    expect(scope.byLabel('全选').props.disabled).toBe(false);
  });

  it('drops the answer of a write settled after unmounting', async () => {
    const scope = renderScope({ child: false, selection: [], turn: null });
    await scope.open();
    await scope.click('全选');
    act(() => scope.view.unmount());
    mounted.splice(0);
    const renders = scope.keys.length;
    await settle(0, success());
    // Nothing renders after unmounting, and the answer leaves no console output (afterEach).
    expect(scope.keys.length).toBe(renders);
    expect(scope.view.toJSON()).toBeNull();
  });
});
