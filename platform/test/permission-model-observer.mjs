import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

// Fixture-only: resolved against the immutable installed release, never a substitute adapter.
const require = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json');
const { isAgentLoopRequest } = await import(
  pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href
);
const CONTROL = '/data/home/permission-model-control.json';
const EVIDENCE = '/data/home/permission-model-observation.json';
export const name = 'dsh-team-auto-review-observer';
export const inject = ['llm', 'tools', 'agents'];

function trackedReview(options, active, diagnose) {
  // Main Agent requests are never intercepted, including continuation after rejection.
  if (isAgentLoopRequest(options)) {
    diagnose('agent-loop');
    return undefined;
  }
  diagnose('non-agent');
  let action;
  try {
    action = JSON.parse(options.messages?.[0]?.content?.[0]?.text);
    diagnose('parsed');
  } catch {
    diagnose('unparsed');
    return undefined;
  }
  const tracked = active.get(action?.arguments?.file_path);
  diagnose(tracked ? 'active-match' : 'inactive');
  if (!tracked) return undefined;
  if (
    action.name !== tracked.exec.name ||
    action.cwd !== tracked.exec.agent.session.header.cwd ||
    JSON.stringify(action.arguments) !== JSON.stringify(tracked.exec.arguments)
  )
    throw new Error('Owned review action mismatch');
  return tracked;
}

function observedDecision(text, finishes) {
  if (finishes !== 1) return 'other';
  try {
    const value = JSON.parse(text);
    return value && Object.keys(value).length === 1 && value.decision === 'allow'
      ? 'allow'
      : 'other';
  } catch {
    // Classification only; native gate and original stream remain authoritative.
    return 'other';
  }
}

export function apply(ctx) {
  const active = new Map();
  let sequence = 0;
  let state = { nonce: null, overflow: false, reviews: [], 'DEBUG-85-review': [] };
  const persist = () => {
    writeFileSync(EVIDENCE + '.pending', JSON.stringify(state), { mode: 0o600 });
    renameSync(EVIDENCE + '.pending', EVIDENCE);
  };
  const diagnose = (kind) => {
    if (state.nonce === null || state['DEBUG-85-review'].length >= 32) return;
    state['DEBUG-85-review'].push(kind);
    persist();
  };
  persist();
  ctx.on(
    'tools/pre-execute',
    async (exec, next) => {
      if (exec.name !== 'write') return next();
      const control = JSON.parse(readFileSync(CONTROL, 'utf8'));
      if (exec.arguments.file_path !== control.path || exec.agent?.session.id !== control.sessionId)
        return next();
      if (ctx.agents.get(control.sessionId) !== exec.agent)
        throw new Error('Owned review Agent mismatch');
      if (control.mode !== 'observe' && control.mode !== 'unavailable')
        throw new Error('Owned review mode invalid');
      if (state.nonce !== control.nonce)
        state = { nonce: control.nonce, overflow: false, reviews: [], 'DEBUG-85-review': [] };
      const tracked = { exec, control, rows: [] };
      active.set(control.path, tracked);
      diagnose('pre-execute-entered');
      try {
        const decision = await next();
        diagnose('pre-execute-returned');
        for (const row of tracked.rows) {
          row.gate = ['allow', 'ask', 'deny', 'cancel'].includes(decision.kind)
            ? decision.kind
            : 'unknown';
          row.gated = ++sequence;
        }
        persist();
        return decision;
      } finally {
        active.delete(control.path);
        diagnose('active-released');
      }
    },
    { prepend: true },
  );
  ctx.on(
    'llm/stream',
    async function* (options, next) {
      const tracked = trackedReview(options, active, diagnose);
      if (!tracked) return yield* next();
      if (state.reviews.length >= 8) {
        state.overflow = true;
        persist();
        throw new Error('Owned review observation bound exceeded');
      }
      const row = {
        sessionId: tracked.control.sessionId,
        callId: tracked.exec.callId,
        provider: options.provider,
        model: options.model,
        mode: tracked.control.mode,
        forwarded: false,
        completed: false,
        faultInjected: false,
        finish: null,
        decision: null,
        gate: null,
        started: ++sequence,
        settled: null,
        gated: null,
      };
      state.reviews.push(row);
      tracked.rows.push(row);
      if (tracked.control.mode === 'unavailable') {
        row.faultInjected = true;
        row.settled = ++sequence;
        persist();
        throw new Error('Owned review service unavailable');
      }
      let text = '',
        finishes = 0,
        chunks = 0;
      row.forwarded = true;
      persist();
      try {
        for await (const chunk of next()) {
          // Observation is bounded but forwarding remains byte/object-faithful.
          if (++chunks <= 1024) {
            if (chunk.type === 'text-delta' && text.length < 8192)
              text += chunk.text.slice(0, 8192 - text.length);
            if (chunk.type === 'block-end' && chunk.block?.type === 'text')
              text = chunk.block.text.slice(0, 8192);
            if (chunk.type === 'finish') {
              finishes++;
              row.finish = chunk.reason?.kind === 'stop' ? 'stop' : 'other';
            }
          } else state.overflow = true;
          yield chunk;
        }
        row.completed = true;
        row.decision = observedDecision(text, finishes);
      } finally {
        row.settled = ++sequence;
        persist();
      }
    },
    { prepend: true },
  );
}
