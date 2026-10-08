import { expect, it } from 'vitest';
import { validateResourceOomEvidence } from './resource-oom-fixture.ts';
import type { DockerCommandResult } from './docker-command.ts';

const identity = { runId: 'owned-invocation', containerId: 'c'.repeat(64) };
const limits = { 'memory.max': '268435456', 'memory.swap.max': '0', 'pids.max': '512' };
const live = { Id: identity.containerId, State: { Running: true, OOMKilled: false, ExitCode: 0 } };
const killed = {
  Id: identity.containerId,
  State: { Running: false, OOMKilled: true, ExitCode: 137 },
};
const proof = {
  ...identity,
  requestedBytes: 536_870_912,
  touchedBytes: 8_388_608,
  oomKillBefore: 4,
  oomKillAfter: null,
  childSignal: null,
  limits,
};
const pressure: DockerCommandResult = { status: 137, stdout: '', stderr: '' };

it('accepts durable physical-touch evidence when the exact previously-live instance is OOM-killed', () => {
  const evidence = validateResourceOomEvidence(proof, identity, live, killed, pressure);

  expect(evidence).toEqual({
    requestedBytes: 536_870_912,
    touchedBytes: 8_388_608,
    oomKillBefore: 4,
    oomKillAfter: null,
    childSignal: null,
    limits,
    termination: 'instance',
  });
});

it('accepts child SIGKILL only with a fresh cgroup OOM counter increase', () => {
  const child = { ...proof, childSignal: 9, oomKillAfter: 5 };

  const evidence = validateResourceOomEvidence(child, identity, live, live, {
    ...pressure,
    status: 0,
  });

  expect(evidence).toEqual({
    requestedBytes: 536_870_912,
    touchedBytes: 8_388_608,
    oomKillBefore: 4,
    oomKillAfter: 5,
    childSignal: 9,
    limits,
    termination: 'child',
  });
});

it.each([
  ['no physical touch', { ...proof, touchedBytes: 0 }],
  ['completed oversized allocation', { ...proof, touchedBytes: 536_870_912 }],
  ['fractional progress', { ...proof, touchedBytes: 1.5 }],
  ['non-page-aligned progress', { ...proof, touchedBytes: 4097 }],
  ['nonfinite progress', { ...proof, touchedBytes: Infinity }],
  ['different allocation request', { ...proof, requestedBytes: 268_435_456 }],
  ['stale invocation', { ...proof, runId: 'previous-invocation' }],
  ['other container', { ...proof, containerId: 'd'.repeat(64) }],
  ['extra swap', { ...proof, limits: { ...limits, 'memory.swap.max': '268435456' } }],
  ['different memory ceiling', { ...proof, limits: { ...limits, 'memory.max': '536870912' } }],
  ['missing cgroup baseline', { ...proof, oomKillBefore: null }],
  ['negative cgroup baseline', { ...proof, oomKillBefore: -1 }],
])('rejects %s even when Docker reports instance OOM termination', (_name, invalid) => {
  expect(() => validateResourceOomEvidence(invalid, identity, live, killed, pressure)).toThrow();
});

it.each([
  ['exit137 alone', { ...killed, State: { ...killed.State, OOMKilled: false } }],
  ['a still-running instance', { ...killed, State: { ...killed.State, Running: true } }],
  ['normal termination', { ...killed, State: { ...killed.State, ExitCode: 0 } }],
  ['another instance', { ...killed, Id: 'd'.repeat(64) }],
])('rejects %s despite durable progress', (_name, after) => {
  expect(() => validateResourceOomEvidence(proof, identity, live, after, pressure)).toThrow();
});

it.each([
  ['already-dead instance', { ...live, State: { ...live.State, Running: false } }],
  ['previous OOM', { ...live, State: { ...live.State, OOMKilled: true } }],
  ['different original identity', { ...live, Id: 'd'.repeat(64) }],
])(
  'rejects %s rather than attributing startup failure to the pressure command',
  (_name, before) => {
    expect(() => validateResourceOomEvidence(proof, identity, before, killed, pressure)).toThrow();
  },
);

it.each([
  ['missing termination status', null],
  ['allocation exception', 1],
  ['timeout exit', 124],
])('rejects %s despite matching durable proof and Docker OOM state', (_name, status) => {
  expect(() =>
    validateResourceOomEvidence(proof, identity, live, killed, { ...pressure, status }),
  ).toThrow();
});

it.each([
  ['unchanged OOM counter', { ...proof, childSignal: 9, oomKillAfter: 4 }],
  ['non-OOM signal', { ...proof, childSignal: 14, oomKillAfter: 5 }],
  ['missing post-OOM counter', { ...proof, childSignal: 9 }],
])('rejects %s when only the child termination path is available', (_name, child) => {
  expect(() =>
    validateResourceOomEvidence(child, identity, live, live, { ...pressure, status: 0 }),
  ).toThrow();
});

it('retains the original external command error instead of accepting leftover OOM evidence', () => {
  const original = new Error('external timeout');
  let observed: unknown;
  try {
    validateResourceOomEvidence(proof, identity, live, killed, { ...pressure, error: original });
  } catch (error) {
    observed = error;
  }

  expect(observed).toBe(original);
});
