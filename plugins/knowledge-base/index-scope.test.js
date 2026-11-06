import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apply, scopeCommand, scopeProjection } from './index.js';

const VALID = 'http://172.30.0.3:8080';
const TOKEN = 'a1'.repeat(32);
const FIRST = '0123456789abcdef0123456789abcdef';
const SECOND = 'fedcba9876543210fedcba9876543210';
const INVALID = { kind: 'error', text: '知识库范围参数无效' };
const ids = (count) =>
  Array.from({ length: count }, (_, index) => index.toString(16).padStart(32, '0'));

/** A host context recording the scoped registrations its `inject` callback makes. */
function scopedContext(services = true) {
  const injected = [];
  const projections = [];
  const commands = [];
  const ctx = {
    on: () => undefined,
    effect: () => undefined,
    connection: { fetch: { register: () => () => Promise.resolve() } },
    logger: { warn: () => undefined },
    inject(deps, callback) {
      injected.push(deps);
      // The retrieval tool's injection is index-search.test.js's.
      if (!services || deps.includes('tools')) return;
      callback({
        sessionProjections: { register: (definition) => projections.push(definition) },
        commands: { register: (definition) => commands.push(definition) },
      });
    },
  };
  return { ctx, injected, projections, commands };
}

beforeEach(() => {
  vi.stubEnv('DSH_TEAM_INSTANCE_TOKEN', TOKEN);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('registration', () => {
  it('registers the kbScope projection and the kb-scope command once when available', () => {
    const { ctx, injected, projections, commands } = scopedContext();

    apply(ctx, { platformUrl: VALID });

    expect(injected).toEqual([
      ['sessionProjections', 'commands'],
      ['tools', 'sessionProjections', 'agents'],
    ]);
    expect(projections).toEqual([scopeProjection]);
    expect(commands).toEqual([scopeCommand]);
  });

  it('keeps the panel when the scoped services never arrive', () => {
    const { ctx, injected, projections, commands } = scopedContext(false);

    apply(ctx, { platformUrl: VALID });

    expect(injected).toEqual([
      ['sessionProjections', 'commands'],
      ['tools', 'sessionProjections', 'agents'],
    ]);
    expect(projections).toEqual([]);
    expect(commands).toEqual([]);
  });

  it.each([
    ['no address', undefined, TOKEN],
    ['no token', { platformUrl: VALID }, undefined],
    ['a malformed token', { platformUrl: VALID }, 'A1'.repeat(32)],
  ])('registers neither without availability (%s)', (_label, config, token) => {
    vi.stubEnv('DSH_TEAM_INSTANCE_TOKEN', token);
    const { ctx, injected } = scopedContext();

    apply(ctx, config);

    expect(injected).toEqual([]);
  });

  it('describes the command in fixed Chinese, without attachments, under the package identity', () => {
    expect(Object.keys(scopeCommand)).toEqual([
      'definitionId',
      'name',
      'description',
      'input',
      'handler',
    ]);
    expect(scopeCommand).toMatchObject({
      definitionId: '@dsh-team/knowledge-base',
      name: 'kb-scope',
      description: '设置本 Session 的知识库检索范围（由输入区控件调用）',
      input: { hint: '<json>' },
    });
    expect(Object.keys(scopeCommand.input)).toEqual(['hint']);
    expect(scopeProjection).toMatchObject({ key: 'kbScope', stateVersion: 1 });
  });
});

describe('command handler', () => {
  const run = (rawInput) => scopeCommand.handler({ rawInput, attachments: [] });

  it.each([
    [' {"datasetIds":null}', '知识库范围：全部'],
    ['{"datasetIds":[]}', '知识库范围：不检索'],
    [` {"datasetIds":["${FIRST}"]} \n`, '知识库范围：1 个'],
    [`\t{ "datasetIds" : ["${FIRST}", "${SECOND}"] }`, '知识库范围：2 个'],
    [JSON.stringify({ datasetIds: ids(1000) }), '知识库范围：1000 个'],
  ])('accepts %s', (rawInput, text) => {
    expect(run(rawInput)).toEqual({ kind: 'success', text });
  });

  it.each([
    ['an empty input', ''],
    ['blank input', '   '],
    ['non-JSON', 'all'],
    ['a bare null', 'null'],
    ['a bare list', `["${FIRST}"]`],
    ['a string', '"kb-sentinel"'],
    ['an empty object', '{}'],
    ['an extra key', `{"datasetIds":null,"kb-sentinel":1}`],
    ['another key', '{"ids":null}'],
    ['a string ID list', `{"datasetIds":"${FIRST}"}`],
    ['a boolean', '{"datasetIds":true}'],
    ['an upper-case ID', `{"datasetIds":["${FIRST.toUpperCase()}"]}`],
    ['a short ID', `{"datasetIds":["${FIRST.slice(1)}"]}`],
    ['a numeric ID', '{"datasetIds":[1]}'],
    ['a null ID', '{"datasetIds":[null]}'],
    ['a duplicate ID', `{"datasetIds":["${FIRST}","${FIRST}"]}`],
    ['1001 IDs', JSON.stringify({ datasetIds: ids(1001) })],
    ['over 40000 bytes', `${' '.repeat(40_000)}{"datasetIds":[]}`],
    ['trailing text', '{"datasetIds":[]} kb-sentinel'],
  ])('refuses %s with the fixed error and no echo', (_label, rawInput) => {
    const result = run(rawInput);

    expect(result).toEqual(INVALID);
    expect(JSON.stringify(result)).not.toContain('kb-sentinel');
  });

  it('accepts exactly 40000 bytes', () => {
    const body = `{"datasetIds":["${FIRST}"]}`;
    expect(run(`${' '.repeat(40_000 - body.length)}${body}`).kind).toBe('success');
  });
});

const header = (extra = {}) => ({ id: 's1', cwd: '/data/work', ...extra });
let seq = 0;
const event = (type, data) => ({ type, seq: seq++, time: 1, data });
const runEvent = (commandId, args, name = 'kb-scope') =>
  event('command/run', { commandId, name, args, source: { kind: 'user' } });
const doneEvent = (commandId, kind = 'success') => event('command/done', { commandId, kind });
const scopeArgs = (datasetIds) => ` ${JSON.stringify({ datasetIds })}`;
const fold = (events, state = scopeProjection.init(header(), 0)) =>
  events.reduce((current, next) => scopeProjection.apply(current, next), state);

describe('projection fold', () => {
  it('starts every Session on the whole scope with no snapshot', () => {
    expect(scopeProjection.init(header(), 0)).toEqual({
      child: false,
      selection: null,
      running: null,
      turn: null,
    });
    expect(scopeProjection.init(header({ origin: 'subagent', parentSession: 'p' }), 0).child).toBe(
      true,
    );
    // An employee fork carries a parent but no origin: it is its own root.
    expect(scopeProjection.init(header({ parentSession: 'p' }), 3).child).toBe(false);
  });

  it('applies a paired successful command and keeps [] apart from the whole scope', () => {
    const none = fold([runEvent('c1', scopeArgs([])), doneEvent('c1')]);
    expect(none).toEqual({ child: false, selection: [], running: null, turn: null });
    const some = fold([runEvent('c2', scopeArgs([FIRST])), doneEvent('c2')], none);
    expect(some.selection).toEqual([FIRST]);
    const all = fold([runEvent('c3', scopeArgs(null)), doneEvent('c3')], some);
    expect(all.selection).toBeNull();
  });

  it('records the pending command between run and done', () => {
    expect(fold([runEvent('c1', scopeArgs([FIRST]))])).toEqual({
      child: false,
      selection: null,
      running: { commandId: 'c1', selection: [FIRST] },
      turn: null,
    });
  });

  it.each([
    ['a failed done', [runEvent('c1', scopeArgs([FIRST])), doneEvent('c1', 'error')]],
    ['bad arguments', [runEvent('c1', '{"datasetIds":"x"}'), doneEvent('c1')]],
    ['missing arguments', [runEvent('c1', undefined), doneEvent('c1')]],
    ['an unpaired done', [runEvent('c1', scopeArgs([FIRST])), doneEvent('c2')]],
    ['a run without done', [runEvent('c1', scopeArgs([FIRST]))]],
    ['another command', [runEvent('c1', scopeArgs([FIRST]), 'plan'), doneEvent('c1')]],
  ])('ignores %s', (_label, events) => {
    const base = fold([runEvent('c0', scopeArgs([SECOND])), doneEvent('c0')]);

    expect(fold(events, base).selection).toEqual([SECOND]);
  });

  it('lets a later run replace the pending one, so only its done applies', () => {
    const state = fold([
      runEvent('c1', scopeArgs([FIRST])),
      runEvent('c2', scopeArgs([SECOND])),
      doneEvent('c1'),
      doneEvent('c2'),
    ]);
    expect(state.selection).toEqual([SECOND]);
    expect(state.running).toBeNull();
  });

  it('clears the pending command when a later run is invalid', () => {
    const state = fold([runEvent('c1', scopeArgs([FIRST])), runEvent('c2', 'bad')]);
    expect(state.running).toBeNull();
    expect(fold([doneEvent('c1')], state).selection).toBeNull();
  });

  it('snapshots the selection at turn/start; later commands change only the selection', () => {
    const first = fold([
      runEvent('c1', scopeArgs([FIRST])),
      doneEvent('c1'),
      event('turn/start', { turn: 1 }),
    ]);
    expect(first.turn).toEqual({ turn: 1, scope: [FIRST] });
    const changed = fold([runEvent('c2', scopeArgs([SECOND])), doneEvent('c2')], first);
    expect(changed).toEqual({
      child: false,
      selection: [SECOND],
      running: null,
      turn: { turn: 1, scope: [FIRST] },
    });
    const second = fold([event('turn/start', { turn: 2 })], changed);
    expect(second.turn).toEqual({ turn: 2, scope: [SECOND] });
    // A turn without any command snapshots the whole scope.
    expect(fold([event('turn/start', { turn: 1 })]).turn).toEqual({ turn: 1, scope: null });
  });

  it('returns the same state reference for unrelated events', () => {
    const state = fold([runEvent('c1', scopeArgs([FIRST])), doneEvent('c1')]);
    for (const other of [
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }),
      event('user/message', { content: [] }),
      runEvent('c9', scopeArgs([SECOND]), 'compact'),
      doneEvent('c9'),
    ])
      expect(scopeProjection.apply(state, other)).toBe(state);
  });

  it('views the selection and snapshot without the pending command', () => {
    const state = fold([
      runEvent('c1', scopeArgs([FIRST])),
      doneEvent('c1'),
      event('turn/start', { turn: 4 }),
      runEvent('c2', scopeArgs([])),
    ]);
    expect(scopeProjection.wire.view(state)).toEqual({
      child: false,
      selection: [FIRST],
      turn: { turn: 4, scope: [FIRST] },
    });
  });
});

describe('schemas', () => {
  const valid = [
    { child: false, selection: null, running: null, turn: null },
    {
      child: true,
      selection: [FIRST, SECOND],
      running: { commandId: 'cmd-1', selection: [] },
      turn: { turn: 0, scope: null },
    },
    { child: false, selection: [], running: { commandId: 'c', selection: null }, turn: null },
  ];

  it('accepts and returns valid states and views', () => {
    for (const state of valid) {
      expect(scopeProjection.stateSchema.parse(structuredClone(state))).toEqual(state);
      const view = scopeProjection.wire.view(state);
      expect(scopeProjection.wire.viewSchema.parse(view)).toBe(view);
    }
  });

  const base = valid[0];
  it.each([
    ['a missing value', undefined],
    ['an array', []],
    ['a missing key', { child: false, selection: null, running: null }],
    ['an extra key', { ...base, extra: 1 }],
    ['a non-boolean child', { ...base, child: 'no' }],
    ['a string selection', { ...base, selection: FIRST }],
    ['a malformed ID', { ...base, selection: ['x'] }],
    ['a duplicate ID', { ...base, selection: [FIRST, FIRST] }],
    ['1001 IDs', { ...base, selection: ids(1001) }],
    ['a running without ID', { ...base, running: { selection: null } }],
    ['a running with extra keys', { ...base, running: { commandId: 'c', selection: null, x: 1 } }],
    ['a non-string command ID', { ...base, running: { commandId: 1, selection: null } }],
    ['a bad running selection', { ...base, running: { commandId: 'c', selection: 'x' } }],
    ['a fractional turn', { ...base, turn: { turn: 1.5, scope: null } }],
    ['a negative turn', { ...base, turn: { turn: -1, scope: null } }],
    ['a turn without scope', { ...base, turn: { turn: 1 } }],
    ['a bad turn scope', { ...base, turn: { turn: 1, scope: [1] } }],
    ['a turn with extra keys', { ...base, turn: { turn: 1, scope: null, x: 1 } }],
  ])('rejects a state with %s', (_label, state) => {
    expect(() => scopeProjection.stateSchema.parse(state)).toThrow();
  });

  it.each([
    ['a running key', { ...base }],
    ['a missing turn', { child: false, selection: null }],
    ['a bad selection', { child: false, selection: [1], turn: null }],
    ['a non-object', null],
  ])('rejects a view with %s', (_label, view) => {
    expect(() => scopeProjection.wire.viewSchema.parse(view)).toThrow();
  });
});
