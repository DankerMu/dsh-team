/* Owned deterministic protocol for native plugin/lifecycle checks, not real-model acceptance. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const require = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json');
const load = (name) => import(pathToFileURL(require.resolve(name)).href);
const { LlmAdapter, createUserMessage, ToolCallId } = await load('@deepseek-ai/dsh-llm');
const { SessionId } = await load('@deepseek-ai/dsh-session');
export const name = 'office-delegation-fixture';
export const inject = [
  'agents',
  'llm',
  'subagents',
  'agentPresets',
  'sessionProjections',
  'permissionPresets',
  'managedPermissions',
  'sessionController',
  'loader',
];
const INDEX = Number(process.env.DSH_TEAM_PERMISSION_INDEX);
const TIERS = ['danger-full-access', 'approval', 'auto-review'];
const PREFIX = 'office-native:';
const presetOf = (ctx, agent) => ctx.agentPresets.composedPreset(agent.ctx);
const stateOf = (ctx, agent) => ctx.sessionProjections.stateOf(agent.session, 'permissions');
const eventsOf = (agent) => agent.session.snapshotEvents();
const selectionCount = (agent) =>
  eventsOf(agent).filter((event) => event.type === 'agent-preset/selected').length;

function* chunks(block) {
  yield { type: 'block-start', index: 0, blockType: block.type };
  if (block.type === 'text') yield { type: 'text-delta', index: 0, text: block.text };
  else
    yield {
      type: 'tool-call-delta',
      index: 0,
      id: block.id,
      name: block.name,
      argumentsDelta: block.arguments,
    };
  yield { type: 'block-end', index: 0, block };
  yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } };
}

async function waitReleased(directive, signal) {
  const abort = () => directive.release.resolve();
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) abort();
    await directive.release.promise;
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function protocol(ctx) {
  const pending = new Map();
  const observations = new Map();
  const issued = new Set();
  const control = {
    answer: 'allowed-once',
    review: 'allow',
    reviewCalls: 0,
    requests: [],
    audit: [],
  };
  class OwnedAdapter extends LlmAdapter {
    providerInfo(provider) {
      return { id: provider, name: 'Owned office protocol' };
    }
    async listModels(provider) {
      return [{ provider, id: 'owned', name: 'Owned office protocol' }];
    }
    async resolveModel(provider, model) {
      assert.equal(provider, 'office-protocol');
      assert.equal(model, 'owned');
      return {
        provider,
        id: model,
        name: 'Owned office protocol',
        context: { contextWindow: 500000 },
        inputModalities: ['text'],
      };
    }
    async *stream(options) {
      if (options.system !== undefined) {
        control.reviewCalls++;
        yield* chunks({ type: 'text', text: JSON.stringify({ decision: control.review }) });
        return;
      }
      const token = [...options.messages]
        .reverse()
        .flatMap((message) => (message.role === 'user' ? message.content : []))
        .find((part) => part.type === 'text' && pending.has(part.text))?.text;
      const directive = pending.get(token);
      assert(directive, 'only fixture-owned native tasks may reach the adapter');
      const system = [...options.messages].reverse().find((message) => message.role === 'system');
      assert(system, 'native loop includes its actual system prompt');
      const writer = [...ctx.loader.entries()].find(
        (row) => row.options.id === 'preset-office-writer',
      );
      const instruction = writer.options.config.plugins.find((row) => row.id === 'persona').config
        .prefix;
      assert.equal(typeof instruction, 'string');
      assert(instruction.trim(), 'actual writer instruction must be present');
      observations.set(options.sessionId, {
        writerInstruction: system.content.some(
          (part) => part.type === 'text' && part.text.includes(instruction),
        ),
        tools: options.tools.map((tool) => tool.name),
        provider: options.provider,
        model: options.model,
      });
      directive.entered.resolve();
      if (directive.mode === 'hold') await waitReleased(directive, options.signal);
      if (directive.mode === 'write' && !issued.has(options.sessionId)) {
        issued.add(options.sessionId);
        yield* chunks({
          type: 'tool-call',
          id: ToolCallId(randomUUID()),
          name: 'write',
          arguments: JSON.stringify({ file_path: directive.path, content: directive.content }),
        });
      } else yield* chunks({ type: 'text', text: 'Owned native turn settled.' });
    }
  }
  ctx.llm.registerAdapter(['office-protocol'], new OwnedAdapter());
  ctx.on('session/event', (session, event) => {
    if (event.type === 'approval/asked' || event.type === 'approval/decided')
      control.audit.push({ sessionId: session.id, ...event });
  });
  ctx.on(
    'approval/request',
    async (request, next) => {
      if (!request.agent.session.header.parentSession?.startsWith('office-native-')) return next();
      control.requests.push(request);
      return control.answer;
    },
    { prepend: true },
  );
  function task(mode = 'complete') {
    const token = PREFIX + randomUUID();
    const directive = {
      mode,
      path: '/data/work/office-effect-' + randomUUID(),
      content: 'Owned office effect\n',
      entered: Promise.withResolvers(),
      release: Promise.withResolvers(),
    };
    pending.set(token, directive);
    return { ...directive, prompt: [{ type: 'text', text: token }] };
  }
  return { control, observations, task };
}

async function create(ctx, preset = 'office-general') {
  return ctx.agents.create({
    sessionId: SessionId('office-native-' + randomUUID()),
    meta: { cwd: '/data/work', agentPreset: preset },
    agentOptions: { provider: 'office-protocol', model: 'owned' },
    setup: async (agentCtx) => {
      await ctx.agentPresets.mount(agentCtx, preset);
    },
  });
}

async function inTurn(agent, operation) {
  const completion = Promise.withResolvers();
  let entered = false;
  const stop = agent.ctx.on(
    'agent/pre-step',
    async (payload, next) => {
      if (payload.agent !== agent) return next();
      if (!entered) {
        entered = true;
        try {
          completion.resolve(await operation(payload.signal));
        } catch (error) {
          completion.reject(error);
        }
      }
      return { kind: 'reject' };
    },
    { prepend: true },
  );
  try {
    agent.followup(
      createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Owned parent turn' }],
      }),
    );
    const value = await completion.promise;
    await agent.whenIdle();
    return value;
  } finally {
    stop();
  }
}

function assertChild(ctx, agent, parent, expected, observations, selected = true) {
  assert.equal(agent.session.header.origin, 'subagent');
  assert.equal(agent.session.header.parentSession, parent.id);
  assert.equal(agent.session.header.cwd, '/data/work');
  assert.equal(presetOf(ctx, agent), expected);
  assert.equal(ctx.sessionProjections.stateOf(agent.session, 'agentPreset'), expected);
  assert.equal(stateOf(ctx, agent).preset, stateOf(ctx, parent).preset);
  const native = observations.get(agent.id);
  assert(native, 'actual native model request must be observed');
  assert.equal(native.provider, 'office-protocol');
  assert.equal(native.model, 'owned');
  assert.equal(native.writerInstruction, expected === 'office-writer');
  if (expected === 'office-writer') {
    assert(native.tools.includes('write'));
    assert(!native.tools.includes('subagent'));
  }
  const own = eventsOf(agent).slice(agent.session.inheritedEventCount);
  const selections = own.filter((event) => event.type === 'agent-preset/selected');
  assert.equal(selections.length, selected ? 1 : 0);
  if (selected) {
    assert.equal(selections[0].data.agentPreset, 'office-writer');
    assert(selections[0].seq < own.find((event) => event.type === 'turn/start').seq);
    assert.equal(agent.session.header.agentPreset, 'office-general');
  }
  return {
    childId: agent.id,
    parentId: parent.id,
    preset: expected,
    permissions: stateOf(ctx, agent).preset,
    selectedSeq: selections[0]?.seq ?? null,
    tools: native.tools,
    writerInstruction: native.writerInstruction,
  };
}

async function coldRead(ctx, parent, childId) {
  assert.equal(ctx.agents.get(childId), undefined);
  const signal = new AbortController().signal;
  const address = {
    kind: 'subagent',
    parentSessionId: parent.id,
    childSessionId: childId,
    mode: 'one-shot',
  };
  const projection = await ctx.sessionController.projections({ sessionId: childId }, signal);
  assert.equal(projection.values.agentPreset, 'office-writer');
  const history = await ctx.sessionController.page(
    { address, throughSeq: projection.asOfSeq, maxMessages: 500 },
    signal,
  );
  assert.equal(history.hasMore, false);
  assert(
    history.records.some(
      (row) =>
        row.event.type === 'agent-preset/selected' &&
        row.event.data.agentPreset === 'office-writer',
    ),
  );
  await assert.rejects(
    ctx.sessionController.page(
      {
        address: { ...address, parentSessionId: 'unrelated-parent' },
        throughSeq: projection.asOfSeq,
        maxMessages: 500,
      },
      signal,
    ),
  );
  assert.equal(ctx.agents.get(childId), undefined, 'cold read must not reactivate the Agent');
  return projection.values.agentPreset;
}

async function successfulChild(ctx, parent, fixture, report) {
  let run;
  try {
    await inTurn(parent, async (signal) => {
      run = await ctx.subagents.start('spawn', { parent, prompt: fixture.task().prompt, signal });
      assert.equal((await run.result).stopReason, 'completed');
    });
    report.writer = assertChild(ctx, run.localAgent, parent, 'office-writer', fixture.observations);
    await assert.rejects(ctx.agentPresets.select(run.localAgent, 'office-general'));
    assert.equal(presetOf(ctx, run.localAgent), 'office-writer');
    assert.equal(selectionCount(run.localAgent), 1, 'late selection cannot forge preset history');
    const childId = run.id;
    await run.dispose();
    report.coldPreset = await coldRead(ctx, parent, childId);
    const restored = await ctx.agents.resume({
      resumeSessionId: SessionId(childId),
      parentAgent: parent,
      agentOptions: { provider: 'office-protocol', model: 'owned' },
      setup: async (agentCtx) => {
        await ctx.agentPresets.mount(agentCtx, report.coldPreset);
      },
    });
    try {
      assert.equal(presetOf(ctx, restored.agent), 'office-writer');
      assert.equal(selectionCount(restored.agent), 1);
      assert.equal(stateOf(ctx, restored.agent).preset, stateOf(ctx, parent).preset);
      report.resumePreset = presetOf(ctx, restored.agent);
    } finally {
      await restored.dispose();
    }
  } finally {
    if (run) await run.dispose();
  }
}

async function pendingChildIdentity(ctx, parent, fixture, report) {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const stop = ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.header.parentSession !== parent.id) return;
    entered.resolve(agent.id);
    await release.promise;
  });
  try {
    await inTurn(parent, async (signal) => {
      const starting = ctx.subagents.start('spawn', {
        parent,
        prompt: fixture.task().prompt,
        signal,
      });
      try {
        const childId = await entered.promise;
        const listed = await ctx.sessionController.list({}, signal);
        const row = listed.items.find((item) => item.sessionId === childId);
        assert(row);
        const pending = await ctx.sessionController.projections({ sessionId: childId }, signal);
        assert.equal(row.agentAvailable, true);
        assert.equal(pending.values.subagent, null);
        const address = {
          kind: 'subagent',
          parentSessionId: parent.id,
          childSessionId: childId,
          mode: 'one-shot',
        };
        await assert.rejects(
          ctx.sessionController.page(
            { address, throughSeq: pending.asOfSeq, maxMessages: 500 },
            signal,
          ),
        );
        release.resolve();
        const run = await starting;
        assert.equal((await run.result).stopReason, 'completed');
        const ready = await ctx.sessionController.projections({ sessionId: childId }, signal);
        const history = await ctx.sessionController.page(
          { address, throughSeq: ready.asOfSeq, maxMessages: 500 },
          signal,
        );
        assert(history.records.some(({ event }) => event.type === 'turn/end'));
        await assert.rejects(
          ctx.sessionController.page(
            { address: { ...address, parentSessionId: 'wrong-parent' }, throughSeq: ready.asOfSeq },
            signal,
          ),
        );
        await assert.rejects(
          ctx.sessionController.page(
            { address: { ...address, mode: 'continuable' }, throughSeq: ready.asOfSeq },
            signal,
          ),
        );
        report.readiness = {
          pending: { identity: pending.values.subagent, agentAvailable: row.agentAvailable },
          ready: { identity: ready.values.subagent, agentAvailable: true },
          pendingPageRejected: true,
          wrongParentRejected: true,
          wrongModeRejected: true,
        };
      } finally {
        release.resolve();
        await (await starting).dispose();
      }
    });
  } finally {
    release.resolve();
    stop();
  }
}

async function siblingIsolation(ctx, parent, fixture, report) {
  const manual = await create(ctx, 'office-writer');
  const held = fixture.task('hold');
  const runs = [];
  try {
    assert.equal(selectionCount(manual.agent), 0);
    await inTurn(parent, async (signal) => {
      const first = await ctx.subagents.start('spawn', { parent, prompt: held.prompt, signal });
      runs.push(first);
      await held.entered.promise;
      const second = await ctx.subagents.start('spawn', {
        parent,
        prompt: fixture.task().prompt,
        signal,
      });
      runs.push(second);
      assert.equal((await second.result).stopReason, 'completed');
      assert.notEqual(first.id, second.id);
      for (const run of runs)
        assertChild(ctx, run.localAgent, parent, 'office-writer', fixture.observations);
      assert.equal(presetOf(ctx, parent), 'office-general');
      assert.equal(presetOf(ctx, manual.agent), 'office-writer');
      held.release.resolve();
      assert.equal((await first.result).stopReason, 'completed');
    });
    report.siblings = runs.map((run) => run.id);
  } finally {
    held.release.resolve();
    await Promise.all(runs.map((run) => run.dispose()));
    await manual.dispose();
  }
}

async function exclusions(ctx, parent, fixture, report) {
  const standard = await create(ctx, 'standard');
  const writer = await create(ctx, 'office-writer');
  report.exclusions = [];
  try {
    for (const [owner, provider, expected] of [
      [standard.agent, 'spawn', 'standard'],
      [writer.agent, 'spawn', 'office-writer'],
      [parent, 'fork', 'office-general'],
    ]) {
      let run;
      try {
        await inTurn(owner, async (signal) => {
          run = await ctx.subagents.start(provider, {
            parent: owner,
            prompt: fixture.task().prompt,
            signal,
          });
          assert.equal((await run.result).stopReason, 'completed');
        });
        assertChild(ctx, run.localAgent, owner, expected, fixture.observations, false);
        report.exclusions.push({
          provider,
          preset: presetOf(ctx, run.localAgent),
          seeded: run.localAgent.session.header.isSeeded,
        });
      } finally {
        if (run) await run.dispose();
      }
    }
    const held = fixture.task('hold');
    let childId;
    try {
      await inTurn(parent, async (signal) => {
        const started = await ctx.subagents.startContinuable({
          provider: 'spawn',
          label: 'Owned continuation exclusion',
          request: { parent, prompt: held.prompt },
          signal,
        });
        childId = started.childId;
        await held.entered.promise;
        const child = ctx.agents.get(childId);
        assertChild(ctx, child, parent, 'office-general', fixture.observations, false);
        report.exclusions.push({
          provider: 'continuable',
          preset: presetOf(ctx, child),
          seeded: child.session.header.isSeeded,
        });
        held.release.resolve();
        await child.whenIdle();
        await ctx.subagents.drainContinuableChildren(parent, [childId]);
      });
    } finally {
      held.release.resolve();
      if (childId) await ctx.subagents.drainContinuableChildren(parent, [childId]);
    }
  } finally {
    await standard.dispose();
    await writer.dispose();
  }
}

async function mutation(ctx, parent, fixture, answer, review, expected, report) {
  const task = fixture.task('write');
  fixture.control.answer = answer;
  fixture.control.review = review;
  const before = fixture.control.requests.length;
  const beforeReview = fixture.control.reviewCalls;
  let run;
  try {
    await inTurn(parent, async (signal) => {
      run = await ctx.subagents.start('spawn', { parent, prompt: task.prompt, signal });
      assert.equal((await run.result).stopReason, 'completed');
    });
    assertChild(ctx, run.localAgent, parent, 'office-writer', fixture.observations);
    assert.equal(existsSync(task.path), expected);
    if (expected) assert.equal(readFileSync(task.path, 'utf8'), task.content);
    const events = eventsOf(run.localAgent);
    const call = events.find((event) => event.type === 'tool/call' && event.data.name === 'write');
    assert(call, 'actual model-issued native write must execute');
    const result = events.find(
      (event) => event.type === 'tool/result' && event.data.message.toolCallId === call.data.callId,
    );
    assert.equal(result.data.message.isError === true, !expected);
    const ask =
      TIERS[INDEX] === 'approval' || (TIERS[INDEX] === 'auto-review' && review !== 'allow');
    assert.equal(fixture.control.requests.length - before, ask ? 1 : 0);
    assert.equal(
      fixture.control.reviewCalls - beforeReview,
      TIERS[INDEX] === 'auto-review' ? 1 : 0,
    );
    if (ask) {
      assert.equal(fixture.control.requests.at(-1).agent, run.localAgent);
      const audit = fixture.control.audit.filter((row) => row.sessionId === run.id);
      assert.equal(audit.filter((row) => row.type === 'approval/asked').length, 1);
      assert.equal(audit.find((row) => row.type === 'approval/decided').data.outcome, answer);
    }
    report.mutations.push({
      childId: run.id,
      answer,
      review,
      fileExists: existsSync(task.path),
      asked: ask,
      toolError: result.data.message.isError === true,
    });
  } finally {
    if (run) await run.dispose();
  }
}

async function cancellation(ctx, parent, fixture, report) {
  const before = ctx.agents
    .list()
    .map((agent) => agent.id)
    .sort();
  await inTurn(parent, async () => {
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
      ctx.subagents.start('spawn', {
        parent,
        prompt: fixture.task().prompt,
        signal: aborted.signal,
      }),
    );
  });
  assert.deepEqual(
    ctx.agents
      .list()
      .map((agent) => agent.id)
      .sort(),
    before,
  );
  const held = fixture.task('hold');
  let run;
  try {
    await inTurn(parent, async (signal) => {
      run = await ctx.subagents.start('spawn', { parent, prompt: held.prompt, signal });
      await held.entered.promise;
      assertChild(ctx, run.localAgent, parent, 'office-writer', fixture.observations);
      await run.dispose();
      assert.equal((await run.result).stopReason, 'aborted');
    });
    assert.equal(ctx.agents.get(run.id), undefined);
    assert.deepEqual(
      ctx.agents
        .list()
        .map((agent) => agent.id)
        .sort(),
      before,
    );
    report.cancelledChild = run.id;
  } finally {
    held.release.resolve();
    if (run) await run.dispose();
  }
}

async function unavailableWriter(ctx, parent, fixture, report) {
  const entry = [...ctx.loader.entries()].find((row) => row.options.id === 'preset-office-writer');
  assert(entry?.fiber);
  await entry.fiber.dispose();
  const before = ctx.agents
    .list()
    .map((agent) => agent.id)
    .sort();
  const requests = fixture.observations.size;
  async function rejectStart() {
    await inTurn(parent, async (signal) => {
      await assert.rejects(
        ctx.subagents.start('spawn', { parent, prompt: fixture.task().prompt, signal }),
      );
    });
    assert.deepEqual(
      ctx.agents
        .list()
        .map((agent) => agent.id)
        .sort(),
      before,
    );
    assert.equal(
      fixture.observations.size,
      requests,
      'failed preset must not reach any model work',
    );
    assert.equal(presetOf(ctx, parent), 'office-general');
  }
  await rejectStart();
  const dispose = await ctx.agentPresets.register({
    id: 'office-writer',
    name: 'Broken owned writer',
    plugins: [{ id: 'unavailable', name: '/data/home/office-native-unavailable-module.mjs' }],
  });
  try {
    const definition = await ctx.agentPresets.resolve('office-writer');
    assert(definition.broken, 'negative target must really fail activation');
    await rejectStart();
    report.unavailable = ['missing', 'broken'];
  } finally {
    await dispose();
  }
}

async function scenario(ctx, fixture) {
  const report = { tier: TIERS[INDEX], mutations: [] };
  const parent = await create(ctx);
  try {
    assert.equal(selectionCount(parent.agent), 0);
    assert.equal(stateOf(ctx, parent.agent).preset, report.tier);
    await successfulChild(ctx, parent.agent, fixture, report);
    await siblingIsolation(ctx, parent.agent, fixture, report);
    await exclusions(ctx, parent.agent, fixture, report);
    if (report.tier === 'danger-full-access')
      await mutation(ctx, parent.agent, fixture, 'rejected', 'deny', true, report);
    else {
      for (const answer of ['rejected', 'allowed-once', 'cancelled'])
        await mutation(
          ctx,
          parent.agent,
          fixture,
          answer,
          'deny',
          answer === 'allowed-once',
          report,
        );
      if (report.tier === 'auto-review')
        await mutation(ctx, parent.agent, fixture, 'rejected', 'allow', true, report);
    }
    await cancellation(ctx, parent.agent, fixture, report);
    await pendingChildIdentity(ctx, parent.agent, fixture, report);
    await unavailableWriter(ctx, parent.agent, fixture, report);
    assert.equal(presetOf(ctx, parent.agent), 'office-general');
  } finally {
    await parent.dispose();
  }
  assert.equal(
    ctx.agents.list().filter((agent) => agent.session.header.cwd === '/data/work').length,
    0,
  );
  return report;
}

export function apply(ctx) {
  const fixture = protocol(ctx);
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
    try {
      const report = await scenario(ctx, fixture);
      writeFileSync(`/data/home/office-delegation-evidence-${INDEX}.json`, JSON.stringify(report));
      res.writeHead(200);
      res.end(JSON.stringify({ passed: true, defaultPreset: TIERS[INDEX] }));
    } catch (error) {
      writeFileSync(
        `/data/home/office-delegation-failure-${INDEX}.json`,
        JSON.stringify({
          name: error.name,
          message: error.message,
          stack: error.stack?.slice(0, 4000),
        }),
      );
      res.writeHead(500);
      res.end(String(error));
    }
  });
  ctx.effect(() => {
    server.listen(3081, '127.0.0.1');
    return () => server.close();
  });
  server.once('listening', () => process.stdout.write('DSH_TEAM_PERMISSION_READY\n'));
}
