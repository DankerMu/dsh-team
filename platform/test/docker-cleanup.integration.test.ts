import { afterEach, expect, it, vi } from 'vitest';
import {
  cleanupTargets,
  OWNER_LABEL,
  output,
  registerCleanupTarget,
  removeOwned,
  retireCleanupJournal,
} from './docker-cleanup.ts';
import type { CleanupJournalEntry, CleanupTarget, JournalRetirement } from './docker-cleanup.ts';
import type { DockerCommand, DockerCommandResult } from './docker-command.ts';

const runId = 'cleanup-run';
const untagged = 'dsh-team-probe-user-cleanup-run-image';
const labelFormat = `{{ index .Config.Labels "${OWNER_LABEL}" }}`;
afterEach(() => {
  vi.unstubAllEnvs();
});

/** Docker 29.1.3 image store: an untagged reference resolves to, and is reported as, `:latest`. */
function daemon(present: Record<string, string>, absence?: (reference: string) => string) {
  const images = new Map(Object.entries(present));
  const calls: string[][] = [];
  const command: DockerCommand = (args): DockerCommandResult => {
    calls.push([...args]);
    if (args[0] === 'build') return { status: 1, stdout: '', stderr: 'build failed\n' };
    const target = String(args.at(-1));
    const reference = target.includes(':') ? target : `${target}:latest`;
    const label = images.get(reference);
    if (args[1] === 'rm') {
      if (label === undefined) throw new Error(`unexpected removal of ${target}`);
      images.delete(reference);
      return { status: 0, stdout: `Untagged: ${reference}\n`, stderr: '' };
    }
    if (label !== undefined)
      return { status: 0, stdout: args.includes('--format') ? `${label}\n` : '[{}]\n', stderr: '' };
    return absence === undefined
      ? {
          status: 1,
          stdout: '',
          stderr: `Error response from daemon: No such image: ${reference}\n`,
        }
      : { status: 1, stdout: '', stderr: absence(reference) };
  };
  return { command, calls, images };
}

it('retires a never-created untagged image through its canonical latest reference', () => {
  const { command, calls } = daemon({});

  removeOwned(command, 'image', untagged, runId);

  expect(calls).toEqual([['image', 'inspect', '--format', labelFormat, `${untagged}:latest`]]);
});

it('uses one canonical reference to inspect, remove and recheck an owned untagged image', () => {
  const { command, calls, images } = daemon({ [`${untagged}:latest`]: runId });

  removeOwned(command, 'image', untagged, runId, { [OWNER_LABEL]: runId });

  expect(calls).toEqual([
    ['image', 'inspect', '--format', labelFormat, `${untagged}:latest`],
    ['image', 'rm', `${untagged}:latest`],
    ['image', 'inspect', `${untagged}:latest`],
  ]);
  expect(images.size).toBe(0);
});

it.each([
  ['tagged name', 'dsh-team-test-cleanup-run:probe'],
  ['immutable ID', `sha256:${'c'.repeat(64)}`],
])('keeps a %s unchanged throughout owned retirement', (_case, name) => {
  const { command, calls, images } = daemon({ [name]: runId });

  removeOwned(command, 'image', name, runId, { [OWNER_LABEL]: runId });

  expect(calls).toEqual([
    ['image', 'inspect', '--format', labelFormat, name],
    ['image', 'rm', name],
    ['image', 'inspect', name],
  ]);
  expect(images.size).toBe(0);
});

it.each([
  [
    'a foreign reference',
    () => `Error response from daemon: No such image: ${untagged}-x:latest\n`,
  ],
  ['the caller name', () => `Error response from daemon: No such image: ${untagged}\n`],
])('refuses %s as untagged image absence evidence', (_case, absence) => {
  const { command, calls } = daemon({}, absence);

  expect(() => {
    removeOwned(command, 'image', untagged, runId);
  }).toThrow(/^docker image inspect .* failed \(1\)/);
  expect(calls).toHaveLength(1);
});

it('refuses the canonical diagnostic with a non-1 exit status', () => {
  const failing: DockerCommand = () => ({
    status: 125,
    stdout: '',
    stderr: `Error response from daemon: No such image: ${untagged}:latest\n`,
  });

  expect(() => {
    removeOwned(failing, 'image', untagged, runId);
  }).toThrow(/failed \(125\)/);
});

it('refuses an untagged image whose invocation label does not match', () => {
  const { command, calls, images } = daemon({ [`${untagged}:latest`]: 'other-run' });

  expect(() => {
    removeOwned(command, 'image', untagged, runId);
  }).toThrow(`Refusing cleanup of image ${untagged}: invocation label does not match`);
  expect(calls).toHaveLength(1);
  expect(images.size).toBe(1);
});

it('fails when a foreign diagnostic follows untagged image removal', () => {
  const { command } = daemon({ [`${untagged}:latest`]: runId }, () => 'Error: foreign\n');

  expect(() => {
    removeOwned(command, 'image', untagged, runId, { [OWNER_LABEL]: runId });
  }).toThrow('Owned image remains after cleanup');
});

it('keeps an artifact build failure free of false untagged image cleanup failures', () => {
  // Replays scripts/verification-image.mjs: register, failed build, then cleanup.
  vi.stubEnv('DSH_TEAM_CI_RESOURCE_JOURNAL', '');
  const { command } = daemon({});
  const targets: CleanupTarget[] = [];
  const failures: unknown[] = [];
  let buildFailure: unknown;
  try {
    registerCleanupTarget(targets, runId, { kind: 'image', name: untagged });
    const build = ['build', '--tag', untagged, '/context'];
    output(command(build, 1000), build);
  } catch (error) {
    buildFailure = error;
    cleanupTargets(command, targets, runId, failures);
  }

  expect(buildFailure).toBeInstanceOf(Error);
  expect(failures).toEqual([]);
});

const runA = '11111111-1111-4111-8111-111111111111';
const runB = '22222222-2222-4222-8222-222222222222';
const platformId = 'a'.repeat(64);

interface EngineResource {
  readonly kind: CleanupTarget['kind'];
  readonly name: string;
  readonly id: string;
  readonly labels: Record<string, string>;
  status?: 'created' | 'running' | 'exited';
}

/** Docker 29.1.3 CLI shapes for exact inspect/kill/wait/rm; every call is recorded. */
function engine(resources: EngineResource[], exit = { code: 0, oom: false }) {
  const calls: string[][] = [];
  const absent = (kind: string, reference: string): DockerCommandResult => ({
    status: 1,
    stdout: '',
    stderr:
      kind === 'network'
        ? `Error response from daemon: network ${reference} not found\n`
        : `Error response from daemon: No such ${kind}: ${reference}\n`,
  });
  const ok = (stdout: string): DockerCommandResult => ({ status: 0, stdout, stderr: '' });
  const document = (resource: EngineResource) =>
    resource.kind === 'network'
      ? { Id: resource.id, Name: resource.name, Labels: resource.labels, Containers: {} }
      : {
          Id: resource.id,
          Name: `/${resource.name}`,
          Config: { Labels: resource.labels },
          State: {
            Status: resource.status,
            Running: resource.status === 'running',
            ExitCode: resource.status === 'exited' ? exit.code : 0,
            OOMKilled: resource.status === 'exited' && exit.oom,
          },
        };
  const command: DockerCommand = (args) => {
    calls.push([...args]);
    const scoped = ['container', 'network', 'volume', 'image'].includes(args[0] ?? '');
    const kind = scoped ? String(args[0]) : 'container';
    const verb = scoped ? args[1] : args[0];
    const reference = String(args.at(-1));
    const resource = resources.find(
      (candidate) =>
        candidate.kind === kind && (candidate.name === reference || candidate.id === reference),
    );
    if (resource === undefined) return absent(kind, reference);
    if (verb === 'inspect') {
      const format = args.indexOf('--format');
      if (format === -1) return ok(`${JSON.stringify([document(resource)])}\n`);
      const label = /"([^"]+)"/.exec(String(args[format + 1]))?.[1] ?? '';
      return ok(`${resource.labels[label] ?? '<no value>'}\n`);
    }
    if (verb === 'kill') {
      resource.status = 'exited';
      return ok(`${resource.id}\n`);
    }
    if (verb === 'wait') return ok(`${String(exit.code)}\n`);
    if (verb === 'rm') {
      resources.splice(resources.indexOf(resource), 1);
      return ok(`${reference}\n`);
    }
    throw new Error(`Unexpected fixture Docker operation ${args.join(' ')}`);
  };
  const retirement = (overrides: Partial<JournalRetirement> = {}): JournalRetirement => ({
    command,
    commandAsync: (args, timeout) => Promise.resolve(command(args, timeout)),
    acquireLock: () => {
      calls.push(['lock']);
      return Promise.resolve(() => {
        calls.push(['release']);
        return Promise.resolve();
      });
    },
    requireSettled: () => {
      calls.push(['settled']);
    },
    ...overrides,
  });
  const mutations = () => calls.filter((call) => call.includes('kill') || call.includes('rm'));
  return { calls, resources, retirement, mutations };
}

function deploymentRun(run: string, user: string): CleanupJournalEntry[] {
  return [
    {
      runId: run,
      target: { kind: 'container', name: 'dsh-team-platform', ownership: { [OWNER_LABEL]: run } },
    },
    {
      runId: run,
      target: {
        kind: 'container',
        name: `dsh-team-u-${user}`,
        ownership: { 'dsh-team.user': user },
      },
    },
  ];
}

function deploymentResources(
  owner: string,
  user: string,
  status: 'created' | 'running',
): EngineResource[] {
  return [
    {
      kind: 'container',
      name: 'dsh-team-platform',
      id: platformId,
      labels: { [OWNER_LABEL]: owner },
      status,
    },
    {
      kind: 'container',
      name: `dsh-team-u-${user}`,
      id: 'b'.repeat(64),
      labels: { 'dsh-team.user': user },
      status: 'running',
    },
  ];
}

it('removes a created deployment platform under the lock without signalling it', async () => {
  const fixture = engine(deploymentResources(runA, 'employee', 'created'));
  const failures: unknown[] = [];

  await retireCleanupJournal(deploymentRun(runA, 'employee'), fixture.retirement(), failures);

  expect(failures).toEqual([]);
  expect(fixture.calls.some((call) => call.includes('kill') || call.includes('wait'))).toBe(false);
  expect(fixture.resources).toEqual([]);
  expect(fixture.calls[0]).toEqual(['lock']);
  expect(fixture.calls.at(-1)).toEqual(['release']);
});

it('drains a running deployment platform by exact SIGTERM before any registered removal', async () => {
  const fixture = engine(deploymentResources(runA, 'employee', 'running'));
  const failures: unknown[] = [];

  await retireCleanupJournal(deploymentRun(runA, 'employee'), fixture.retirement(), failures);

  expect(failures).toEqual([]);
  expect(fixture.mutations()[0]).toEqual(['kill', '--signal', 'SIGTERM', platformId]);
  const kill = fixture.calls.findIndex((call) => call[0] === 'kill');
  const settled = fixture.calls.findIndex((call) => call[0] === 'settled');
  expect(fixture.calls[kill + 1]).toEqual(['wait', platformId]);
  expect(settled).toBeGreaterThan(kill);
  expect(fixture.calls.findIndex((call) => call.includes('rm'))).toBeGreaterThan(settled);
  expect(fixture.resources).toEqual([]);
  expect(fixture.calls.at(-1)).toEqual(['release']);
});

it.each([
  ['a nonzero exit', { code: 3, oom: false }, 'Deployment owner did not exit gracefully'],
  ['an out-of-memory exit', { code: 0, oom: true }, 'Deployment owner drainage unconfirmed'],
])('removes nothing of a run whose platform drains with %s', async (_case, exit, message) => {
  const fixture = engine(deploymentResources(runA, 'employee', 'running'), exit);
  const failures: unknown[] = [];

  await retireCleanupJournal(deploymentRun(runA, 'employee'), fixture.retirement(), failures);

  expect(failures).toEqual([new Error(message)]);
  expect(fixture.mutations()).toEqual([['kill', '--signal', 'SIGTERM', platformId]]);
  expect(fixture.calls.some((call) => call[0] === 'settled')).toBe(false);
  expect(fixture.resources).toHaveLength(2);
  expect(fixture.calls.at(-1)).toEqual(['release']);
});

it('refuses to drain or remove a fixed platform labelled for another run', async () => {
  const fixture = engine(deploymentResources('foreign-owner', 'employee', 'running'));
  const failures: unknown[] = [];

  await retireCleanupJournal(deploymentRun(runA, 'employee'), fixture.retirement(), failures);

  expect(failures).toEqual([new Error('Refusing shutdown of an unowned deployment')]);
  expect(fixture.mutations()).toEqual([]);
  expect(fixture.resources).toHaveLength(2);
});

it('treats an absent registered platform as drained and retires the rest of its run', async () => {
  const fixture = engine(deploymentResources(runA, 'employee', 'running').slice(1));
  const failures: unknown[] = [];

  await retireCleanupJournal(deploymentRun(runA, 'employee'), fixture.retirement(), failures);

  expect(failures).toEqual([]);
  expect(fixture.calls.some((call) => call[0] === 'kill')).toBe(false);
  expect(fixture.resources).toEqual([]);
});

it('keeps every resource of a drained run while submission settlement remains pending', async () => {
  const fixture = engine(deploymentResources(runA, 'employee', 'running'));
  const failures: unknown[] = [];
  const pending = new Error('Verification submission settlement unconfirmed');

  await retireCleanupJournal(
    deploymentRun(runA, 'employee'),
    fixture.retirement({
      requireSettled: () => {
        throw pending;
      },
    }),
    failures,
  );

  expect(failures).toEqual([pending]);
  expect(fixture.mutations()).toEqual([['kill', '--signal', 'SIGTERM', platformId]]);
  expect(fixture.resources.map((resource) => resource.name)).toEqual([
    'dsh-team-platform',
    'dsh-team-u-employee',
  ]);
  expect(fixture.calls.at(-1)).toEqual(['release']);
});

it('retires a non-platform run by exact forced removal without signalling or locking', async () => {
  const fixture = engine([
    {
      kind: 'container',
      name: 'dsh-team-test-sleeper',
      id: 'c'.repeat(64),
      labels: { [OWNER_LABEL]: runA },
      status: 'running',
    },
  ]);
  const failures: unknown[] = [];

  await retireCleanupJournal(
    [
      {
        runId: runA,
        target: {
          kind: 'container',
          name: 'dsh-team-test-sleeper',
          ownership: { [OWNER_LABEL]: runA },
        },
      },
    ],
    fixture.retirement(),
    failures,
  );

  expect(failures).toEqual([]);
  expect(fixture.mutations()).toEqual([['container', 'rm', '--force', 'dsh-team-test-sleeper']]);
  expect(fixture.calls.some((call) => call[0] === 'lock')).toBe(false);
  expect(fixture.resources).toEqual([]);
});

it('mutates nothing of a deployment run whose host lock is unavailable', async () => {
  const fixture = engine([
    ...deploymentResources(runB, 'employee', 'running'),
    {
      kind: 'volume',
      name: 'dsh-team-test-earlier',
      id: 'dsh-team-test-earlier',
      labels: { [OWNER_LABEL]: runA },
    },
  ]);
  const failures: unknown[] = [];
  const unavailable = new Error('Deployment verification lock unavailable');

  await retireCleanupJournal(
    [
      {
        runId: runA,
        target: {
          kind: 'volume',
          name: 'dsh-team-test-earlier',
          ownership: { [OWNER_LABEL]: runA },
        },
      },
      ...deploymentRun(runB, 'employee'),
    ],
    fixture.retirement({ acquireLock: () => Promise.reject(unavailable) }),
    failures,
  );

  expect(failures).toEqual([unavailable]);
  expect(fixture.mutations()).toEqual([['volume', 'rm', 'dsh-team-test-earlier']]);
  expect(fixture.calls.some((call) => call[0] === 'settled')).toBe(false);
  expect(fixture.resources.map((resource) => resource.name)).toEqual([
    'dsh-team-platform',
    'dsh-team-u-employee',
  ]);
});

it('retires the latest registration first so an earlier foreign sentinel then sees absence', async () => {
  const fixture = engine(deploymentResources(runB, 'later', 'running'));
  const failures: unknown[] = [];

  await retireCleanupJournal(
    [
      {
        runId: runA,
        target: {
          kind: 'container',
          name: 'dsh-team-platform',
          ownership: { [OWNER_LABEL]: `foreign-${runA.slice(0, 8)}` },
        },
      },
      ...deploymentRun(runB, 'later'),
    ],
    fixture.retirement(),
    failures,
  );

  expect(failures).toEqual([]);
  expect(fixture.resources).toEqual([]);
  const release = fixture.calls.findIndex((call) => call[0] === 'release');
  expect(fixture.calls.findIndex((call) => call[0] === 'kill')).toBeLessThan(release);
  expect(fixture.calls.slice(release + 1)).toEqual([
    [
      'container',
      'inspect',
      '--format',
      `{{ index .Config.Labels "${OWNER_LABEL}" }}`,
      'dsh-team-platform',
    ],
  ]);
});
