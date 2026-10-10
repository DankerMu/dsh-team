// @ts-check
import { review } from './review.js';

export const name = 'dsh-team-permission-tiers';
// Native ask and child guidance are required lifetime dependencies, not optional fallbacks.
export const inject = [
  'tools',
  'llm',
  'approval',
  'permissionPresets',
  'sessionProjections',
  'agents',
  'systemPrompt',
];
const MUTATIONS = new Set(['write', 'edit', 'bash', 'run_code']);
const IDENTITIES = new Set(['approval', 'auto-review', 'danger-full-access']);
const PERMISSION_EVENTS = new Set(['permission/preset', 'sandbox/mode', 'approval/policy']);
const UNAVAILABLE = 'Managed permissions are unavailable.';
const STALE = 'Managed permission authorization changed; retry the call.';

/** @param {import('./types.js').Context} ctx @param {import('./types.js').Session} session */
function selected(ctx, session) {
  const state = ctx.sessionProjections.stateOf(session, 'permissions');
  if (!state?.preset || !IDENTITIES.has(state.preset)) return undefined;
  const expected = ctx.permissionPresets.resolve(state.preset);
  const approval = state.preset === 'danger-full-access' ? 'never' : 'ask';
  if (
    expected.sandbox !== 'danger-full-access' ||
    expected.approval !== approval ||
    state.sandbox !== 'danger-full-access' ||
    state.approval !== approval
  )
    return undefined;
  return state.preset;
}

/**
 * @param {string} tier
 * @param {boolean} allowed
 * @param {import('./types.js').Decision} downstream
 * @returns {import('./types.js').Decision}
 */
function authorizationDecision(tier, allowed, downstream) {
  if (downstream.kind !== 'allow' || allowed) return downstream;
  const auto = tier === 'auto-review';
  const en = auto
    ? 'Auto review did not authorize this call. Human approval is required.'
    : 'This call requires human approval before writing files or executing code.';
  return {
    kind: 'ask',
    reason: en,
    displayReason: {
      en,
      zh: auto
        ? 'Auto 审查未放行此调用，需要人工批准。'
        : '写文件或执行代码前，需要人工批准此调用。',
    },
  };
}

/** Install only public lifecycle, waterfall and monotonic guard extensions.
 * @param {import('./types.js').Context} ctx
 */
export function apply(ctx) {
  let accepting = true;
  const lifecycle = new AbortController();
  /** @type {Map<import('./types.js').Session, number>} */
  const revisions = new Map();
  /** @type {Map<import('./types.js').Execution, { revision: number; tier: string; agent: import('./types.js').Agent }>} */
  const calls = new Map();
  /** @type {Set<Promise<void>>} */
  const active = new Set();
  /** @param {import('./types.js').Session} session */
  const revision = (session) => revisions.get(session) ?? 0;
  /** @param {AbortSignal} signal */
  const cancelled = (signal) => !accepting || lifecycle.signal.aborted || signal.aborted;
  // Group every registration: Cordis unloads top-level effects concurrently.
  // Yield order below controls the actual sequential reverse teardown.
  ctx.effect(function* () {
    const withdraw = ctx.provide('managedPermissions', Object.freeze({}));
    yield ctx.on('session/event', (session, event) => {
      if (!PERMISSION_EVENTS.has(event.type)) return;
      revisions.set(session, revision(session) + 1);
      // Retain admitted calls until tools/result: the registry guard precedes
      // asynchronous checkpoint/dispatch waits. Abort the ORIGINAL turn signal
      // so the released checkpoint and registry body boundary both see revocation.
      for (const [exec, call] of calls) {
        if (
          call.agent.session === session &&
          !exec.signal.aborted &&
          ctx.agents.get(session.id) === call.agent
        ) {
          call.agent.cancel({ kind: 'user' }, { keepInbox: true });
          break; // One live Agent owns this Session, including nested PTC calls.
        }
      }
    });
    yield ctx.on('agent/created', ({ agent, source }) => {
      if (!accepting) throw new Error(UNAVAILABLE);
      const session = agent.session;
      if (session.header.origin === 'subagent') initializeChild(ctx, agent, source);
    });
    yield ctx.on('agent/disposed', ({ agent }) => revisions.delete(agent.session));
    yield ctx.on('tools/result', (exec) => calls.delete(exec));
    yield ctx.tools.guard((exec) => finalReason(ctx, exec, calls.get(exec), accepting, revision));
    yield ctx.on(
      'tools/pre-execute',
      async (exec, next) => {
        if (!MUTATIONS.has(exec.name)) return next();
        if (cancelled(exec.signal)) return { kind: 'cancel' };
        const agent = exec.agent;
        const tier = agent && selected(ctx, agent.session);
        if (!agent || !tier || ctx.agents.get(agent.session.id) !== agent) {
          return { kind: 'deny', reason: UNAVAILABLE };
        }
        calls.set(exec, { revision: revision(agent.session), tier, agent });
        /** @type {PromiseWithResolvers<void>} */
        const completed = Promise.withResolvers();
        active.add(completed.promise);
        try {
          const downstream = await next();
          if (cancelled(exec.signal)) return { kind: 'cancel' };
          if (downstream.kind === 'deny' || downstream.kind === 'cancel') return downstream;
          const signal = AbortSignal.any([exec.signal, lifecycle.signal]);
          const allowed =
            tier === 'danger-full-access' ||
            (tier === 'auto-review' && (await review(ctx, agent, exec, signal)));
          if (cancelled(signal)) return { kind: 'cancel' };
          const reason = finalReason(ctx, exec, calls.get(exec), accepting, revision);
          if (reason) return { kind: 'deny', reason };
          return authorizationDecision(tier, allowed, downstream);
        } finally {
          active.delete(completed.promise);
          completed.resolve();
        }
      },
      { prepend: true },
    );
    // First drain owned work; then withdraw the service and await required
    // agent-loop teardown with the gate/guard still installed. Only afterward
    // may the remaining yielded pipeline contributions be removed.
    yield withdraw;
    yield async () => {
      accepting = false;
      lifecycle.abort();
      const agents = ctx.agents.list();
      for (const agent of agents) agent.cancel({ kind: 'disposed' });
      await Promise.allSettled([...active, ...agents.map((agent) => agent.whenIdle())]);
      calls.clear();
      revisions.clear();
    };
  });
}

/** @param {import('./types.js').Context} ctx @param {import('./types.js').Agent} agent @param {import('./types.js').SessionStartSource} source */
function initializeChild(ctx, agent, source) {
  const session = agent.session;
  if (source === 'startup') {
    const parentId = session.header.parentSession;
    const parent = parentId && ctx.agents.get(parentId);
    const tier = parent && selected(ctx, parent.session);
    if (!tier) throw new Error(UNAVAILABLE);
    // Explicit durable identity: native pair derivation is not an authorization.
    session.append('permission/preset', { preset: tier });
    session.append('sandbox/mode', { mode: 'danger-full-access' });
    session.append('approval/policy', { policy: tier === 'danger-full-access' ? 'never' : 'ask' });
  }
  if (!selected(ctx, session)) throw new Error(UNAVAILABLE);
  // A duplicate context in the native child's scope would throw. Use the public
  // assembly waterfall to remove only the inaccurate native contribution.
  agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next();
    return {
      ...assembly,
      contexts: assembly.contexts.filter((context) => context.name !== 'subagent:delegation'),
    };
  });
  agent.ctx.systemPrompt.context({
    name: 'managed-permissions:delegation',
    order: agent.ctx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
    text: 'You are a delegated subagent with an independent durable permission selection. Managed approval asks the human in YOUR session before mutations. Auto reviews each mutation and asks the human in YOUR session when review does not authorize it. Yolo adds no question. Do not bypass a rejection or alter permission policy. Native approval-required operations are not automatically rejected under managed approval or Auto.',
  });
}

/**
 * @param {import('./types.js').Context} ctx
 * @param {import('./types.js').Execution} exec
 * @param {{ revision: number; tier: string; agent: import('./types.js').Agent } | undefined} call
 * @param {boolean} accepting
 * @param {(session: import('./types.js').Session) => number} revision
 */
function finalReason(ctx, exec, call, accepting, revision) {
  if (!MUTATIONS.has(exec.name)) return undefined;
  if (!accepting || !call || exec.signal.aborted) return UNAVAILABLE;
  if (exec.agent !== call.agent || ctx.agents.get(call.agent.session.id) !== call.agent)
    return UNAVAILABLE;
  if (
    revision(call.agent.session) !== call.revision ||
    selected(ctx, call.agent.session) !== call.tier
  )
    return STALE;
  return undefined;
}
