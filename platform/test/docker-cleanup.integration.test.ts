import { afterEach, expect, it, vi } from 'vitest';
import {
  cleanupTargets,
  OWNER_LABEL,
  output,
  registerCleanupTarget,
  removeOwned,
} from './docker-cleanup.ts';
import type { CleanupTarget } from './docker-cleanup.ts';
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
