import { expect, it } from 'vitest';
import { apply } from './index.js';

function creation() {
  const parent = { ctx: {}, session: { header: {} } };
  const agent = {
    ctx: {},
    session: {
      header: {
        origin: 'subagent',
        parentSession: 'parent',
        isSeeded: false,
        delegationDepth: 1,
      },
    },
  };
  const presets = new Map([
    [parent.ctx, 'office-general'],
    [agent.ctx, 'office-general'],
  ]);
  const controller = new AbortController();
  let listener;
  const context = {
    agents: { get: (id) => (id === 'parent' ? parent : undefined) },
    sessionProjections: { stateOf: () => ({}) },
    agentPresets: {
      composedPreset: (scope) => presets.get(scope),
      select: async (child, preset) => {
        presets.set(child.ctx, preset);
        return preset;
      },
    },
    on: (_event, callback) => {
      listener = callback;
    },
  };
  apply(context);
  return {
    agent,
    parent,
    presets,
    controller,
    context,
    announce: (source = 'startup') => listener({ agent, source, signal: controller.signal }),
  };
}

it('changes only the eligible child while preserving its parent composition and creation facts', async () => {
  const entry = creation();
  const header = structuredClone(entry.agent.session.header);

  await entry.announce();

  expect(entry.presets.get(entry.agent.ctx)).toBe('office-writer');
  expect(entry.presets.get(entry.parent.ctx)).toBe('office-general');
  expect(entry.agent.session.header).toEqual(header);
});

it.each([
  { label: 'root', header: { origin: 'user' } },
  { label: 'seeded fork', header: { isSeeded: true } },
  { label: 'unknown seed boundary', header: { isSeeded: undefined } },
  { label: 'nested child', header: { delegationDepth: 2 } },
  { label: 'missing lineage', header: { parentSession: undefined } },
  { label: 'resume', source: 'resume' },
  { label: 'clear', source: 'clear' },
  { label: 'continuable', mode: 'continuable' },
  { label: 'other parent preset', parentPreset: 'standard' },
  { label: 'unavailable parent', parentMissing: true },
  { label: 'existing writer', childPreset: 'office-writer' },
])('preserves $label without selecting a new preset', async (change) => {
  const entry = creation();
  Object.assign(entry.agent.session.header, change.header);
  if (change.parentPreset) entry.presets.set(entry.parent.ctx, change.parentPreset);
  if (change.childPreset) entry.presets.set(entry.agent.ctx, change.childPreset);
  if (change.parentMissing) entry.context.agents.get = () => undefined;
  if (change.mode)
    entry.context.sessionProjections.stateOf = () => ({ identity: { mode: change.mode } });
  const before = [...entry.presets.values()];
  entry.context.agentPresets.select = async () => {
    throw new Error('Unrelated composition was rebound');
  };

  await entry.announce(change.source);

  expect([...entry.presets.values()]).toEqual(before);
});

it('does not finish creation before native preset selection settles', async () => {
  const entry = creation();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const select = entry.context.agentPresets.select;
  entry.context.agentPresets.select = async (...args) => {
    entered.resolve();
    await release.promise;
    return select(...args);
  };
  let admitted = false;

  const pending = entry.announce().then(() => {
    admitted = true;
  });
  await entered.promise;
  expect(admitted).toBe(false);
  expect(entry.presets.get(entry.agent.ctx)).toBe('office-general');
  release.resolve();
  await pending;

  expect(admitted).toBe(true);
  expect(entry.presets.get(entry.agent.ctx)).toBe('office-writer');
});

it('propagates unavailable writer failure without general fallback', async () => {
  const entry = creation();
  const unavailable = new Error('Writer preset cannot activate');
  entry.context.agentPresets.select = async () => {
    throw unavailable;
  };

  await expect(entry.announce()).rejects.toBe(unavailable);

  expect(entry.presets.get(entry.agent.ctx)).toBe('office-general');
  expect(entry.presets.get(entry.parent.ctx)).toBe('office-general');
});

it('rejects an already cancelled creation without changing composition', async () => {
  const entry = creation();
  entry.controller.abort();

  await expect(entry.announce()).rejects.toMatchObject({ name: 'AbortError' });

  expect(entry.presets.get(entry.agent.ctx)).toBe('office-general');
});

it('does not admit work when cancellation wins during selection', async () => {
  const entry = creation();
  const select = entry.context.agentPresets.select;
  entry.context.agentPresets.select = async (...args) => {
    const preset = await select(...args);
    entry.controller.abort();
    return preset;
  };

  await expect(entry.announce()).rejects.toMatchObject({ name: 'AbortError' });

  expect(entry.presets.get(entry.parent.ctx)).toBe('office-general');
});
