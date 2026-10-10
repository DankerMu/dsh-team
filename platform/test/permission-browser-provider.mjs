/* Owned deterministic wire-protocol model, NOT #84/#85 model acceptance.
 * Loaded only by permission-browser-fixture.mjs into its disposable fixture volume.
 * Public rc.2 seam: llm.registerAdapter / LlmAdapter / StreamChunk.
 * No tool replacement, policy hooks, approval answers or synthetic Session events.
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
const PREFIX = 'issue83-ui';
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
      if (!owned.has(options.sessionId)) throw new Error('Unowned Session model request');
      const text = [...options.messages]
        .reverse()
        .filter((m) => m.role === 'user')
        .flatMap((m) => m.content ?? [])
        .find((b) => b.type === 'text' && b.text.startsWith(PREFIX))?.text;
      const match = text?.match(
        /^issue83-ui (root|delegate|child) (reject|allow|cancel) ([a-f0-9-]+)$/,
      );
      if (!match) {
        yield* blockChunks({ type: 'text', text: 'Owned protocol fixture idle.' });
        return;
      }
      const [, scope, action, nonce] = match;
      const key = `${options.sessionId}:${nonce}`;
      if (issued.has(key)) {
        yield* blockChunks({ type: 'text', text: 'Owned protocol fixture completed.' });
        return;
      }
      issued.add(key);
      const id = ToolCallId(`issue83-ui-${scope}-${nonce}`);
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
            description: `issue83 child ${action} ${nonce}`,
            prompt: `issue83-ui child ${action} ${nonce}`,
            run_in_background: false,
          }),
        });
      } else {
        const path = `/data/work/issue83-ui-${scope}-${nonce}.txt`;
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
  await startControlServer(ctx, owned, facts);
}

function registerObservations(ctx, owned, facts) {
  // Observe loop identity at the public waterfall BEFORE adapter projections,
  // which may legitimately clone the request object and its WeakSet identity.
  ctx.on(
    'llm/stream',
    async function* (options, next) {
      if (options.provider !== 'issue83-ui-owned')
        throw new Error('Oracle forbids external model routes');
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
  ctx.on('agent/created', ({ agent }) => {
    if (owned.has(agent.session.header.parentSession)) {
      owned.add(agent.id);
      facts.children.push({
        sessionId: agent.id,
        parentSessionId: agent.session.header.parentSession,
        origin: agent.session.header.origin,
        source: 'real-native-in-process-child',
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
      });
  });
}

async function startControlServer(ctx, owned, facts) {
  const server = createServer(async (req, res) => {
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
      } else if (request.op !== 'status') throw new Error('Unknown control command');
      const sessions = [...owned].map((sessionId) => {
        const agent = ctx.agents.get(sessionId),
          session = ctx.sessions.get(sessionId);
        let identity = null;
        if (session)
          for (let seq = session.seq - 1; seq >= 0; seq--) {
            const event = session.eventAt(seq);
            if (event?.type === 'permission/preset') {
              identity = event.data;
              break;
            }
          }
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
    }
  });
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
