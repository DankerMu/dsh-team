import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { processBirth, processIdentity } from '../../scripts/probe-browser-native.mjs';
import { signalOwnedGroup } from '../../scripts/trusted-docker-owner.mjs';
import { record } from './container-start-docker-fixture.ts';
import { withTrustedDockerFixture } from './trusted-docker-fixture.ts';
import type { RetirementScenario } from './trusted-docker-fixture.ts';

type CustodyFixture = Parameters<Parameters<typeof withTrustedDockerFixture>[1]>[0];

const PLATFORM_ID = 'a'.repeat(64);
const READ_ONLY = new Set(['inspect', 'ls', 'wait']);
const RESULT_WAIT_MS = 60_000;
// Readiness, the cancelled result wait and fixture-owned retirement share one case bound.
const CASE_TIMEOUT_MS = 90_000;

function daemonEvidence(repository: string) {
  const root = join(repository, '.run/fake-daemon');
  const state = record(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')) as unknown);
  if (!Array.isArray(state.resources)) throw new Error('Fixture daemon state malformed');
  const names = state.resources.map((resource: unknown) => String(record(resource).name)).sort();
  const lines = (name: string) => {
    const path = join(root, name);
    return existsSync(path)
      ? readFileSync(path, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string[])
      : [];
  };
  const calls = lines('calls.jsonl');
  // The owner preload's own account of every docker/flock launch it routed or refused.
  const launches = lines('preload.jsonl');
  const docker = calls.filter((call) => call[0] === 'docker').map((call) => call.slice(1));
  const verb = (call: string[]) =>
    ['container', 'image', 'network', 'volume'].includes(call[0] ?? '') ? call[1] : call[0];
  const mutations = docker.filter((call) => !READ_ONLY.has(verb(call) ?? ''));
  const routed = launches.filter(([outcome]) => outcome === 'routed').length;
  const refused = launches.filter(([outcome]) => outcome !== 'routed').length;
  // The daemon also appends flock-released and the lock guard unlink; neither is a launch.
  const daemonLaunches = calls.filter(([binary]) => binary === 'docker' || binary === 'flock');
  return {
    names,
    calls,
    docker,
    mutations,
    routed,
    refused,
    daemonLaunches: daemonLaunches.length,
  };
}

/** Start a held retirement child, cancel it once ready, and return its settled terminal. */
async function cancelRetirement(fixture: CustodyFixture) {
  const started = await fixture.start();
  expect(started.status, started.stderr).toBe(0);
  const invocation = record(JSON.parse(started.stdout) as unknown).invocation;
  if (typeof invocation !== 'string') throw new Error('Missing owned invocation');
  const directory = join(fixture.home, '.local/share/dsh-team/docker-verification', invocation);
  const manifestPath = join(directory, 'manifest.json');
  const manifest = readFileSync(manifestPath, 'utf8');
  const temporary = record(JSON.parse(manifest) as unknown).temporary;
  if (typeof temporary !== 'string') throw new Error('Missing owned temporary root');
  await vi.waitFor(
    () => {
      expect(existsSync(join(temporary, 'child-ready.json'))).toBe(true);
    },
    { timeout: 10_000, interval: 50 },
  );

  const cancelled = fixture.command(['cancel', invocation], true);

  expect(cancelled.status, cancelled.stderr).toBe(0);
  // Under full parallel integration load, real pnpm's SIGINT-to-close alone took 15-30s;
  // the retirement and assessment after close completed within 1s in every observation.
  await vi.waitFor(
    () => {
      expect(existsSync(join(directory, 'result.json'))).toBe(true);
    },
    { timeout: RESULT_WAIT_MS, interval: 50 },
  );
  // The changed-identity variant rewrote these bytes; status reads only the original authority.
  writeFileSync(manifestPath, manifest);
  const status = fixture.command(['status', invocation]);
  expect(status.status, status.stderr).toBe(0);
  const submissions = readFileSync(
    join(directory, 'submission-evidence/submissions.jsonl'),
    'utf8',
  );
  const retirementPath = join(directory, 'retirement.json');
  const daemon = daemonEvidence(fixture.repository);
  // Interception is the proof: every docker/flock launch reached the fake daemon, none refused.
  expect(daemon.refused).toBe(0);
  expect(daemon.routed).toBe(daemon.daemonLaunches);
  return {
    directory,
    retirement: existsSync(retirementPath)
      ? record(JSON.parse(readFileSync(retirementPath, 'utf8')) as unknown)
      : undefined,
    terminal: record(JSON.parse(status.stdout) as unknown),
    daemon,
    submissions: submissions.split('\n').filter(Boolean).length,
  };
}

function retirementCase(
  scenario: RetirementScenario,
  run: (fixture: CustodyFixture) => Promise<void>,
) {
  return withTrustedDockerFixture('retire', run, scenario);
}

it(
  'retires every journal registration after cancellation, draining the platform first',
  async () => {
    await retirementCase('green', async (fixture) => {
      const { terminal, daemon, submissions, retirement } = await cancelRetirement(fixture);

      expect(terminal).toMatchObject({
        state: 'failed',
        command: { settled: true },
        interruption: 'cancelled',
        failure: null,
        cleanup: { state: 'confirmed', browserExec: null },
      });
      const command = record(terminal.command);
      // Darwin pnpm relays the leaf's SIGINT handler exit; Linux pnpm re-raises SIGINT.
      expect([
        { exitCode: 27, signal: null },
        { exitCode: null, signal: 'SIGINT' },
      ]).toContainEqual({ exitCode: command.exitCode, signal: command.signal });
      expect(daemon.names).toEqual([expect.stringMatching(/^dsh-team-u-sentinel-/)]);
      const kill = daemon.docker.findIndex((call) => call[0] === 'kill');
      expect(daemon.docker[kill]).toEqual(['kill', '--signal', 'SIGTERM', PLATFORM_ID]);
      expect(daemon.docker[kill + 1]).toEqual(['wait', PLATFORM_ID]);
      expect(daemon.mutations.filter((call) => call[0] === 'kill')).toHaveLength(1);
      const removals = daemon.docker.flatMap((call, index) => (call.includes('rm') ? [index] : []));
      expect(removals.length).toBeGreaterThan(0);
      expect(Math.min(...removals)).toBeGreaterThan(kill);
      const acquired = daemon.calls.findIndex((call) => call[0] === 'flock');
      expect(daemon.calls[acquired]?.slice(1, 3)).toEqual([
        '--nonblock',
        '/tmp/dsh-team-deployment.lock',
      ]);
      const released = daemon.calls.findIndex((call) => call[0] === 'flock-released');
      const lastRemoval = daemon.calls.findLastIndex((call) => call.includes('rm'));
      expect(acquired).toBeLessThan(daemon.calls.findIndex((call) => call[1] === 'kill'));
      expect(released).toBeGreaterThan(lastRemoval);
      expect(daemon.calls.some((call) => call[0] === 'unlink')).toBe(false);
      // The read-only assessment observed through the same fake daemon after retirement.
      expect(daemon.docker.at(-1)?.[1]).toBe('ls');
      // Approval and participant reservations only: the owner published no submissions.
      expect(submissions).toBe(4);
      expect(retirement).toMatchObject({ version: 1, failures: 0 });
    });
  },
  CASE_TIMEOUT_MS,
);

it(
  'preserves a registered name whose live labels changed and leaves cleanup unconfirmed',
  async () => {
    await retirementCase('mismatch', async (fixture) => {
      const { terminal, daemon, retirement } = await cancelRetirement(fixture);

      expect(terminal).toMatchObject({
        state: 'failed',
        interruption: 'cancelled',
        cleanup: { state: 'unconfirmed' },
      });
      expect(retirement).toMatchObject({ failures: 1 });
      expect(daemon.names).toEqual([
        expect.stringMatching(/^dsh-team-mismatch-/),
        expect.stringMatching(/^dsh-team-u-sentinel-/),
      ]);
      expect(daemon.mutations.some((call) => call.at(-1)?.startsWith('dsh-team-mismatch-'))).toBe(
        false,
      );
    });
  },
  CASE_TIMEOUT_MS,
);

it.each([
  ['a live process writer', 'process-writer', null],
  ['a live container writer that is not the registered platform', 'foreign-writer', null],
  ['an uncompleted absent container writer that is not the platform', 'absent-writer', null],
  ['a reserved generation that was never bound', 'unbound', null],
  ['a changed manifest digest', 'digest', 'identity'],
] as const)(
  'mutates nothing after cancellation with %s',
  async (_case, scenario, failure) => {
    await retirementCase(scenario, async (fixture) => {
      const { terminal, daemon, retirement } = await cancelRetirement(fixture);

      expect(terminal).toMatchObject({
        state: 'failed',
        command: { settled: true },
        interruption: 'cancelled',
        failure,
        cleanup: { state: 'unconfirmed' },
      });
      expect(retirement).toMatchObject({ failures: 1 });
      expect(daemon.mutations).toEqual([]);
      expect(daemon.calls.some((call) => call[0] === 'flock')).toBe(false);
    });
  },
  CASE_TIMEOUT_MS,
);

it(
  'mutates nothing while a same-group member keeps the cancelled command unsettled',
  async () => {
    await retirementCase('member', async (fixture) => {
      const { terminal, daemon, retirement } = await cancelRetirement(fixture);

      expect(terminal).toMatchObject({
        state: 'unknown',
        command: { settled: false },
        interruption: 'cancelled',
        cleanup: { state: 'unconfirmed' },
      });
      expect(retirement).toBeUndefined();
      expect(daemon.mutations).toEqual([]);
      expect(daemon.names).toHaveLength(5);
    });
  },
  CASE_TIMEOUT_MS,
);

it(
  'removes nothing of a drained platform run whose reservation remains pending',
  async () => {
    await retirementCase('unsettled', async (fixture) => {
      const { terminal, daemon, retirement } = await cancelRetirement(fixture);

      expect(terminal).toMatchObject({
        state: 'failed',
        interruption: 'cancelled',
        cleanup: { state: 'unconfirmed' },
      });
      expect(retirement).toMatchObject({ failures: 1 });
      expect(daemon.mutations).toEqual([['kill', '--signal', 'SIGTERM', PLATFORM_ID]]);
      expect(daemon.names).toHaveLength(5);
      expect(daemon.calls.some((call) => call[0] === 'flock-released')).toBe(true);
    });
  },
  CASE_TIMEOUT_MS,
);

it(
  'mutates nothing of a platform run while the host deployment lock is held elsewhere',
  async () => {
    await retirementCase('lock-unavailable', async (fixture) => {
      const { terminal, daemon, retirement } = await cancelRetirement(fixture);

      expect(terminal).toMatchObject({
        state: 'failed',
        interruption: 'cancelled',
        cleanup: { state: 'unconfirmed' },
      });
      expect(retirement).toMatchObject({ failures: 1 });
      expect(daemon.calls.filter((call) => call[0] === 'flock')).toEqual([
        [
          'flock',
          '--nonblock',
          '/tmp/dsh-team-deployment.lock',
          expect.any(String),
          '-e',
          expect.any(String),
        ],
      ]);
      expect(daemon.mutations).toEqual([]);
      expect(daemon.calls.some((call) => call[0] === 'unlink')).toBe(false);
      expect(daemon.names).toHaveLength(5);
    });
  },
  CASE_TIMEOUT_MS,
);

// Retirement requires the owner's own group signal; a child that already ended received none.
it.each([
  ['exited', { exitCode: 23, signalCode: null }],
  ['died by a signal', { exitCode: null, signalCode: 'SIGINT' }],
] as const)('reports no group signal for a child that already %s', async (_case, child) => {
  const kill = vi.spyOn(process, 'kill');
  try {
    await expect(signalOwnedGroup(child, { pid: 1, birth: 'unobserved' })).resolves.toBe(false);
    expect(kill).not.toHaveBeenCalled();
  } finally {
    kill.mockRestore();
  }
});

it('reports the group signal it actually sent to a live owned child', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
    detached: true,
    stdio: 'ignore',
  });
  const closed = once(child, 'close');
  try {
    await once(child, 'spawn');
    if (child.pid === undefined) throw new Error('Missing owned signal fixture');
    const identity = processIdentity({ pid: child.pid, birth: await processBirth(child.pid) });

    await expect(signalOwnedGroup(child, identity)).resolves.toBe(true);
    expect(await closed).toEqual([null, 'SIGINT']);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
});
