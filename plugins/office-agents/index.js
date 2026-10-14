export const name = 'dsh-team-office-delegation';
export const inject = ['agents', 'agentPresets', 'sessionProjections'];

/** @param {import('./types.js').Context} ctx */
export function apply(ctx) {
  ctx.on('agent/created', async ({ agent, source, signal }) => {
    const header = agent.session.header;
    if (
      source !== 'startup' ||
      header.origin !== 'subagent' ||
      header.isSeeded !== false ||
      header.delegationDepth !== 1 ||
      !header.parentSession
    ) {
      return;
    }
    // Continuable setup already wrote its descriptor; one-shot writes it at pre-step.
    // Host state wraps identity; the public wire projection is flattened.
    if (ctx.sessionProjections.stateOf(agent.session, 'subagent')?.identity?.mode === 'continuable')
      return;
    const parent = ctx.agents.get(header.parentSession);
    if (
      !parent ||
      ctx.agentPresets.composedPreset(parent.ctx) !== 'office-general' ||
      ctx.agentPresets.composedPreset(agent.ctx) !== 'office-general'
    ) {
      return;
    }
    signal.throwIfAborted();
    // Native creation awaits this listener before submitting the child's first prompt.
    // select commits the effective identity; never rewrite the immutable creation header.
    await ctx.agentPresets.select(agent, 'office-writer');
    signal.throwIfAborted();
  });
}
