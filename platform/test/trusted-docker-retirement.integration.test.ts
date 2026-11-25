import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { processBirth, processIdentity } from '../../scripts/probe-browser-native.mjs';
import { signalOwnedGroup } from '../../scripts/trusted-docker-owner.mjs';
import { ownerIsLive } from '../../scripts/trusted-docker-record.mjs';
import type * as TrustedDockerRecord from '../../scripts/trusted-docker-record.mjs';
import { record } from './container-start-docker-fixture.ts';
import { awaitResult, withTrustedDockerFixture } from './trusted-docker-fixture.ts';
import type { RetirementScenario } from './trusted-docker-fixture.ts';

// Passthrough: every case reads the real identity; one case queues a single-call substitute.
vi.mock('../../scripts/trusted-docker-record.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof TrustedDockerRecord>();
  return { ...actual, ownerIsLive: vi.fn(actual.ownerIsLive) };
});

type CustodyFixture = Parameters<Parameters<typeof withTrustedDockerFixture>[1]>[0];

const PLATFORM_ID = 'a'.repeat(64);
const READ_ONLY = new Set(['inspect', 'ls', 'wait']);
// The deployment lock holder program the owner launches on this host.
const LOCK_HOLDER = platform() === 'darwin' ? 'python3' : 'flock';
const LOCK = '/tmp/dsh-team-deployment.lock';
const LOCK_ARGS: unknown[] =
  LOCK_HOLDER === 'flock'
    ? ['--nonblock', LOCK, expect.any(String), '-e', expect.any(String)]
    : ['-I', '-c', expect.any(String), LOCK];
// Readiness, the cancelled result wait and fixture-owned retirement share one case bound. The
// result wait ends RETIRE_MS before it: `status`'s 15s hard timeout plus the fixture's settles
// (fake platform, a possible group member, the child group, the owner) on a normal exit, 30s in
// all. A settle's theoretical ceiling is about 22s (two 5s observations, a 2s `ps`, about 10s of
// absence wait); all of them at once is unrealistic and not budgeted. The wait thus ends about
// 90s into the case, no sooner than the former 60s after setup; it follows the owner's liveness,
// so the case bound only caps an owner that is still running.
const CASE_TIMEOUT_MS = 120_000;
const RETIRE_MS = 30_000;

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
  const daemonLaunches = calls.filter(([binary]) => binary === 'docker' || binary === LOCK_HOLDER);
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

const SCENE_READ = { encoding: 'utf8', timeout: 2000, maxBuffer: 1 << 20 } as const;

/** `ps` rows of a root and its descendants; the walk relies on for-of visiting rows pushed during it. */
function processTree(rootPid: number) {
  const ps = execFileSync('/bin/ps', ['-axo', 'pid,ppid,pgid,stat,etime,command'], SCENE_READ);
  const rows = ps.split('\n').map((line) => line.trim().split(/\s+/));
  const own = rows.filter((row) => Number(row[0]) === rootPid);
  for (const parent of own) own.push(...rows.filter((row) => row[1] === parent[0]));
  return own.map((row) => row.join(' ').slice(0, 200)).join('\n');
}

/** A failed wait's scene: each piece shows its success form `name:\n` or `name unavailable`. */
function retirementScene(directory: string, ownerPid: number) {
  const piece = (name: string, read: () => string) => {
    try {
      return `\n${name}:\n${read()}`;
    } catch {
      return `\n${name} unavailable`;
    }
  };
  return [
    piece('invocation files', () => execFileSync('/bin/ls', ['-R', directory], SCENE_READ)),
    piece('owner.log tail', () => readFileSync(join(directory, 'owner.log'), 'utf8').slice(-2048)),
    piece('owner process tree', () => processTree(ownerPid)),
  ].join('');
}

/** Start a held retirement child and return its invocation once the child is ready. */
async function startRetirement(fixture: CustodyFixture) {
  const started = await fixture.start();
  expect(started.status, started.stderr).toBe(0);
  const invocation = record(JSON.parse(started.stdout) as unknown).invocation;
  if (typeof invocation !== 'string') throw new Error('Missing owned invocation');
  const directory = join(fixture.home, '.local/share/dsh-team/docker-verification', invocation);
  const manifestPath = join(directory, 'manifest.json');
  const manifest = readFileSync(manifestPath, 'utf8');
  const parsed = record(JSON.parse(manifest) as unknown);
  const temporary = parsed.temporary;
  const owner = record(parsed.owner);
  if (typeof temporary !== 'string') throw new Error('Missing owned temporary root');
  if (typeof owner.pid !== 'number' || typeof owner.birth !== 'string')
    throw new Error('Missing owner identity');
  await vi.waitFor(
    () => {
      expect(existsSync(join(temporary, 'child-ready.json'))).toBe(true);
    },
    { timeout: 10_000, interval: 50 },
  );
  return {
    invocation,
    directory,
    manifestPath,
    manifest,
    owner: { pid: owner.pid, birth: owner.birth },
  };
}

/** Start a held retirement child, cancel it once ready, and return its settled terminal. */
async function cancelRetirement(fixture: CustodyFixture, deadline: number) {
  const { invocation, directory, manifestPath, manifest, owner } = await startRetirement(fixture);
  const cancelled = fixture.command(['cancel', invocation], true);

  expect(cancelled.status, cancelled.stderr).toBe(0);
  // Under full parallel integration load, real pnpm's SIGINT-to-close alone took 15-30s;
  // the retirement and assessment after close completed within 1s in every observation.
  await awaitResult(directory, owner, deadline, fixture.observeProcess, retirementScene, 1000);
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
  run: (fixture: CustodyFixture, deadline: number) => Promise<void>,
) {
  const deadline = Date.now() + CASE_TIMEOUT_MS - RETIRE_MS;
  return withTrustedDockerFixture('retire', (fixture) => run(fixture, deadline), scenario);
}

it(
  'retires every journal registration after cancellation, draining the platform first',
  async () => {
    await retirementCase('green', async (fixture, deadline) => {
      const { terminal, daemon, submissions, retirement } = await cancelRetirement(
        fixture,
        deadline,
      );

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
      const acquired = daemon.calls.findIndex((call) => call[0] === LOCK_HOLDER);
      expect(daemon.calls[acquired]?.slice(1)).toEqual(LOCK_ARGS);
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
    await retirementCase('mismatch', async (fixture, deadline) => {
      const { terminal, daemon, retirement } = await cancelRetirement(fixture, deadline);

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
    await retirementCase(scenario, async (fixture, deadline) => {
      const { terminal, daemon, retirement } = await cancelRetirement(fixture, deadline);

      expect(terminal).toMatchObject({
        state: 'failed',
        command: { settled: true },
        interruption: 'cancelled',
        failure,
        cleanup: { state: 'unconfirmed' },
      });
      expect(retirement).toMatchObject({ failures: 1 });
      expect(daemon.mutations).toEqual([]);
      expect(daemon.calls.some((call) => call[0] === LOCK_HOLDER)).toBe(false);
    });
  },
  CASE_TIMEOUT_MS,
);

it(
  'mutates nothing while a same-group member keeps the cancelled command unsettled',
  async () => {
    await retirementCase('member', async (fixture, deadline) => {
      const { terminal, daemon, retirement } = await cancelRetirement(fixture, deadline);

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
    await retirementCase('unsettled', async (fixture, deadline) => {
      const { terminal, daemon, retirement } = await cancelRetirement(fixture, deadline);

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
    await retirementCase('lock-unavailable', async (fixture, deadline) => {
      const { terminal, daemon, retirement } = await cancelRetirement(fixture, deadline);

      expect(terminal).toMatchObject({
        state: 'failed',
        interruption: 'cancelled',
        cleanup: { state: 'unconfirmed' },
      });
      expect(retirement).toMatchObject({ failures: 1 });
      expect(daemon.calls.filter((call) => call[0] === LOCK_HOLDER)).toEqual([
        [LOCK_HOLDER, ...LOCK_ARGS],
      ]);
      expect(daemon.mutations).toEqual([]);
      expect(daemon.calls.some((call) => call[0] === 'unlink')).toBe(false);
      expect(daemon.names).toHaveLength(5);
    });
  },
  CASE_TIMEOUT_MS,
);

it(
  'fails the result wait at once when the owner exits without publishing result.json',
  async () => {
    await retirementCase('green', async (fixture, deadline) => {
      const { invocation, directory, owner } = await startRetirement(fixture);
      // The leaf is still held and nothing cancels it, so the owner cannot publish a result.
      await fixture.killOwner(invocation);
      const since = Date.now();

      const waited = awaitResult(
        directory,
        owner,
        deadline,
        fixture.observeProcess,
        retirementScene,
        1000,
      );
      const failure: unknown = await waited.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      const message = failure instanceof Error ? failure.message : '';
      // Every piece in its success form; the dead owner's tree is empty, so the message ends there.
      expect(message).toMatch(
        /owner exited without publishing result\.json[\s\S]*invocation files:\n[\s\S]*manifest\.json[\s\S]*owner\.log tail:\n[\s\S]*owner process tree:\n$/,
      );
      // Only the three pieces: the identity recheck and the uncontrolled log tail may say unavailable.
      expect(message).not.toMatch(
        /(invocation files|owner\.log tail|owner process tree) unavailable/,
      );
      // One poll plus one identity recheck of up to 5 s; the old fixed wait took 60 s.
      expect(Date.now() - since).toBeLessThan(15_000);
    });
  },
  CASE_TIMEOUT_MS,
);

it('walks a live process tree from its root to a known child', async () => {
  // A dedicated root: the test process also parents the walk's own `ps`, which would satisfy it.
  const source = `const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
child.once('spawn',()=>process.stdout.write(String(child.pid)));process.on('SIGTERM',()=>{child.kill('SIGKILL');process.exit(0);});setInterval(()=>{},1000);`;
  const root = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'ignore'] });
  const closed = once(root, 'close');
  try {
    const childPid = String((await once(root.stdout, 'data'))[0]);
    if (root.pid === undefined) throw new Error('Missing owned tree root');
    const rootPid = String(root.pid);

    const rows = processTree(root.pid)
      .split('\n')
      .map((line) => line.split(' '));

    expect(rows.some(([pid]) => pid === rootPid)).toBe(true);
    expect(rows.some(([, ppid]) => ppid === rootPid)).toBe(true);
    expect(rows.some(([pid, ppid]) => pid === childPid && ppid === rootPid)).toBe(true);
  } finally {
    root.kill('SIGTERM');
    await closed;
  }
});

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

// A child reaped while the final identity read is pending frees its group number for reuse.
it('sends no group signal when the owned child ends during the final identity check', async () => {
  const actual = await vi.importActual<typeof TrustedDockerRecord>(
    '../../scripts/trusted-docker-record.mjs',
  );
  const live = vi.mocked(ownerIsLive);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
    detached: true,
    stdio: 'ignore',
  });
  const closed = once(child, 'close');
  const realKill = process.kill.bind(process);
  // Group signals are recorded, never sent: a reaped group number may already name a stranger.
  const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid >= 0) realKill(pid, signal);
    return true;
  });
  try {
    await once(child, 'spawn');
    if (child.pid === undefined) throw new Error('Missing owned signal fixture');
    const identity = processIdentity({ pid: child.pid, birth: await processBirth(child.pid) });
    live
      .mockClear()
      .mockImplementationOnce(actual.ownerIsLive)
      .mockImplementationOnce(async () => {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
        return true;
      });

    const signalled = await signalOwnedGroup(child, identity);
    expect({
      signalled,
      identityChecks: live.mock.calls.length,
      groupSignals: kill.mock.calls.filter(([pid]) => pid < 0),
    }).toEqual({ signalled: false, identityChecks: 2, groupSignals: [] });
  } finally {
    kill.mockRestore();
    live.mockReset();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
});
