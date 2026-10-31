/* Owned deterministic wire-protocol model, NOT #84/#85 model acceptance.
 * Loaded only by permission-browser-fixture.mjs into its disposable fixture volume.
 * Public rc.2 seam: llm.registerAdapter / LlmAdapter / StreamChunk.
 * No tool replacement, policy hooks, approval answers or synthetic Session events.
 * As the model it also answers the production Auto review request, only for an
 * owned issue391-ui continuable write (allow; recorded as facts.reviews).
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const require = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json');
const load = async (name) => import(pathToFileURL(require.resolve(name)).href);
const { LlmAdapter, ToolCallId, isAgentLoopRequest, createUserMessage } =
  await load('@deepseek-ai/dsh-llm');
export const name = 'issue83-ui-owned-protocol';
export const inject = [
  'llm',
  'agents',
  'sessions',
  'tools',
  'approval',
  'permissionPresets',
  'sessionController',
  'subagents',
  'managedPermissions',
];
// issue83-ui: stage-1 oracle. issue391-ui: continuable children (#391). In DSH 0.2.1 every
// in-process delegation is continuable, so the delegation call carries no mode option.
const PROMPT =
  /^(issue83-ui|issue391-ui) (root|delegate|child) (reject|allow|cancel) ([a-f0-9-]+)$/;
const REVIEW_TARGET = /^\/data\/work\/issue391-ui-child-([a-f0-9-]+)\.txt$/;
const body = 'issue83 browser owned write\n审批必须先于真实工具写入。\n';
function snapshot(path) {
  try {
    const bytes = readFileSync(path);
    return { exists: true, base64: bytes.toString('base64'), bytes: bytes.length };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, bytes: 0, base64: null };
    throw error;
  }
}
function latestEvent(session, type) {
  for (let seq = session.seq - 1; seq >= 0; seq--) {
    const event = session.eventAt(seq);
    if (event?.type === type) return event;
  }
  return undefined;
}
// Production Auto review request (plugins/permission-tiers/review.js): no
// Session, reviewer policy, JSON action naming one owned continuable write.
function reviewNonce(options) {
  if (
    typeof options.system !== 'string' ||
    !options.system.includes('authorization reviewer') ||
    isAgentLoopRequest(options)
  )
    return undefined;
  try {
    const action = JSON.parse(options.messages?.[0]?.content?.[0]?.text ?? '');
    return REVIEW_TARGET.exec(action?.arguments?.file_path ?? '')?.[1];
  } catch {
    return undefined;
  }
}
function* blockChunks(block) {
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
export async function apply(ctx) {
  const owned = new Set(),
    issued = new Set();
  const holds = new Map();
  const facts = {
    source: 'deterministic-owned-LlmAdapter',
    externalModelCalls: 0,
    calls: [],
    streams: [],
    approvals: [],
    audit: [],
    dispatch: [],
    results: [],
    children: [],
    delegations: [],
    holds: [],
    reviews: [],
  };
  class OwnedAdapter extends LlmAdapter {
    providerInfo(provider) {
      return { id: provider, name: 'Owned protocol fixture' };
    }
    async listModels(provider) {
      return [{ provider, id: 'owned', name: 'Owned protocol fixture' }];
    }
    async resolveModel(provider, model) {
      if (provider !== 'issue83-ui-owned' || model !== 'owned')
        throw new Error('Unexpected fixture route');
      return {
        provider,
        id: model,
        name: 'Owned protocol fixture',
        context: { contextWindow: 500000 },
        inputModalities: ['text'],
      };
    }
    async *stream(options) {
      if (options.signal?.aborted) throw new Error('Owned request cancelled');
      if (reviewNonce(options)) {
        yield* blockChunks({ type: 'text', text: '{"decision":"allow"}' });
        return;
      }
      if (!owned.has(options.sessionId)) throw new Error('Unowned Session model request');
      const text = [...options.messages]
        .reverse()
        .filter((m) => m.role === 'user')
        .flatMap((m) => m.content ?? [])
        .find(
          (b) =>
            b.type === 'text' &&
            (/^issue(83|391)-ui /.test(b.text) || b.text.startsWith('issue59-idle hold ')),
        )?.text;
      const idleHold = text?.match(/^issue59-idle hold ([a-f0-9-]+)$/);
      if (idleHold) {
        const nonce = idleHold[1];
        yield* holdIdleTurn(options, nonce, holds, facts);
        return;
      }
      const match = text?.match(PROMPT);
      if (!match) {
        yield* blockChunks({ type: 'text', text: 'Owned protocol fixture idle.' });
        return;
      }
      const [, prefix, scope, action, nonce] = match;
      const title = prefix.slice(0, -'-ui'.length);
      const key = `${options.sessionId}:${nonce}`;
      if (issued.has(key)) {
        yield* blockChunks({ type: 'text', text: 'Owned protocol fixture completed.' });
        return;
      }
      issued.add(key);
      const id = ToolCallId(`${prefix}-${scope}-${nonce}`);
      if (scope === 'delegate') {
        facts.calls.push({
          scope,
          action,
          nonce,
          sessionId: options.sessionId,
          callId: id,
          name: 'subagent',
        });
        yield* blockChunks({
          type: 'tool-call',
          id,
          name: 'subagent',
          arguments: JSON.stringify({
            description: `${title} child ${action} ${nonce}`,
            prompt: `${prefix} child ${action} ${nonce}`,
          }),
        });
      } else {
        const path = `/data/work/${prefix}-${scope}-${nonce}.txt`;
        facts.calls.push({
          scope,
          action,
          nonce,
          sessionId: options.sessionId,
          callId: id,
          name: 'write',
          path,
          initial: snapshot(path),
        });
        yield* blockChunks({
          type: 'tool-call',
          id,
          name: 'write',
          arguments: JSON.stringify({ file_path: path, content: body }),
        });
      }
    }
  }
  ctx.effect(
    () => ctx.llm.registerAdapter(['issue83-ui-owned'], new OwnedAdapter()),
    'owned-ui-protocol adapter',
  );
  registerObservations(ctx, owned, facts);
  await startControlServer(ctx, owned, facts, holds);
  ctx.effect(
    () => () => {
      for (const pending of holds.values()) pending.resolve();
    },
    'owned-idle holds',
  );
}

function registerObservations(ctx, owned, facts) {
  // Observe loop identity at the public waterfall BEFORE adapter projections,
  // which may legitimately clone the request object and its WeakSet identity.
  ctx.on(
    'llm/stream',
    async function* (options, next) {
      if (options.provider !== 'issue83-ui-owned')
        throw new Error('Oracle forbids external model routes');
      const reviewed = reviewNonce(options);
      if (reviewed) {
        facts.reviews.push({ nonce: reviewed });
        yield* next();
        return;
      }
      if (!isAgentLoopRequest(options))
        throw new Error('This oracle forbids auxiliary model calls');
      if (!owned.has(options.sessionId)) throw new Error('Unowned Session model request');
      facts.streams.push({
        sessionId: options.sessionId,
        loopOwned: true,
        provider: options.provider,
        model: options.model,
      });
      yield* next();
    },
    { prepend: true },
  );
  ctx.on('agent/created', ({ agent, source }) => {
    if (owned.has(agent.session.header.parentSession)) {
      owned.add(agent.id);
      // One row per creation/resume; recorded now because a settled child's
      // Session can leave ctx.sessions before a later status read.
      facts.children.push({
        sessionId: agent.id,
        parentSessionId: agent.session.header.parentSession,
        origin: agent.session.header.origin,
        source,
        mode: latestEvent(agent.session, 'subagent/descriptor')?.data.mode ?? null,
        tier: ctx.permissionPresets.current(agent.session),
        policy: ctx.approval.overrideOf(agent.session),
      });
    }
  });
  ctx.on('subagent/start', (info) => {
    if (owned.has(info.id))
      facts.delegations.push({
        sessionId: info.id,
        runId: info.runId,
        provider: info.provider,
        local: info.local,
      });
  });
  // Observation only: delegates every decision unchanged, never answers approval.
  ctx.on(
    'approval/request',
    async (request, next) => {
      if (owned.has(request.agent.id))
        facts.approvals.push({
          sessionId: request.agent.session.id,
          agentId: request.agent.id,
          exactRegisteredAgent: ctx.agents.get(request.agent.id) === request.agent,
          callId: request.callId,
          toolName: request.toolName,
          signalAborted: request.signal?.aborted ?? null,
        });
      return next();
    },
    { prepend: true },
  );
  ctx.on('session/event', (session, event) => {
    if (
      owned.has(session.id) &&
      [
        'approval/asked',
        'approval/decided',
        'turn/start',
        'turn/end',
        'permission/preset',
        'sandbox/mode',
        'approval/policy',
      ].includes(event.type)
    )
      facts.audit.push({
        sessionId: session.id,
        seq: event.seq,
        type: event.type,
        data: event.data,
      });
  });
  ctx.on('tools/execute', async (exec, next) => {
    if (owned.has(exec.agent?.id))
      facts.dispatch.push({
        sessionId: exec.agent.id,
        callId: exec.callId,
        name: exec.name,
        signalAborted: exec.signal.aborted,
      });
    return next();
  });
  ctx.on('tools/result', (exec, result) => {
    if (owned.has(exec.agent?.id))
      facts.results.push({
        sessionId: exec.agent.id,
        callId: exec.callId,
        name: exec.name,
        isError: result.isError,
        signalAborted: exec.signal.aborted,
        ...(exec.name === 'subagent' && result.isError === false
          ? { kind: result.value?.kind, subagentId: result.value?.subagentId }
          : {}),
      });
  });
}

async function* holdIdleTurn(options, nonce, holds, facts) {
  if (holds.has(nonce)) throw new Error('Duplicate owned hold');
  const pending = Promise.withResolvers();
  const observation = {
    nonce,
    sessionId: options.sessionId,
    entered: true,
    completed: false,
    aborted: false,
  };
  facts.holds.push(observation);
  holds.set(nonce, pending);
  const abort = () => pending.resolve();
  options.signal?.addEventListener('abort', abort, { once: true });
  // A broken test cannot leave a real Agent permanently running.
  const timer = setTimeout(abort, 120_000);
  try {
    if (options.signal?.aborted) abort();
    await pending.promise;
    observation.aborted = options.signal?.aborted === true;
    yield* blockChunks({ type: 'text', text: 'Owned idle fixture completed.' });
  } finally {
    observation.completed = true;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    holds.delete(nonce);
  }
}

function idleControl(ctx, owned, holds, request) {
  if (request.op === 'hold') {
    if (
      !owned.has(request.sessionId) ||
      typeof request.nonce !== 'string' ||
      !/^[a-f0-9-]+$/.test(request.nonce)
    )
      throw new Error('Unowned idle hold');
    const agent = ctx.agents.get(request.sessionId);
    if (!agent || agent.status !== 'idle') throw new Error('Owned Agent not idle');
    agent.followup(
      createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: `issue59-idle hold ${request.nonce}` }],
      }),
    );
  } else if (request.op === 'release') {
    const pending = holds.get(request.nonce);
    if (!pending) throw new Error('Owned hold not present');
    pending.resolve();
  } else return false;
  return true;
}

async function startControlServer(ctx, owned, facts, holds) {
  const server = createServer(async (req, res) => {
    const deadline = setTimeout(() => req.destroy(), 10_000);
    try {
      if (req.method !== 'POST' || req.url !== '/control') {
        res.writeHead(404);
        res.end();
        return;
      }
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 4096) throw new Error('Control input limit');
      }
      const request = JSON.parse(raw);
      if (request.op === 'adopt') {
        const agent = ctx.agents.get(request.sessionId);
        if (!agent || agent.session.header.origin || agent.session.header.cwd !== '/data/work')
          throw new Error('Not an owned ordinary workspace Session');
        owned.add(agent.id);
        agent.followup(
          createUserMessage({
            source: { kind: 'user' },
            content: [{ type: 'text', text: 'issue83-ui initialize' }],
          }),
        );
      } else if (request.op !== 'status' && !idleControl(ctx, owned, holds, request))
        throw new Error('Unknown control command');
      const sessions = [...owned].map((sessionId) => {
        const agent = ctx.agents.get(sessionId),
          session = ctx.sessions.get(sessionId);
        const identity = (session && latestEvent(session, 'permission/preset')?.data) ?? null;
        return {
          sessionId,
          status: agent?.status ?? 'disposed',
          tier: session ? ctx.permissionPresets.current(session) : null,
          identity,
          policy: session ? ctx.approval.overrideOf(session) : null,
        };
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ...facts,
          sessions,
          files: facts.calls
            .filter((call) => call.name === 'write')
            .map((call) => ({ callId: call.callId, ...snapshot(call.path) })),
          managedPermissionsPresent: !!ctx.get('managedPermissions'),
          catalog: ctx.permissionPresets.catalog(),
          providers: ctx.subagents.list(),
        }),
      );
    } catch {
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'owned-control-failed' }));
    } finally {
      clearTimeout(deadline);
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(3081, '127.0.0.1', resolve);
  });
  ctx.effect(
    () => () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
    'owned-ui-control server',
  );
}
