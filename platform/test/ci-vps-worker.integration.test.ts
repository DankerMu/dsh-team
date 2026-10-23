import { expect, it } from 'vitest';
import { runOwnerScenario } from './ci-vps-owner-fixture.ts';
import { runWorkerScenario } from './ci-vps-worker-fixture.ts';
import type { WorkerMode } from './ci-vps-worker-fixture.ts';

// Each case runs owned real worker processes; the fixture's own group deadline is20s.
const WORKER_CASE_TIMEOUT = 30_000;

type Scenario = Awaited<ReturnType<typeof runWorkerScenario>>;

function expectPrivateReceipts(result: Scenario) {
  for (const file of [result.phase, result.execution, result.final])
    if (file)
      expect({ regular: file.regular, mode: file.mode }).toEqual({ regular: true, mode: 0o600 });
}

function expectNoCanary(result: Scenario) {
  const retained = [
    result.phase?.text,
    result.execution?.text,
    result.final?.text,
    result.executed.output,
    result.finalized?.output,
  ].join('\n');
  for (const canary of Object.values(result.canaries)) expect(retained).not.toContain(canary);
  expect(result.callText).not.toContain(result.canaries.proxy);
}

it.each<[WorkerMode, Record<string, unknown>]>([
  ['checkout-nonzero', { phase: 'checkout', category: 'nonzero', exitCode: 1 }],
  ['install-nonzero', { phase: 'install', category: 'nonzero', exitCode: 7 }],
  ['build-signal', { phase: 'build', category: 'signal', signal: 'SIGKILL' }],
  ['build-timeout', { phase: 'build', category: 'timeout', signal: 'SIGTERM' }],
  ['build-output-limit', { phase: 'build', category: 'output-limit', signal: 'SIGTERM' }],
  ['checkout-spawn-error', { phase: 'checkout', category: 'spawn-error' }],
  ['identity-mismatch', { phase: 'checkout', category: 'identity-mismatch', exitCode: 0 }],
  ['checkout-unknown', { phase: 'checkout', category: 'unknown' }],
  ['admission-expired', { phase: 'admission', category: 'admission-expired' }],
  ['admission-cancelled', { phase: 'admission', category: 'admission-expired' }],
])(
  'retains the failed %s phase with only closed-set facts',
  async (mode, facts) => {
    const result = await runWorkerScenario(mode);

    expect(result.phase?.value).toEqual({ version: 1, state: 'failed', ...facts });
    expect(result.execution?.value).toEqual({
      exitCode: 1,
      phase: facts.phase,
      category: facts.category,
    });
    expect(result.log).toBeUndefined();
    // Survival is observed only where the fake publishes build.pid (build-timeout); other rows
    // never start a blocking fake, so this is trivially false for them.
    expect(result.survivor).toBe(false);
    expectPrivateReceipts(result);
    expectNoCanary(result);
  },
  WORKER_CASE_TIMEOUT,
);

it(
  'records no phase when approval validation rejects the invocation',
  async () => {
    const result = await runWorkerScenario('invalid-approval');

    expect(result.phase).toBeUndefined();
    expect(result.execution?.value).toEqual({ exitCode: 1 });
    expect(result.calls).toEqual([]);
  },
  WORKER_CASE_TIMEOUT,
);

it(
  'leaves the entered build phase when the whole worker group is killed mid-phase',
  async () => {
    const result = await runWorkerScenario('build-interrupted');

    expect(result.executed.exit).toBeNull();
    expect(result.phase?.value).toEqual({ version: 1, phase: 'build', state: 'entered' });
    expect(result.execution).toBeUndefined();
    expect(result.survivor).toBe(false);
    expectPrivateReceipts(result);
    expectNoCanary(result);
  },
  WORKER_CASE_TIMEOUT,
);

it(
  'records a completed driver phase and redacts the model key from the driver log',
  async () => {
    const result = await runWorkerScenario('driver-success');

    expect(result.phase?.value).toEqual({
      version: 1,
      phase: 'driver',
      state: 'completed',
      exitCode: 0,
    });
    expect(result.execution?.value).toEqual({ exitCode: 0, phase: 'driver' });
    expect(result.calls.map((call) => `${call.name} ${call.args[0] ?? ''}`)).toEqual([
      'git init',
      'git remote',
      'git fetch',
      'git checkout',
      'git rev-parse',
      'pnpm install',
      'pnpm build',
      'pnpm test:model',
    ]);
    expect(result.calls[2]?.args).toContain(result.canaries.sha);
    expect(result.log).toContain('[REDACTED]');
    expect(result.log).not.toContain(result.canaries.key);
    expectPrivateReceipts(result);
    expectNoCanary(result);
  },
  WORKER_CASE_TIMEOUT,
);

it(
  'records a failed driver phase while keeping the driver exit status',
  async () => {
    const result = await runWorkerScenario('driver-nonzero');

    expect(result.phase?.value).toEqual({
      version: 1,
      phase: 'driver',
      state: 'failed',
      category: 'nonzero',
      exitCode: 3,
    });
    expect(result.execution?.value).toEqual({ exitCode: 3, phase: 'driver', category: 'nonzero' });
    expect(result.log).toContain('[REDACTED]');
    expectNoCanary(result);
  },
  WORKER_CASE_TIMEOUT,
);

it.each<[WorkerMode, number]>([
  ['install-nonzero', 1],
  ['driver-success', 0],
])(
  'finalizes a real %s execution into the exact host receipt the owner accepts',
  async (mode, exitCode) => {
    const result = await runWorkerScenario(mode, { finalize: true });
    const final = { vpsCleanupComplete: true, failures: [], exitCode };

    expect(result.finalized?.exit).toBe(0);
    expect(result.final?.value).toEqual(final);
    expectPrivateReceipts(result);
    expectNoCanary(result);
    const owner = await runOwnerScenario('valid-execution-failure', result.final?.text);
    // The owner's accepted host receipt (vps-final.json) carries the worker exitCode exactly.
    // owner.result.exitCode is the owner's own Actions outcome, which this fixture always fails.
    expect(owner.localFinal).toEqual(final);
    expect(owner.recovery).toMatchObject({ receiptSource: 'observer', cleanupConfirmed: true });
    expect(owner.result).toMatchObject({ cleanupComplete: true, exitCode: 1 });
    expect(owner.lockTarget).toBeUndefined();
  },
  WORKER_CASE_TIMEOUT,
);

it.each([
  ['malformed', { text: '{"exitCode":', mode: 0o600 }],
  ['oversized', { text: JSON.stringify({ exitCode: 0, pad: 'x'.repeat(16_384) }), mode: 0o600 }],
  ['out-of-range', { text: '{"exitCode":256}', mode: 0o600 }],
  ['negative', { text: '{"exitCode":-1}', mode: 0o600 }],
  ['fractional', { text: '{"exitCode":0.5}', mode: 0o600 }],
  ['string', { text: '{"exitCode":"0"}', mode: 0o600 }],
  ['non-object', { text: '[0]', mode: 0o600 }],
  ['group-readable', { text: '{"exitCode":0}', mode: 0o640 }],
  ['symlinked', 'symlink'],
  ['missing', 'absent'],
] as const)(
  'fails a %s execution result closed during finalization',
  async (_name, execution) => {
    const result = await runWorkerScenario('driver-success', { finalize: true, execution });

    expect(result.finalized?.exit).toBe(0);
    expect(result.final?.value).toEqual({ vpsCleanupComplete: true, failures: [], exitCode: 1 });
    expect(result.final?.mode).toBe(0o600);
  },
  WORKER_CASE_TIMEOUT,
);

function gitCalls(result: Scenario) {
  return result.calls.filter((call) => call.name === 'git');
}

it(
  'tunnels the exact-SHA checkout fetch only through the host-local loopback proxy',
  async () => {
    const result = await runWorkerScenario('driver-success', { hostProxy: 'tunnel' });

    // Real git keeps the fixed remote; the owned recorder refuses its tunnel.
    expect(result.tunnels).toEqual(['github.com:443']);
    expect(result.phase?.value).toEqual({
      version: 1,
      phase: 'checkout',
      state: 'failed',
      category: 'nonzero',
      exitCode: 128,
    });
    expect(result.execution?.value).toEqual({
      exitCode: 1,
      phase: 'checkout',
      category: 'nonzero',
    });
    expect(result.gitConfig).toContain('url = https://github.com/DankerMu/dsh-team.git');
    expect(result.gitConfig).not.toMatch(/proxy/i);
    expect(result.gitConfig).not.toContain(result.canaries.hostProxy);
    expect(result.calls).toEqual([]);
    expectPrivateReceipts(result);
    expectNoCanary(result);
  },
  WORKER_CASE_TIMEOUT,
);

it(
  'gives exactly the host-local fields to checkout git children and none to install, build or driver',
  async () => {
    const result = await runWorkerScenario('driver-success', { hostProxy: 'fields' });

    expect(result.phase?.value).toEqual({
      version: 1,
      phase: 'driver',
      state: 'completed',
      exitCode: 0,
    });
    expect(gitCalls(result).map((call) => call.args[0])).toEqual([
      'init',
      'remote',
      'fetch',
      'checkout',
      'rev-parse',
    ]);
    for (const call of gitCalls(result)) expect(call.proxy).toEqual(result.hostProxy);
    expect(result.calls.filter((call) => call.name === 'pnpm').map((call) => call.proxy)).toEqual([
      {},
      {},
      {},
    ]);
    const argv = JSON.stringify(result.calls.map((call) => call.args));
    expect(argv).not.toMatch(/proxy/i);
    expect(argv).not.toContain(result.canaries.hostProxy);
    expect(result.log).not.toContain(result.canaries.hostProxy);
    expectPrivateReceipts(result);
    expectNoCanary(result);
  },
  WORKER_CASE_TIMEOUT,
);

it(
  'keeps checkout git direct when the host-local source is absent',
  async () => {
    const result = await runWorkerScenario('driver-success');

    expect(result.execution?.value).toEqual({ exitCode: 0, phase: 'driver' });
    expect(gitCalls(result)).toHaveLength(5);
    for (const call of result.calls) expect(call.proxy).toEqual({});
    expectNoCanary(result);
  },
  WORKER_CASE_TIMEOUT,
);

it.each(['invalid-url', 'public-mode'] as const)(
  'fails checkout closed before any git process on %s host-local configuration',
  async (hostProxy) => {
    const result = await runWorkerScenario('driver-success', { hostProxy });

    expect(result.phase?.value).toEqual({
      version: 1,
      phase: 'checkout',
      state: 'failed',
      category: 'unknown',
    });
    expect(result.execution?.value).toEqual({
      exitCode: 1,
      phase: 'checkout',
      category: 'unknown',
    });
    expect(result.calls).toEqual([]);
    expectPrivateReceipts(result);
    expectNoCanary(result);
  },
  WORKER_CASE_TIMEOUT,
);
