import { expect, it } from 'vitest';
import {
  commandSide,
  composerCard,
  createdSessionId,
  scopeStall,
  readScope,
  scopeLabel,
  scopeRuns,
  scopeSnapshot,
  scopeStep,
  scopeValue,
  turnEnded,
} from './knowledge-scope-stack-fixture.ts';
import type { ScopeSnapshot } from './knowledge-scope-stack-fixture.ts';

const FIRST = '0123456789abcdef0123456789abcdef';
const SECOND = 'fedcba9876543210fedcba9876543210';
const SNAPSHOT: ScopeSnapshot = {
  state: 'some',
  label: '知识库：1 个',
  list: { state: 'list', ids: [FIRST, SECOND], checked: [SECOND], pending: false },
  error: false,
  current: 'session-1',
};

it.each([
  [null, '知识库：全部'],
  [[], '知识库：不检索'],
  [[FIRST, SECOND], '知识库：2 个'],
])('labels %j as the control does', (selection, label) => {
  expect(scopeLabel(selection)).toBe(label);
});

it('accepts the in-page scope snapshot as observed', () => {
  expect(scopeSnapshot(SNAPSHOT)).toEqual(SNAPSHOT);
  const absent = { state: null, label: null, list: null, error: false, current: null };
  expect(scopeSnapshot(absent)).toEqual(absent);
});

it.each([
  ['a missing value', undefined],
  ['an unknown state', { ...SNAPSHOT, state: 'busy' }],
  ['a numeric label', { ...SNAPSHOT, label: 1 }],
  ['a non-boolean error', { ...SNAPSHOT, error: 'no' }],
  ['a numeric current Session', { ...SNAPSHOT, current: 1 }],
  ['an empty current Session', { ...SNAPSHOT, current: '' }],
  ['an unknown list state', { ...SNAPSHOT, list: { ...SNAPSHOT.list, state: 'ready' } }],
  ['non-string list IDs', { ...SNAPSHOT, list: { ...SNAPSHOT.list, ids: [1] } }],
  ['a non-boolean pending flag', { ...SNAPSHOT, list: { ...SNAPSHOT.list, pending: 1 } }],
])('rejects a snapshot with %s', (_label, value) => {
  expect(() => scopeSnapshot(value)).toThrow('Knowledge scope snapshot malformed');
});

const sequenced = (kbScope: unknown) => ({ kind: 'sequenced', asOfSeq: 4, values: { kbScope } });

it('reads the kbScope view of an exact projection read', () => {
  const view = { child: false, selection: [FIRST], turn: { turn: 2, scope: null } };
  expect(scopeValue(sequenced(view))).toEqual(view);
  expect(scopeValue(sequenced({ child: false, selection: null, turn: null }))).toEqual({
    child: false,
    selection: null,
    turn: null,
  });
});

it.each([
  ['a migration-required read', { kind: 'migration-required', values: {} }],
  ['a missing kbScope', { kind: 'sequenced', asOfSeq: 1, values: {} }],
  ['a string selection', sequenced({ child: false, selection: 'all', turn: null })],
  ['a missing child', sequenced({ selection: null, turn: null })],
  [
    'a fractional turn',
    sequenced({ child: false, selection: null, turn: { turn: 1.5, scope: [] } }),
  ],
  ['a bad turn scope', sequenced({ child: false, selection: null, turn: { turn: 1, scope: 'x' } })],
])('fails %s with the fixed message', (_label, value) => {
  expect(() => scopeValue(value)).toThrow('kbScope projection unavailable');
});

it('turns a failed or null projections RPC into the fixed message', async () => {
  const failing = () => Promise.reject(new Error('Owned Session RPC session/projections failed'));
  await expect(readScope(failing, 's1')).rejects.toThrow('kbScope projection unavailable');
  const view = { child: false, selection: [], turn: null };
  const calls: unknown[] = [];
  const rpc = (method: string, args: unknown) => {
    calls.push([method, args]);
    return Promise.resolve(sequenced(view));
  };
  expect(await readScope(rpc, 's1')).toEqual(view);
  expect(calls).toEqual([['session/projections', { request: { sessionId: 's1' } }]]);
});

const run = (seq: number, args: unknown, name = 'kb-scope') => ({
  type: 'command/run',
  seq,
  data: { commandId: `c${String(seq)}`, name, args, source: { kind: 'user' } },
});
const HISTORY = [
  run(1, ` ${JSON.stringify({ datasetIds: [] })}`),
  { type: 'command/done', seq: 2, data: { commandId: 'c1', kind: 'success' } },
  run(3, JSON.stringify({ datasetIds: [FIRST] })),
  run(4, '/ignored', 'plan'),
  { type: 'turn/start', seq: 5, data: { turn: 1 } },
  run(6, JSON.stringify({ datasetIds: [SECOND] })),
  { type: 'turn/end', seq: 7, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/start', seq: 8, data: { turn: 2 } },
];

it('lists the kb-scope command runs with their selections in log order', () => {
  expect(scopeRuns(HISTORY)).toEqual([
    { seq: 1, selection: [] },
    { seq: 3, selection: [FIRST] },
    { seq: 6, selection: [SECOND] },
  ]);
});

it.each([
  ['missing arguments', [run(1, undefined)]],
  ['non-JSON arguments', [run(1, 'all')]],
  ['another argument key', [run(1, '{"ids":null}')]],
  ['a non-numeric seq', [{ ...run(1, '{"datasetIds":null}'), seq: '1' }]],
])('rejects a kb-scope run with %s', (_label, events) => {
  expect(() => scopeRuns(events)).toThrow('kb-scope command history malformed');
});

it('places the last run of a selection before or after a turn start', () => {
  expect(commandSide(HISTORY, 1, [FIRST])).toBe('before');
  expect(commandSide(HISTORY, 1, [SECOND])).toBe('after');
  expect(() => commandSide(HISTORY, 1, null)).toThrow('kb-scope command missing');
  expect(() => commandSide(HISTORY, 3, [FIRST])).toThrow('turn 3 start missing');
  const repeated = [...HISTORY, { type: 'turn/start', seq: 9, data: { turn: 2 } }];
  expect(() => commandSide(repeated, 2, [FIRST])).toThrow('turn 2 start missing');
});

it('sees a turn end only for that turn', () => {
  expect(turnEnded(HISTORY, 1)).toBe(true);
  expect(turnEnded(HISTORY, 2)).toBe(false);
});

it('records a step with the button text, counts and screenshot only', () => {
  const value = { child: false, selection: [SECOND], turn: { turn: 1, scope: [FIRST] } };
  expect(scopeStep('running', SNAPSHOT, value, 'scope-running')).toEqual({
    step: 'running',
    button: '知识库：1 个',
    selected: 1,
    snapshot: 1,
    screenshot: 'scope-running.png',
  });
  const all = { child: false, selection: null, turn: null };
  expect(scopeStep('default', { ...SNAPSHOT, label: '知识库：全部' }, all)).toEqual({
    step: 'default',
    button: '知识库：全部',
    selected: 'all',
    snapshot: null,
  });
  const whole = { ...value, turn: { turn: 2, scope: null } };
  expect(scopeStep('next', SNAPSHOT, whole).snapshot).toBe('all');
  expect(() => scopeStep('x', { ...SNAPSHOT, label: null }, all)).toThrow(
    'Knowledge scope control not rendered',
  );
});

it('reads the Session ID from a successful session/create answer', () => {
  const answer = {
    type: 'server-response',
    rpcId: 'r',
    result: { ok: true, value: { sessionId: 'S-1_a' } },
  };
  expect(createdSessionId(answer)).toBe('S-1_a');
});

it.each([
  ['a non-object', 'x'],
  ['another envelope', { type: 'client-request', result: { ok: true, value: { sessionId: 's' } } }],
  ['a refused creation', { type: 'server-response', result: { ok: false, error: { code: 'x' } } }],
  ['a missing ID', { type: 'server-response', result: { ok: true, value: {} } }],
  ['an empty ID', { type: 'server-response', result: { ok: true, value: { sessionId: '' } } }],
  [
    'an ID with a slash',
    { type: 'server-response', result: { ok: true, value: { sessionId: 'a/b' } } },
  ],
])('rejects %s as a creation answer', (_label, body) => {
  expect(() => createdSessionId(body)).toThrow('Session creation answer malformed');
});

it('describes a stalled scope step by button, Session, pending flag, list and host selection', () => {
  const host = { child: false, selection: null, turn: null };
  expect(scopeStall(SNAPSHOT, 'session-1', host)).toBe(
    'button=知识库：1 个 session=expected pending=false list=list host=all turn=none',
  );
  expect(
    scopeStall({ ...SNAPSHOT, list: null, current: 'other' }, 'session-1', {
      ...host,
      selection: [FIRST, SECOND],
      turn: { turn: 3, scope: [] },
    }),
  ).toBe('button=知识库：1 个 session=other pending=none list=closed host=2 turn=3');
  expect(scopeStall({ ...SNAPSHOT, label: null, current: null }, 'session-1', 'unavailable')).toBe(
    'button=none session=none pending=false list=list host=unavailable turn=unavailable',
  );
  // Neither IDs nor library names appear.
  expect(scopeStall(SNAPSHOT, 'session-1', { ...host, selection: [FIRST] })).not.toContain(FIRST);
});

it('accepts the scope composer card state as observed', () => {
  const state = { draft: 'hello', focused: true, send: 'enabled', stop: false };
  expect(composerCard(state)).toEqual(state);
  expect(composerCard(null)).toBeNull();
});

it.each([
  ['a non-object', 'x'],
  ['a numeric draft', { draft: 1, focused: true, send: 'enabled', stop: false }],
  ['a non-boolean focus', { draft: '', focused: 'yes', send: 'enabled', stop: false }],
  ['an unknown send state', { draft: '', focused: true, send: 'busy', stop: false }],
  ['a non-boolean stop', { draft: '', focused: true, send: 'none', stop: 1 }],
])('rejects a composer state with %s', (_label, value) => {
  expect(() => composerCard(value)).toThrow('Knowledge scope composer state malformed');
});
