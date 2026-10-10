import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const require = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json');
const load = (name) => import(pathToFileURL(require.resolve(name)).href);
const { LlmAdapter, createUserMessage, ToolCallId } = await load('@deepseek-ai/dsh-llm');
const { SessionId } = await load('@deepseek-ai/dsh-session');
export const inject = [
  'agents',
  'tools',
  'llm',
  'approval',
  'permissionPresets',
  'sessionProjections',
  'agentPresets',
  'subagents',
  'loader',
  'managedPermissions',
];
export const name = 'dsh-team-permission-fixture';
const ROOT = process.env.DSH_TEAM_PERMISSION_ROOT;
const INDEX = Number(process.env.DSH_TEAM_PERMISSION_INDEX);
const EXPECTED = ['danger-full-access', 'approval', 'auto-review'];
const target = (label) => '/data/work/permission-' + label + '-' + randomUUID();
const message = () =>
  createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'Owned host protocol test; no conversation model call.' }],
  });
const text = (value) => ({ type: 'text-delta', index: 0, text: value });
const finish = (kind) => ({
  type: 'finish',
  reason:
    kind === 'error' || kind === 'aborted'
      ? { kind, failure: { code: 'OWNED_TEST', message: 'owned adapter failure' } }
      : { kind },
});

class ProtocolAdapter extends LlmAdapter {
  mode = 'allow';
  entered = undefined;
  release = undefined;
  calls = 0;
  async *stream(options) {
    this.calls++;
    assert.equal(options.provider, 'permission-protocol');
    assert.equal(options.model, 'owned');
    assert(options.system.includes('authorization reviewer'));
    if (this.mode === 'wait') {
      this.entered.resolve();
      const pending = Promise.withResolvers();
      const abort = () => pending.resolve();
      options.signal.addEventListener('abort', abort, { once: true });
      this.release = pending;
      if (options.signal.aborted) pending.resolve();
      try {
        await pending.promise;
      } finally {
        options.signal.removeEventListener('abort', abort);
      }
      if (options.signal.aborted) {
        yield finish('aborted');
        return;
      }
    }
    if (this.mode === 'throw') throw new Error('private adapter details must not leak');
    const output =
      this.mode === 'duplicate'
        ? '{"decision":"allow","decision":"allow"}'
        : this.mode === 'extra'
          ? '{"decision":"allow","other":true}'
          : this.mode === 'oversize'
            ? ' '.repeat(8193)
            : this.mode === 'invalid'
              ? 'not JSON'
              : this.mode === 'deny'
                ? '{"decision":"deny"}'
                : '{"decision":"allow"}';
    yield text(output);
    if (this.mode === 'no-finish') return;
    yield finish(['error', 'aborted', 'max-tokens'].includes(this.mode) ? this.mode : 'stop');
    if (this.mode === 'trailing') yield text('trailing');
  }
}

/** Execute inside a real loop-owned open turn, rejecting ONLY subsequent model step admission. */
async function inTurn(ctx, agent, operation) {
  const settled = Promise.withResolvers();
  const dispose = agent.ctx.on(
    'agent/pre-step',
    async (payload) => {
      try {
        settled.resolve(await operation(payload.signal));
      } catch (error) {
        settled.reject(error);
      }
      return { kind: 'reject' };
    },
    { prepend: true },
  );
  try {
    agent.followup(message());
    const result = await settled.promise;
    await agent.whenIdle();
    return result;
  } finally {
    dispose();
  }
}
const execute = (ctx, agent, name, args) =>
  inTurn(ctx, agent, (signal) =>
    ctx.tools.execute({ callId: ToolCallId(randomUUID()), name, arguments: args, agent, signal }),
  );
const write = (ctx, agent, path, content = 'exact-owned-bytes\n') =>
  execute(ctx, agent, 'write', { file_path: path, content });
const state = (ctx, agent) => ctx.sessionProjections.stateOf(agent.session, 'permissions');

async function create(ctx, preset = 'standard') {
  return ctx.agents.create({
    sessionId: SessionId('permission-' + randomUUID()),
    meta: { cwd: '/data/work', agentPreset: preset },
    agentOptions: { provider: 'permission-protocol', model: 'owned' },
    setup: async (agentCtx) => {
      await ctx.agentPresets.mount(agentCtx, preset);
    },
  });
}

function approvals(ctx) {
  const control = {
    answer: 'allowed-once',
    requests: [],
    audit: [],
    entered: undefined,
    release: undefined,
    beforeAnswer: undefined,
  };
  ctx.on('session/event', (session, event) => {
    if (event.type === 'approval/asked' || event.type === 'approval/decided')
      control.audit.push({ sessionId: session.id, ...event });
  });
  control.dispose = ctx.on(
    'approval/request',
    async (req, next) => {
      if (
        !req.agent.session.id.startsWith('permission-') &&
        !req.agent.session.header.parentSession?.startsWith('permission-')
      )
        return next();
      control.requests.push(req);
      if (control.beforeAnswer) await control.beforeAnswer(req);
      if (control.answer !== 'hold') return control.answer;
      const pending = Promise.withResolvers();
      control.release = pending;
      control.entered.resolve(req);
      const abort = () => pending.resolve('cancelled');
      req.signal.addEventListener('abort', abort, { once: true });
      try {
        return await pending.promise;
      } finally {
        req.signal.removeEventListener('abort', abort);
      }
    },
    { prepend: true },
  );
  return control;
}

async function persistence(ctx, handle, approval) {
  const saved = ROOT + '/sessions.json';
  if (INDEX === 0) {
    ctx.permissionPresets.set(handle.agent.session, 'danger-full-access');
    const sibling = await create(ctx);
    ctx.permissionPresets.set(sibling.agent.session, 'approval');
    const before = approval.requests.length;
    const direct = target('isolated-yolo');
    assert.equal((await write(ctx, handle.agent, direct)).isError, false);
    assert.equal(readFileSync(direct, 'utf8'), 'exact-owned-bytes\n');
    assert.equal(approval.requests.length, before);
    const confirmed = target('isolated-manual');
    assert.equal((await write(ctx, sibling.agent, confirmed)).isError, false);
    assert.equal(readFileSync(confirmed, 'utf8'), 'exact-owned-bytes\n');
    assert.equal(approval.requests.length, before + 1);
    assert.equal(state(ctx, handle.agent).preset, 'danger-full-access');
    const ids = [handle.agent.session.id, sibling.agent.session.id];
    await sibling.dispose();
    writeFileSync(saved, JSON.stringify(ids));
  } else {
    const ids = JSON.parse(readFileSync(saved, 'utf8'));
    for (let index = 0; index < ids.length; index++) {
      const restored = await ctx.agents.resume({
        resumeSessionId: SessionId(ids[index]),
        agentOptions: { provider: 'permission-protocol', model: 'owned' },
        setup: async (agentCtx) => {
          await ctx.agentPresets.mount(agentCtx, 'standard');
        },
      });
      try {
        assert.equal(state(ctx, restored.agent).preset, ['danger-full-access', 'approval'][index]);
      } finally {
        await restored.dispose();
      }
    }
  }
}

async function manual(ctx, agent, approval) {
  ctx.permissionPresets.set(agent.session, 'approval');
  const path = target('manual');
  approval.beforeAnswer = (req) => {
    assert.equal(req.agent, agent);
    assert.equal(req.toolName, 'write');
    assert(!existsSync(path), 'The real body ran before approval');
  };
  assert.equal((await write(ctx, agent, path)).isError, false);
  assert.equal(readFileSync(path, 'utf8'), 'exact-owned-bytes\n');
  approval.beforeAnswer = undefined;
  approval.answer = 'rejected';
  const denied = target('reject');
  assert.equal((await write(ctx, agent, denied)).isError, true);
  assert(!existsSync(denied));
  const original = readFileSync(path, 'utf8');
  assert.equal(
    (
      await execute(ctx, agent, 'edit', {
        file_path: path,
        old_string: 'exact',
        new_string: 'changed',
      })
    ).isError,
    true,
  );
  assert.equal(readFileSync(path, 'utf8'), original);
  approval.answer = 'allowed-once';
  assert.equal(
    (
      await execute(ctx, agent, 'edit', {
        file_path: path,
        old_string: 'exact',
        new_string: 'changed',
      })
    ).isError,
    false,
  );
  assert.equal(readFileSync(path, 'utf8'), 'changed-owned-bytes\n');
  const bash = target('bash');
  approval.answer = 'rejected';
  await execute(ctx, agent, 'bash', {
    command: 'printf command-bytes > ' + bash,
    description: 'Write the owned command effect file',
  });
  assert(!existsSync(bash));
  approval.answer = 'allowed-once';
  assert.equal(
    (
      await execute(ctx, agent, 'bash', {
        command: 'printf command-bytes > ' + bash,
        description: 'Write the owned command effect file',
      })
    ).isError,
    false,
  );
  assert.equal(readFileSync(bash, 'utf8'), 'command-bytes');
}

async function guardContracts(ctx, agent, adapter, approval) {
  for (const tier of ['approval', 'auto-review']) {
    ctx.permissionPresets.set(agent.session, tier);
    for (const kind of ['deny', 'cancel', 'ask']) {
      const path = target('other-' + kind);
      const before = approval.requests.length;
      const reviews = adapter.calls;
      approval.answer = 'allowed-once';
      const dispose = ctx.on('tools/pre-execute', async (exec, next) => {
        if (exec.agent !== agent || exec.arguments.file_path !== path) return next();
        return { kind, reason: 'Owned independent policy question.' };
      });
      try {
        const result = await write(ctx, agent, path);
        assert.equal(result.isError, kind !== 'ask');
        if (kind === 'ask') {
          assert.equal(readFileSync(path, 'utf8'), 'exact-owned-bytes\n');
          assert.equal(approval.requests.length, before + 1);
          assert.equal(approval.requests.at(-1).reason, 'Owned independent policy question.');
          assert.equal(adapter.calls, reviews + Number(tier === 'auto-review'));
        } else {
          assert(!existsSync(path));
          assert.equal(approval.requests.length, before);
          assert.equal(adapter.calls, reviews);
        }
      } finally {
        dispose();
      }
    }
  }
  ctx.permissionPresets.set(agent.session, 'approval');
  const path = target('monotonic-guard');
  const before = approval.requests.length;
  const remove = ctx.tools.guard((exec) =>
    exec.agent === agent && exec.arguments.file_path === path
      ? 'Owned final guard veto.'
      : undefined,
  );
  try {
    assert.equal((await write(ctx, agent, path)).isError, true);
    assert(!existsSync(path));
    assert.equal(approval.requests.length, before + 1);
  } finally {
    remove();
  }
}

async function untrustedState(ctx, agent, approval) {
  const before = approval.requests.length;
  ctx.permissionPresets.set(agent.session, 'danger-full-access');
  agent.session.append('permission/preset', { preset: 'unknown-old-selection' });
  assert.equal(ctx.permissionPresets.current(agent.session), 'danger-full-access');
  const unknown = target('unknown');
  assert.equal((await write(ctx, agent, unknown)).isError, true);
  assert(!existsSync(unknown));
  agent.session.append('permission/preset', { preset: 'approval' });
  const mismatch = target('mismatched');
  assert.equal((await write(ctx, agent, mismatch)).isError, true);
  assert(!existsSync(mismatch));
  assert.equal(approval.requests.length, before);
  ctx.permissionPresets.set(agent.session, 'approval');
}

async function ptc(ctx, approval) {
  const handle = await create(ctx, 'ptc');
  const agent = handle.agent;
  ctx.permissionPresets.set(agent.session, 'approval');
  try {
    const outer = target('outer');
    approval.answer = 'rejected';
    const code =
      'const fs = await import("node:fs/promises"); await fs.writeFile(' +
      JSON.stringify(outer) +
      ', "outer-bytes");';
    await execute(ctx, agent, 'run_code', {
      code,
      description: 'Write the owned direct program effect file',
    });
    assert(!existsSync(outer));
    const inner = target('inner');
    const before = approval.requests.length;
    approval.answer = 'allowed-once';
    approval.beforeAnswer = (req) => {
      approval.answer = req.toolName === 'run_code' ? 'allowed-once' : 'rejected';
    };
    await execute(ctx, agent, 'run_code', {
      code: 'await tools.write({file_path:' + JSON.stringify(inner) + ',content:"inner-bytes"});',
      description: 'Write via the owned nested tool call',
    });
    assert(!existsSync(inner));
    assert.deepEqual(
      approval.requests.slice(before).map((req) => req.toolName),
      ['run_code', 'write'],
    );
    assert.notEqual(approval.requests[before].callId, approval.requests[before + 1].callId);
    const innerBash = target('inner-bash');
    const nestedBash =
      'await tools.bash({command:' +
      JSON.stringify('printf inner-command > ' + innerBash) +
      ',description:"Write the nested owned command effect"});';
    const bashBefore = approval.requests.length;
    await execute(ctx, agent, 'run_code', {
      code: nestedBash,
      description: 'Execute the owned nested command call',
    });
    assert(!existsSync(innerBash));
    assert.deepEqual(
      approval.requests.slice(bashBefore).map((req) => req.toolName),
      ['run_code', 'bash'],
    );
    approval.beforeAnswer = undefined;
    approval.answer = 'allowed-once';
    assert.equal(
      (
        await execute(ctx, agent, 'run_code', {
          code,
          description: 'Write the owned direct program effect file',
        })
      ).isError,
      false,
    );
    assert.equal(readFileSync(outer, 'utf8'), 'outer-bytes');
    assert.equal(
      (
        await execute(ctx, agent, 'run_code', {
          code:
            'await tools.write({file_path:' + JSON.stringify(inner) + ',content:"inner-bytes"});',
          description: 'Write via the approved nested tool call',
        })
      ).isError,
      false,
    );
    assert.equal(readFileSync(inner, 'utf8'), 'inner-bytes');
    assert.equal(
      (
        await execute(ctx, agent, 'run_code', {
          code: nestedBash,
          description: 'Execute the approved owned nested command',
        })
      ).isError,
      false,
    );
    assert.equal(readFileSync(innerBash, 'utf8'), 'inner-command');
  } finally {
    await handle.dispose();
  }
}

async function children(ctx, parent, approval) {
  for (const tier of ['approval', 'auto-review']) {
    ctx.permissionPresets.set(parent.session, tier);
    for (const provider of ['spawn', 'fork']) {
      for (const answer of ['rejected', 'allowed-once']) {
        await childEffect(ctx, parent, approval, tier, provider, answer);
      }
    }
  }
}

async function childEffect(ctx, parent, approval, tier, provider, answer) {
  const path = target('child');
  let child;
  const dispose = ctx.on(
    'agent/pre-step',
    async (payload, next) => {
      if (payload.agent.session.header.origin !== 'subagent') return next();
      child = payload.agent;
      assert.equal(state(ctx, child).preset, tier);
      assert.equal(state(ctx, child).approval, 'ask');
      const result = await ctx.tools.execute({
        callId: ToolCallId(randomUUID()),
        name: 'write',
        arguments: { file_path: path, content: 'child-bytes' },
        agent: child,
        signal: payload.signal,
      });
      assert.equal(result.isError, answer === 'rejected');
      return { kind: 'reject' };
    },
    { prepend: true },
  );
  const before = approval.requests.length;
  approval.answer = answer;
  let run;
  try {
    await inTurn(ctx, parent, async (signal) => {
      run = await ctx.subagents.start(provider, {
        parent,
        prompt: [{ type: 'text', text: 'Owned delegated mutation test' }],
        signal,
        agentOptions: { provider: 'missing-permission-test', model: 'none' },
      });
      await run.result;
    });
    assert(child);
    if (answer === 'rejected') assert(!existsSync(path));
    else assert.equal(readFileSync(path, 'utf8'), 'child-bytes');
    assert.equal(approval.requests.length, before + 1);
    assert.equal(approval.requests.at(-1).agent, child);
    const asked = approval.audit.filter(
      (event) => event.sessionId === child.session.id && event.type === 'approval/asked',
    );
    assert.equal(asked.length, 1);
    assert.equal(asked[0].data.callId, approval.requests.at(-1).callId);
    const decided = approval.audit.filter(
      (event) => event.type === 'approval/decided' && event.data.id === asked[0].data.id,
    );
    assert.equal(decided.length, 1);
    assert.equal(decided[0].sessionId, child.session.id);
    assert.equal(decided[0].data.outcome, answer);
    assert(
      !approval.audit.some(
        (event) =>
          event.sessionId === parent.session.id &&
          event.type === 'approval/asked' &&
          event.data.callId === asked[0].data.callId,
      ),
    );
    const id = child.session.id;
    ctx.permissionPresets.set(child.session, 'danger-full-access');
    await run.dispose();
    const restored = await ctx.agents.resume({
      resumeSessionId: SessionId(id),
      parentAgent: parent,
      agentOptions: { provider: 'permission-protocol', model: 'owned' },
      setup: async (agentCtx) => {
        await ctx.agentPresets.mount(agentCtx, 'standard');
      },
    });
    try {
      assert.equal(state(ctx, restored.agent).preset, 'danger-full-access');
    } finally {
      await restored.dispose();
    }
  } finally {
    dispose();
    if (run) await run.dispose();
  }
}

async function protocols(ctx, agent, adapter, approval) {
  ctx.permissionPresets.set(agent.session, 'auto-review');
  adapter.mode = 'allow';
  let path = target('auto');
  const initial = approval.requests.length;
  assert.equal((await write(ctx, agent, path)).isError, false);
  assert.equal(readFileSync(path, 'utf8'), 'exact-owned-bytes\n');
  assert.equal(approval.requests.length, initial);
  for (const mode of [
    'deny',
    'throw',
    'error',
    'aborted',
    'max-tokens',
    'no-finish',
    'trailing',
    'duplicate',
    'extra',
    'invalid',
    'oversize',
  ]) {
    adapter.mode = mode;
    path = target(mode);
    const before = approval.requests.length;
    approval.answer = 'rejected';
    assert.equal((await write(ctx, agent, path)).isError, true);
    assert(!existsSync(path));
    assert.equal(approval.requests.length, before + 1);
    assert.equal(
      approval.requests.at(-1).reason,
      'Auto review did not authorize this call. Human approval is required.',
    );
  }
  adapter.mode = 'error';
  approval.answer = 'allowed-once';
  path = target('fallback-grant');
  assert.equal((await write(ctx, agent, path)).isError, false);
  assert.equal(readFileSync(path, 'utf8'), 'exact-owned-bytes\n');
}

async function staleAndCancel(ctx, agent, adapter, approval) {
  const path = target('stale');
  ctx.permissionPresets.set(agent.session, 'approval');
  approval.answer = 'hold';
  approval.entered = Promise.withResolvers();
  const pending = write(ctx, agent, path);
  await approval.entered.promise;
  ctx.permissionPresets.set(agent.session, 'auto-review');
  ctx.permissionPresets.set(agent.session, 'approval');
  approval.release.resolve('allowed-once');
  assert.equal((await pending).isError, true);
  assert(!existsSync(path));
  ctx.permissionPresets.set(agent.session, 'auto-review');
  adapter.mode = 'wait';
  adapter.entered = Promise.withResolvers();
  const autoPath = target('auto-stale');
  const auto = write(ctx, agent, autoPath);
  await adapter.entered.promise;
  ctx.permissionPresets.set(agent.session, 'approval');
  ctx.permissionPresets.set(agent.session, 'auto-review');
  adapter.release.resolve();
  assert.equal((await auto).isError, true);
  assert(!existsSync(autoPath));
  adapter.entered = Promise.withResolvers();
  const cancelled = target('cancelled');
  const before = approval.requests.length;
  const cancel = write(ctx, agent, cancelled);
  await adapter.entered.promise;
  agent.cancel({ kind: 'user' });
  assert.equal((await cancel).isError, true);
  assert(!existsSync(cancelled));
  assert.equal(approval.requests.length, before);
  adapter.mode = 'allow';
  approval.answer = 'allowed-once';
}

async function unload(ctx, adapter, approval) {
  const handle = await create(ctx);
  const agent = handle.agent;
  const path = target('unload');
  const entered = Promise.withResolvers();
  let dispose;
  if (INDEX === 0) {
    ctx.permissionPresets.set(agent.session, 'approval');
    approval.answer = 'hold';
    approval.entered = entered;
  } else if (INDEX === 1) {
    ctx.permissionPresets.set(agent.session, 'auto-review');
    adapter.mode = 'wait';
    adapter.entered = entered;
  } else {
    ctx.permissionPresets.set(agent.session, 'danger-full-access');
    dispose = ctx.on(
      'tools/pre-execute',
      async (exec, next) => {
        const result = await next();
        if (exec.agent !== agent) return result;
        const stopped = Promise.withResolvers();
        exec.signal.addEventListener('abort', () => stopped.resolve(), { once: true });
        entered.resolve();
        await stopped.promise;
        return result;
      },
      { prepend: true },
    );
  }
  const permissionEvents = [];
  const observe = ctx.on('session/event', (session, event) => {
    if (session === agent.session && event.type === 'permission/preset')
      permissionEvents.push(event.data.preset);
  });
  const pending = write(ctx, agent, path);
  await entered.promise;
  const entry = [...ctx.loader.entries()].find((row) => row.options.id === 'managed-permissions');
  assert(entry?.fiber);
  await entry.fiber.dispose();
  assert.equal((await pending).isError, true);
  assert(!existsSync(path));
  assert.deepEqual(permissionEvents, []);
  observe();
  assert.equal(ctx.get('managedPermissions'), undefined);
  if (dispose) dispose();
  await handle.dispose();
}

export function apply(ctx) {
  const adapter = new ProtocolAdapter();
  ctx.llm.registerAdapter(['permission-protocol'], adapter);
  const approval = approvals(ctx);
  const server = createServer(async (req, res) => {
    if (
      req.method !== 'POST' ||
      req.url !== '/run' ||
      req.headers.authorization !== 'Bearer ' + process.env.DSH_TEAM_PERMISSION_NONCE
    ) {
      res.writeHead(404);
      res.end();
      return;
    }
    let handle;
    try {
      assert.equal(ctx.permissionPresets.catalog().defaultPreset, EXPECTED[INDEX]);
      handle = await create(ctx);
      assert.equal(state(ctx, handle.agent).preset, EXPECTED[INDEX]);
      assert.equal(state(ctx, handle.agent).sandbox, 'danger-full-access');
      if (INDEX === 0) {
        const before = approval.requests.length;
        const calls = adapter.calls;
        const path = target('yolo');
        assert.equal((await write(ctx, handle.agent, path)).isError, false);
        assert.equal(readFileSync(path, 'utf8'), 'exact-owned-bytes\n');
        assert.equal(approval.requests.length, before);
        assert.equal(adapter.calls, calls);
        await manual(ctx, handle.agent, approval);
        await guardContracts(ctx, handle.agent, adapter, approval);
        await untrustedState(ctx, handle.agent, approval);
        await ptc(ctx, approval);
        await children(ctx, handle.agent, approval);
        await staleAndCancel(ctx, handle.agent, adapter, approval);
        await persistence(ctx, handle, approval);
      } else if (INDEX === 1) {
        await manual(ctx, handle.agent, approval);
        await persistence(ctx, handle, approval);
      } else {
        await protocols(ctx, handle.agent, adapter, approval);
        await persistence(ctx, handle, approval);
      }
      await unload(ctx, adapter, approval);
      await handle.dispose();
      handle = undefined;
      res.writeHead(200);
      res.end(JSON.stringify({ passed: true, defaultPreset: EXPECTED[INDEX] }));
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    } finally {
      if (handle) {
        handle.agent.cancel({ kind: 'user' });
        await handle.dispose();
      }
    }
  });
  ctx.effect(() => {
    server.listen(3081, '127.0.0.1');
    return () => server.close();
  });
  server.once('listening', () => process.stdout.write('DSH_TEAM_PERMISSION_READY\n'));
  mkdirSync(ROOT, { recursive: true });
}
