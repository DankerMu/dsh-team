import { afterEach, expect, it, vi } from 'vitest';
import React from 'react';
import { act, create } from 'react-test-renderer';

let registration;
vi.stubGlobal('window', { __ModuleLoader__: { load: (value) => (registration = value) } });
await import('./client.js');
vi.unstubAllGlobals();
const plugin = registration.factory(() => React);
let entry, Panel;
plugin.apply({
  slots: {
    inject: (_name, install) => install(),
    register: (options, component) => {
      entry = options;
      Panel = component;
    },
  },
});

function request(overrides = {}) {
  const decisions = [];
  const pending = {
    kind: 'approval',
    sessionId: 'child',
    key: 'approval:child-1',
    toolName: 'write',
    reason: '需要人工批准',
    answerable: true,
    answer(outcome) {
      if (!this.answerable) return Promise.reject(new Error('already settled'));
      this.answerable = false;
      decisions.push(outcome);
      return Promise.resolve();
    },
    ...overrides,
  };
  return { pending, decisions };
}

function owner(pending, mode = 'one-shot') {
  return {
    sessionId: 'child',
    session: { subagent: { address: { mode } } },
    pendingInteraction: pending,
  };
}

const mounted = [];
function render(pending) {
  let view;
  act(() => {
    view = create(React.createElement(Panel, { matched: pending }));
  });
  mounted.push(view);
  return view;
}
function click(view, index) {
  act(() => view.root.findAllByType('button')[index].props.onClick());
}
function unmount(view) {
  act(() => view.unmount());
}
afterEach(() => {
  for (const view of mounted.splice(0)) unmount(view);
});

it('takes only an answerable approval owned by the selected one-shot child', () => {
  const { pending } = request();
  expect(entry.select(owner(pending))).toBe(pending);
  const declined = [
    { sessionId: 'child', pendingInteraction: pending },
    { ...owner(pending), session: {} },
    { ...owner(pending), session: { subagent: null } },
    owner(pending, 'continuable'),
    owner(pending, 'unknown'),
    { ...owner(pending), session: { subagent: { address: {} } } },
    owner(null),
    owner(undefined),
    owner({ ...pending, kind: 'question' }),
    owner({ ...pending, sessionId: 'parent' }),
    { ...owner(pending), sessionId: '' },
    { ...owner(pending), sessionId: 42 },
    owner({ ...pending, answer: undefined }),
    owner({ ...pending, key: '' }),
    owner({ ...pending, key: 1 }),
    owner({ ...pending, answerable: false }),
    owner({ ...pending, answerable: 'yes' }),
  ];
  for (const context of declined) expect(entry.select(context)).toBeNull();
});

it.each(['rejected', 'allowed-once'])(
  'settles %s once even when opposite buttons are clicked together',
  async (outcome) => {
    const settlement = Promise.withResolvers();
    const outcomes = [];
    const { pending } = request({
      answer: (value) => {
        outcomes.push(value);
        return settlement.promise;
      },
    });
    const view = render(pending);
    const buttons = view.root.findAllByType('button');
    const first = outcome === 'rejected' ? 0 : 1;
    act(() => {
      buttons[first].props.onClick();
      buttons[1 - first].props.onClick();
      buttons[first].props.onClick();
    });
    expect(outcomes).toEqual([outcome]);
    expect(view.root.findByProps({ 'data-approval-key': pending.key }).props['aria-busy']).toBe(
      true,
    );
    expect(view.root.findAllByType('button').map((button) => button.props.disabled)).toEqual([
      true,
      true,
    ]);
    pending.answerable = false;
    await act(async () => settlement.resolve());
    expect(entry.select(owner(pending))).toBeNull();
  },
);

it('does not answer a request cancelled or settled before a retained click', () => {
  const { pending, decisions } = request({ reason: undefined });
  const view = render(pending);
  pending.answerable = false;
  act(() => view.update(React.createElement(Panel, { matched: pending })));
  click(view, 1);
  expect(decisions).toEqual([]);
  expect(view.root.findAllByType('button').map((button) => button.props.disabled)).toEqual([
    true,
    true,
  ]);
  expect(entry.select(owner(pending))).toBeNull();
});

it('handles a failed settlement and permits retry only while the same request remains answerable', async () => {
  const outcomes = [];
  const { pending } = request({
    answer(outcome) {
      outcomes.push(outcome);
      if (outcomes.length === 1) return Promise.reject(new Error('private transport detail'));
      this.answerable = false;
      return Promise.resolve();
    },
  });
  const view = render(pending);
  await act(async () => click(view, 0));
  expect(view.root.findAllByType('button').map((button) => button.props.disabled)).toEqual([
    false,
    false,
  ]);
  click(view, 1);
  expect(outcomes).toEqual(['rejected', 'allowed-once']);
});

it('does not re-enable a cancelled request when its in-flight settlement rejects', async () => {
  const settlement = Promise.withResolvers();
  const outcomes = [];
  const { pending } = request({
    answer: (outcome) => {
      outcomes.push(outcome);
      return settlement.promise;
    },
  });
  const view = render(pending);
  click(view, 1);
  pending.answerable = false;
  await act(async () => settlement.reject(new Error('aborted')));
  click(view, 0);
  expect(outcomes).toEqual(['allowed-once']);
  expect(view.root.findAllByType('button').map((button) => button.props.disabled)).toEqual([
    true,
    true,
  ]);
});

it('ignores retained clicks and rejected settlements after the panel unmounts', async () => {
  const settlement = Promise.withResolvers();
  const outcomes = [];
  const { pending } = request({
    answer: (outcome) => {
      outcomes.push(outcome);
      return settlement.promise;
    },
  });
  const view = render(pending);
  const retained = view.root.findAllByType('button')[0].props.onClick;
  click(view, 1);
  unmount(view);
  await act(async () => settlement.reject(new Error('scope disposed')));
  retained();
  expect(outcomes).toEqual(['allowed-once']);
});

it('does not answer from an unmounted panel that never received a decision', () => {
  const { pending, decisions } = request();
  const view = render(pending);
  const retained = view.root.findAllByType('button')[1].props.onClick;
  unmount(view);
  retained();
  expect(decisions).toEqual([]);
});

it('remounts the decision lifetime when switching child scopes without reviving the old request', async () => {
  const settlement = Promise.withResolvers();
  const oldOutcomes = [];
  const old = request({
    answer: (outcome) => {
      oldOutcomes.push(outcome);
      return settlement.promise;
    },
  });
  const next = request({
    sessionId: 'other-child',
    key: 'approval:child-2',
    displayReason: { zh: '子任务需要审批', en: 'Child needs approval' },
  });
  const view = render(old.pending);
  const staleClick = view.root.findAllByType('button')[0].props.onClick;
  click(view, 1);
  act(() => view.update(React.createElement(Panel, { matched: next.pending })));
  await act(async () => settlement.reject(new Error('old scope disposed')));
  staleClick();
  click(view, 0);
  expect(next.decisions).toEqual(['rejected']);
  expect(oldOutcomes).toEqual(['allowed-once']);
  expect(view.root.findByProps({ 'data-approval-key': next.pending.key }).props['aria-busy']).toBe(
    true,
  );
});
