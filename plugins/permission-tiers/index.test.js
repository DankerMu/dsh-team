import { describe, expect, it } from 'vitest';
import { apply } from './index.js';

function permissionRuntime(preset = 'approval', mutation = 'write') {
  const handlers = new Map();
  const withdrawals = [];
  let guard, dispose;
  const controller = new AbortController();
  const cancellations = [];
  const state = {
    preset,
    sandbox: 'danger-full-access',
    approval: preset === 'danger-full-access' ? 'never' : 'ask',
  };
  const agent = {
    options: {},
    session: { id: 'root', header: { cwd: '/data/work' }, requestHeader: () => undefined },
    cancel: (cause, options) => {
      cancellations.push({ cause, options });
      controller.abort(cause);
    },
    whenIdle: async () => {},
  };
  // Each Session has its own permissions projection and live Agent, keyed by Session ID.
  const projections = new Map([['root', state]]);
  const registry = new Map([['root', agent]]);
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
      schemas: () => [{ name: mutation, parameters: {} }],
    },
    sessionProjections: { stateOf: (session) => projections.get(session.id) },
    permissionPresets: {
      resolve: (name) => ({
        sandbox: 'danger-full-access',
        approval: name === 'danger-full-access' ? 'never' : 'ask',
      }),
    },
    agents: { get: (id) => registry.get(id), list: () => [agent] },
    llm: {
      stream: async function* () {
        yield { type: 'text-delta', index: 0, text: '{"decision":"allow"}' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
  };
  apply(ctx);
  const execution = {
    name: mutation,
    callId: 'call',
    arguments: {},
    agent,
    signal: controller.signal,
  };
  return {
    ctx,
    state,
    agent,
    projections,
    registry,
    handlers,
    withdrawals,
    cancellations,
    execution,
    gate: (next) =>
      handlers.get('tools/pre-execute')(execution, next ?? (async () => ({ kind: 'allow' }))),
    guard: () => guard(execution),
    dispose: () => dispose(),
  };
}

describe.each(['write', 'build_docx'])('%s managed permission authorization', (mutation) => {
  const runtime = (preset) => permissionRuntime(preset, mutation);
  it.each(mutation === 'write' ? ['write', 'edit', 'bash', 'run_code'] : ['build_docx'])(
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

  it('does not admit a mutation after its caller cancels', async () => {
    const fixture = runtime('danger-full-access');
    fixture.agent.cancel({ kind: 'user' });

    expect(await fixture.gate()).toEqual({ kind: 'cancel' });
    expect(fixture.guard()).toBeDefined();
  });
});

describe.each(['write', 'build_docx'])('%s managed permission revocation', (mutation) => {
  const runtime = (preset) => permissionRuntime(preset, mutation);
  it('invalidates native approval across ABA but not approval audit events', async () => {
    const fixture = runtime();
    await fixture.gate();
    fixture.handlers.get('session/event')(fixture.agent.session, { type: 'approval/asked' });
    expect(fixture.guard()).toBeUndefined();

    fixture.handlers.get('session/event')(fixture.agent.session, { type: 'permission/preset' });
    fixture.handlers.get('session/event')(fixture.agent.session, { type: 'permission/preset' });
    expect(fixture.execution.signal.aborted).toBe(true);
    expect(fixture.guard()).toBeDefined();
  });

  it.each(['permission/preset', 'sandbox/mode', 'approval/policy'])(
    'revokes admitted mutations when %s changes before their result',
    async (type) => {
      const fixture = runtime('danger-full-access');
      expect(await fixture.gate()).toEqual({ kind: 'allow' });
      expect(fixture.guard()).toBeUndefined();

      fixture.handlers.get('session/event')(fixture.agent.session, { type });

      expect(fixture.execution.signal.aborted).toBe(true);
      expect(fixture.cancellations).toEqual([
        { cause: { kind: 'user' }, options: { keepInbox: true } },
      ]);
    },
  );

  it('does not cancel another Session or an idle Session without owned mutations', async () => {
    const fixture = runtime('danger-full-access');
    const event = { type: 'permission/preset' };
    fixture.handlers.get('session/event')(fixture.agent.session, event);
    await fixture.gate();

    fixture.handlers.get('session/event')({ id: 'other' }, event);
    fixture.handlers.get('session/event')({ ...fixture.agent.session }, event);
    fixture.handlers.get('session/event')(fixture.agent.session, { type: 'approval/decided' });

    expect(fixture.execution.signal.aborted).toBe(false);
    expect(fixture.cancellations).toEqual([]);
    expect(fixture.guard()).toBeUndefined();
  });

  it('revokes one Session without aborting another Session’s admitted mutation', async () => {
    const fixture = runtime('danger-full-access');
    const otherController = new AbortController();
    const other = {
      ...fixture.agent,
      session: { ...fixture.agent.session, id: 'other' },
      cancel: (cause) => otherController.abort(cause),
    };
    fixture.ctx.agents.get = (id) => (id === 'other' ? other : fixture.agent);
    fixture.projections.set('other', fixture.state);
    await fixture.gate();
    const otherExecution = {
      ...fixture.execution,
      agent: other,
      callId: 'other-call',
      signal: otherController.signal,
    };
    expect(
      await fixture.handlers.get('tools/pre-execute')(otherExecution, async () => ({
        kind: 'allow',
      })),
    ).toEqual({ kind: 'allow' });

    fixture.handlers.get('session/event')(fixture.agent.session, { type: 'permission/preset' });

    expect(fixture.execution.signal.aborted).toBe(true);
    expect(otherExecution.signal.aborted).toBe(false);
    expect(fixture.cancellations).toHaveLength(1);
  });

  it('does not stop readonly or completed mutations on a later permission change', async () => {
    const fixture = runtime('danger-full-access');
    await fixture.gate();
    fixture.handlers.get('tools/result')(fixture.execution);
    fixture.execution.name = 'read';
    await fixture.gate();

    fixture.handlers.get('session/event')(fixture.agent.session, { type: 'permission/preset' });

    expect(fixture.execution.signal.aborted).toBe(false);
    expect(fixture.cancellations).toEqual([]);
  });

  it('cancels one original Agent once for overlapping mutations and an ABA bundle', async () => {
    const fixture = runtime('danger-full-access');
    await fixture.gate();
    const nested = { ...fixture.execution, callId: 'nested', name: 'bash' };
    await fixture.handlers.get('tools/pre-execute')(nested, async () => ({ kind: 'allow' }));

    fixture.handlers.get('session/event')(fixture.agent.session, { type: 'permission/preset' });
    fixture.handlers.get('session/event')(fixture.agent.session, { type: 'sandbox/mode' });
    fixture.handlers.get('session/event')(fixture.agent.session, { type: 'permission/preset' });

    expect(nested.signal.aborted).toBe(true);
    expect(fixture.execution.signal.aborted).toBe(true);
    expect(fixture.cancellations).toEqual([
      { cause: { kind: 'user' }, options: { keepInbox: true } },
    ]);
  });

  it('does not cancel a replacement Agent for an old execution', async () => {
    const fixture = runtime('danger-full-access');
    await fixture.gate();
    fixture.ctx.agents.get = () => ({ ...fixture.agent });

    fixture.handlers.get('session/event')(fixture.agent.session, { type: 'permission/preset' });

    expect(fixture.execution.signal.aborted).toBe(false);
    expect(fixture.cancellations).toEqual([]);
    expect(fixture.guard()).toBeDefined();
  });

  it('interrupts a pending downstream wait using the original caller signal', async () => {
    const fixture = runtime('danger-full-access');
    const entered = Promise.withResolvers();
    const pending = fixture.gate(async () => {
      const stopped = Promise.withResolvers();
      fixture.execution.signal.addEventListener('abort', () => stopped.resolve(), { once: true });
      entered.resolve();
      await stopped.promise;
      return { kind: 'allow' };
    });
    await entered.promise;

    fixture.handlers.get('session/event')(fixture.agent.session, { type: 'approval/policy' });

    try {
      expect(fixture.execution.signal.aborted).toBe(true);
      expect(await pending).toEqual({ kind: 'cancel' });
    } finally {
      fixture.agent.cancel({ kind: 'user' });
      await pending;
    }
  });
});

describe.each(['write', 'build_docx'])('%s managed permission review and teardown', (mutation) => {
  const runtime = (preset) => permissionRuntime(preset, mutation);
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

  it.each([
    { label: 'denied', text: '{"decision":"deny"}', finish: 'stop' },
    { label: 'malformed', text: 'not JSON', finish: 'stop' },
    { label: 'incomplete', text: '{"decision":"allow"}', finish: 'max-tokens' },
    { label: 'failed', failure: true },
  ])('asks the human when an Auto review is $label', async (review) => {
    const fixture = runtime('auto-review');
    fixture.agent.options = { provider: 'owned', model: 'selected' };
    fixture.ctx.llm.stream = async function* () {
      if (review.failure) throw new Error('Review adapter unavailable');
      yield { type: 'text-delta', index: 0, text: review.text };
      yield { type: 'finish', reason: { kind: review.finish } };
    };

    expect((await fixture.gate()).kind).toBe('ask');
    expect(fixture.guard()).toBeUndefined();
  });

  it('cancels an in-flight Auto review on permission revocation without awaiting its deadline', async () => {
    const fixture = runtime('auto-review');
    fixture.agent.options = { provider: 'owned', model: 'selected' };
    const entered = Promise.withResolvers();
    fixture.ctx.llm.stream = async function* (options) {
      const stopped = Promise.withResolvers();
      options.signal.addEventListener('abort', () => stopped.resolve(), { once: true });
      entered.resolve();
      await stopped.promise;
      yield { type: 'finish', reason: { kind: 'aborted' } };
    };
    const pending = fixture.gate();
    expect(
      await Promise.race([entered.promise.then(() => 'reviewing'), pending.then(() => 'settled')]),
    ).toBe('reviewing');

    fixture.handlers.get('session/event')(fixture.agent.session, { type: 'permission/preset' });

    expect(await pending).toEqual({ kind: 'cancel' });
    expect(fixture.execution.signal.aborted).toBe(true);
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
    expect(
      await Promise.race([entered.promise.then(() => 'reviewing'), pending.then(() => 'settled')]),
    ).toBe('reviewing');
    fixture.handlers.get('session/event')(fixture.agent.session, { type: 'permission/preset' });
    fixture.handlers.get('session/event')(fixture.agent.session, { type: 'permission/preset' });
    release.resolve();
    expect((await pending).kind).toBe('cancel');
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
    expect(
      await Promise.race([entered.promise.then(() => 'reviewing'), pending.then(() => 'settled')]),
    ).toBe('reviewing');
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

// Native Session projection: each permission event replaces exactly its own field.
const PROJECTED = {
  'permission/preset': ['preset', 'preset'],
  'sandbox/mode': ['sandbox', 'mode'],
  'approval/policy': ['approval', 'policy'],
};

/** A delegated child whose projection is built only from the events it appended itself.
 * `mode` is the native descriptor label; the host never reads it. */
function delegatedChild(fixture, mode, parentSession = 'root') {
  const events = [];
  const contexts = [];
  const projection = { preset: null, sandbox: null, approval: null };
  const controller = new AbortController();
  const child = {
    options: { provider: 'owned', model: 'selected' },
    session: {
      id: 'child',
      header: { cwd: '/data/work', origin: 'subagent', parentSession },
      subagent: { address: { mode } },
      requestHeader: () => undefined,
      append: (type, data) => {
        events.push({ type, data });
        const [field, key] = PROJECTED[type];
        projection[field] = data[key];
      },
    },
    ctx: {
      systemPrompt: { context: (value) => contexts.push(value), getContextOrder: () => 120 },
      on: (_event, callback) => {
        child.assemble = callback;
      },
    },
    cancel: (cause) => controller.abort(cause),
    whenIdle: async () => {},
  };
  fixture.registry.set('child', child);
  fixture.projections.set('child', projection);
  const created = (source) => fixture.handlers.get('agent/created')({ agent: child, source });
  return {
    child,
    events,
    contexts,
    start: () => created('startup'),
    resume: () => created('resume'),
    gate: () =>
      fixture.handlers.get('tools/pre-execute')(
        { ...fixture.execution, callId: 'child-call', agent: child, signal: controller.signal },
        async () => ({ kind: 'allow' }),
      ),
  };
}

const NEXT_TIER = {
  approval: 'auto-review',
  'auto-review': 'danger-full-access',
  'danger-full-access': 'approval',
};
const CHILD_DECISION = {
  approval: {
    kind: 'ask',
    reason: 'This call requires human approval before writing files or executing code.',
    displayReason: {
      en: 'This call requires human approval before writing files or executing code.',
      zh: '写文件或执行代码前，需要人工批准此调用。',
    },
  },
  'auto-review': { kind: 'allow' },
  'danger-full-access': { kind: 'allow' },
};

/** Switch the parent's durable selection to another consistent tier. */
function switchParent(fixture, tier) {
  fixture.state.preset = tier;
  fixture.state.approval = tier === 'danger-full-access' ? 'never' : 'ask';
}

// DSH 0.2.1 delegates every in-process child as continuable; the host never reads the mode.
describe('a continuable delegated child', () => {
  const mode = 'continuable';
  const tiers = ['approval', 'auto-review', 'danger-full-access'];

  it.each(tiers)('inherits the parent %s tier once at startup', (tier) => {
    const fixture = permissionRuntime(tier);
    const delegated = delegatedChild(fixture, mode);

    delegated.start();

    expect(delegated.events).toEqual([
      { type: 'permission/preset', data: { preset: tier } },
      { type: 'sandbox/mode', data: { mode: 'danger-full-access' } },
      {
        type: 'approval/policy',
        data: { policy: tier === 'danger-full-access' ? 'never' : 'ask' },
      },
    ]);
  });

  it.each(tiers)('keeps its own %s tier on resume after the parent switches tier', async (tier) => {
    const fixture = permissionRuntime(tier);
    const delegated = delegatedChild(fixture, mode);
    delegated.start();
    let reviewed = false;
    fixture.ctx.llm.stream = async function* () {
      reviewed = true;
      yield { type: 'text-delta', index: 0, text: '{"decision":"allow"}' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    };
    switchParent(fixture, NEXT_TIER[tier]);

    delegated.resume();

    expect(delegated.events).toHaveLength(3);
    expect(await delegated.gate()).toEqual(CHILD_DECISION[tier]);
    expect(reviewed).toBe(tier === 'auto-review');
    const parentDecision = NEXT_TIER[tier] === 'danger-full-access' ? 'allow' : 'ask';
    expect((await fixture.gate()).kind).toBe(parentDecision);
  });

  it('fails closed at startup when the parent has no tier', () => {
    const fixture = permissionRuntime();
    fixture.state.preset = null;
    const delegated = delegatedChild(fixture, mode);

    expect(() => delegated.start()).toThrow('Managed permissions are unavailable.');
    expect(delegated.events).toEqual([]);
  });

  it('fails closed at startup when the parent Session has no live Agent', () => {
    const fixture = permissionRuntime();
    const delegated = delegatedChild(fixture, mode, 'missing');

    expect(() => delegated.start()).toThrow('Managed permissions are unavailable.');
    expect(delegated.events).toEqual([]);
  });

  it('fails closed on resume when the child has no recorded tier', async () => {
    const fixture = permissionRuntime();
    const delegated = delegatedChild(fixture, mode);

    expect(() => delegated.resume()).toThrow('Managed permissions are unavailable.');
    expect(delegated.events).toEqual([]);
    expect((await delegated.gate()).kind).toBe('deny');
  });
});

it('replaces the native delegation guidance for a fresh or resumed delegated child', async () => {
  const fixture = permissionRuntime('auto-review');
  const delegated = delegatedChild(fixture, 'continuable');

  delegated.start();
  delegated.resume();

  expect(delegated.contexts.map((context) => context.name)).toEqual([
    'managed-permissions:delegation',
    'managed-permissions:delegation',
  ]);
  const result = await delegated.child.assemble({}, {}, async () => ({
    contexts: [
      { name: 'subagent:delegation', text: 'approval rejected automatically' },
      { name: 'other', text: 'retained' },
    ],
  }));
  expect(result.contexts).toEqual([{ name: 'other', text: 'retained' }]);
});
