import { describe, expect, it } from 'vitest';
import { apply } from './index.js';

function runtime(preset = 'approval') {
  const handlers = new Map();
  const withdrawals = [];
  let guard, dispose;
  const state = {
    preset,
    sandbox: 'danger-full-access',
    approval: preset === 'danger-full-access' ? 'never' : 'ask',
  };
  const agent = {
    options: {},
    session: { id: 'root', header: { cwd: '/data/work' }, requestHeader: () => undefined },
    cancel: () => {},
    whenIdle: async () => {},
  };
  const ctx = {
    on: (event, fn) => {
      handlers.set(event, fn);
      return () => handlers.delete(event);
    },
    effect: (fn) => {
      const effect = fn();
      const cleanup = typeof effect === 'function' ? [effect] : [...effect];
      dispose = async () => {
        for (const release of cleanup.reverse()) await release();
      };
    },
    provide: () => () => {
      withdrawals.push(handlers.has('tools/pre-execute'));
    },
    tools: {
      guard: (fn) => {
        guard = fn;
        return () => {};
      },
      schemas: () => [{ name: 'write', parameters: {} }],
    },
    sessionProjections: { stateOf: () => state },
    permissionPresets: {
      resolve: (name) => ({
        sandbox: 'danger-full-access',
        approval: name === 'danger-full-access' ? 'never' : 'ask',
      }),
    },
    agents: { get: () => agent, list: () => [agent] },
    llm: {
      stream: async function* () {
        yield { type: 'text-delta', index: 0, text: '{"decision":"allow"}' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
  };
  apply(ctx);
  const execution = {
    name: 'write',
    callId: 'call',
    arguments: {},
    agent,
    signal: new AbortController().signal,
  };
  return {
    ctx,
    state,
    agent,
    handlers,
    withdrawals,
    execution,
    gate: (next) =>
      handlers.get('tools/pre-execute')(execution, next ?? (async () => ({ kind: 'allow' }))),
    guard: () => guard(execution),
    dispose: () => dispose(),
  };
}

describe('managed permission authorization', () => {
  it.each(['write', 'edit', 'bash', 'run_code'])(
    'requires native approval for %s including program transport',
    async (name) => {
      const fixture = runtime();
      fixture.execution.name = name;

      expect((await fixture.gate()).kind).toBe('ask');
      expect(fixture.guard()).toBeUndefined();
    },
  );

  it.each(['deny', 'ask', 'cancel'])(
    'preserves downstream %s without replacing ownership',
    async (kind) => {
      const fixture = runtime();
      const downstream = { kind, reason: 'other policy' };

      expect(await fixture.gate(async () => downstream)).toEqual({ kind, reason: 'other policy' });
    },
  );

  it('reviews an Auto mutation before resolving another policy’s human question', async () => {
    const fixture = runtime('auto-review');
    fixture.agent.options = { provider: 'owned', model: 'selected' };
    let reviewed = false;
    fixture.ctx.llm.stream = async function* () {
      reviewed = true;
      yield { type: 'text-delta', index: 0, text: '{"decision":"allow"}' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    };

    expect(
      await fixture.gate(async () => ({ kind: 'ask', reason: 'Independent policy question' })),
    ).toEqual({
      kind: 'ask',
      reason: 'Independent policy question',
    });
    expect(reviewed).toBe(true);
  });

  it.each(['deny', 'cancel'])(
    'does not review an Auto mutation already vetoed by downstream %s',
    async (kind) => {
      const fixture = runtime('auto-review');
      fixture.agent.options = { provider: 'owned', model: 'selected' };
      let reviewed = false;
      fixture.ctx.llm.stream = async function* () {
        reviewed = true;
        yield { type: 'finish', reason: { kind: 'error' } };
      };

      expect((await fixture.gate(async () => ({ kind }))).kind).toBe(kind);
      expect(reviewed).toBe(false);
    },
  );

  it('does not classify unknown identity or mismatched knobs as Yolo', async () => {
    const fixture = runtime('unknown');
    fixture.state.approval = 'never';

    expect((await fixture.gate()).kind).toBe('deny');
    fixture.state.preset = 'approval';
    expect((await fixture.gate()).kind).toBe('deny');
  });

  it('does not add questions to readonly or explicit Yolo calls', async () => {
    const fixture = runtime('danger-full-access');

    expect(await fixture.gate()).toEqual({ kind: 'allow' });
    fixture.execution.name = 'read';
    fixture.execution.agent = undefined;
    expect(await fixture.gate()).toEqual({ kind: 'allow' });
  });

  it('rejects agentless mutations', async () => {
    const fixture = runtime();
    fixture.execution.agent = undefined;

    expect((await fixture.gate()).kind).toBe('deny');
  });

  it('invalidates native approval across ABA but not approval audit events', async () => {
    const fixture = runtime();
    await fixture.gate();
    fixture.handlers.get('session/event')(fixture.agent.session, { type: 'approval/asked' });
    expect(fixture.guard()).toBeUndefined();

    fixture.handlers.get('session/event')(fixture.agent.session, { type: 'permission/preset' });
    fixture.handlers.get('session/event')(fixture.agent.session, { type: 'permission/preset' });
    expect(fixture.guard()).toBe('Managed permission authorization changed; retry the call.');
  });

  it('cancels admitted calls while closing without changing durable permissions', async () => {
    const fixture = runtime();
    await fixture.gate();

    await fixture.dispose();
    expect(fixture.state.preset).toBe('approval');
    expect(fixture.guard()).toBe('Managed permissions are unavailable.');
  });

  it('Auto without a route falls back to a fixed safe question', async () => {
    const fixture = runtime('auto-review');

    expect(await fixture.gate()).toEqual({
      kind: 'ask',
      reason: 'Auto review did not authorize this call. Human approval is required.',
      displayReason: {
        en: 'Auto review did not authorize this call. Human approval is required.',
        zh: 'Auto 审查未放行此调用，需要人工批准。',
      },
    });
  });

  it('permits Auto only after a complete review and invalidates a pending review across ABA', async () => {
    const fixture = runtime('auto-review');
    fixture.agent.options = { provider: 'owned', model: 'selected' };
    expect(await fixture.gate()).toEqual({ kind: 'allow' });

    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    fixture.ctx.llm.stream = async function* () {
      entered.resolve();
      await release.promise;
      yield { type: 'text-delta', index: 0, text: '{"decision":"allow"}' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    };
    const pending = fixture.gate();
    await entered.promise;
    fixture.handlers.get('session/event')(fixture.agent.session, { type: 'permission/preset' });
    fixture.handlers.get('session/event')(fixture.agent.session, { type: 'permission/preset' });
    release.resolve();
    expect((await pending).kind).toBe('deny');
  });

  it('cancels review and waits for Agent quiescence before finishing unload', async () => {
    const fixture = runtime('auto-review');
    fixture.agent.options = { provider: 'owned', model: 'selected' };
    const entered = Promise.withResolvers();
    const idle = Promise.withResolvers();
    fixture.agent.whenIdle = () => idle.promise;
    fixture.ctx.llm.stream = async function* (options) {
      const stopped = Promise.withResolvers();
      options.signal.addEventListener('abort', () => stopped.resolve(), { once: true });
      entered.resolve();
      await stopped.promise;
      yield { type: 'finish', reason: { kind: 'aborted' } };
    };
    const pending = fixture.gate();
    await entered.promise;
    let disposed = false;
    const closing = fixture.dispose().then(() => {
      disposed = true;
    });
    expect((await pending).kind).toBe('cancel');
    expect(disposed).toBe(false);
    expect((await fixture.gate()).kind).toBe('cancel');
    idle.resolve();
    await closing;
    expect(disposed).toBe(true);
  });

  it('does not retain authorization after result or when the Agent identity was replaced', async () => {
    const fixture = runtime();
    await fixture.gate();
    fixture.handlers.get('tools/result')(fixture.execution);
    expect(fixture.guard()).toBe('Managed permissions are unavailable.');

    await fixture.gate();
    fixture.ctx.agents.get = () => ({ ...fixture.agent });
    expect(fixture.guard()).toBe('Managed permissions are unavailable.');
    expect((await fixture.gate()).kind).toBe('deny');
  });

  it('rejects incomplete or corrupt persisted bundles, and stops creation while closing', async () => {
    const fixture = runtime();
    fixture.ctx.sessionProjections.stateOf = () => undefined;
    expect((await fixture.gate()).kind).toBe('deny');
    fixture.ctx.sessionProjections.stateOf = () => fixture.state;
    fixture.ctx.permissionPresets.resolve = () => ({ sandbox: 'workspace-write', approval: 'ask' });
    expect((await fixture.gate()).kind).toBe('deny');

    const idle = Promise.withResolvers();
    fixture.agent.whenIdle = () => idle.promise;
    const closing = fixture.dispose();
    expect(() =>
      fixture.handlers.get('agent/created')({ agent: fixture.agent, source: 'startup' }),
    ).toThrow('Managed permissions are unavailable.');
    idle.resolve();
    await closing;
  });

  it('withdraws the required service while the mutation gate is still installed', async () => {
    const fixture = runtime();

    await fixture.dispose();

    expect(fixture.withdrawals).toEqual([true]);
    expect(fixture.handlers.has('tools/pre-execute')).toBe(false);
  });
});

it('initializes a fresh delegated child before work and preserves a resumed selection', () => {
  const fixture = runtime('auto-review');
  const events = [];
  const contexts = [];
  let assemble;
  const child = {
    session: {
      id: 'child',
      header: { origin: 'subagent', parentSession: 'root' },
      append: (type, data) => events.push({ type, data }),
    },
    ctx: {
      systemPrompt: { context: (value) => contexts.push(value), getContextOrder: () => 120 },
      on: (event, callback) => {
        assemble = callback;
      },
    },
  };

  fixture.handlers.get('agent/created')({ agent: child, source: 'startup' });
  expect(events).toEqual([
    { type: 'permission/preset', data: { preset: 'auto-review' } },
    { type: 'sandbox/mode', data: { mode: 'danger-full-access' } },
    { type: 'approval/policy', data: { policy: 'ask' } },
  ]);
  fixture.handlers.get('agent/created')({ agent: child, source: 'resume' });
  expect(events).toHaveLength(3);
  expect(contexts[0].name).toBe('managed-permissions:delegation');
  return assemble({}, {}, async () => ({
    contexts: [
      { name: 'subagent:delegation', text: 'approval rejected automatically' },
      { name: 'other', text: 'retained' },
    ],
  })).then((result) => expect(result.contexts).toEqual([{ name: 'other', text: 'retained' }]));
});
