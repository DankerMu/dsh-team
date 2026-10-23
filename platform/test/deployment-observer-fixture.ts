import { deepStrictEqual } from 'node:assert';
import { chmod, copyFile, lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  bindVerificationDockerObserver,
  createVerificationDockerObserverAuthority,
  requireVerificationDockerObserverInitialized,
  requireVerificationDockerObserverRequestsSettled,
  requireVerificationDockerObserverSettled,
  reserveVerificationDockerObserver,
} from '../../scripts/verification-docker-generations.mjs';
import {
  initializeVerificationSubmissions,
  SUBMISSION_AUTHORITY,
  SUBMISSION_JOURNAL,
} from '../../scripts/verification-submission-storage.mjs';
import { requireVerificationSubmissionsSettled } from '../../scripts/verification-submission-assessment.mjs';
import type {
  DockerObserverAuthority,
  DockerObserverReservation,
} from '../../scripts/verification-docker-generations.mjs';
import { writeReceipt } from '../../scripts/probe-browser-receipt.mjs';
import { inspectAsync, record } from './container-start-docker-fixture.ts';
import { createDockerCommands, isAbsentResource } from './docker-command.ts';
import type { AsyncDockerCommand } from './docker-command.ts';
import { OWNER_LABEL } from './docker-cleanup.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

const AUTHORITY_LABEL = 'dsh-team.observer-authority';
const CODE_TARGET = '/verification/docker-observer';

interface ObservationMount {
  type: 'bind';
  source: string;
  target: string;
  read_only: boolean;
  bind: { create_host_path: false };
}
interface ObserverGeneration {
  authority: DockerObserverAuthority;
  reservation: DockerObserverReservation;
  bound?: { id: string; startedAt: string };
}
export interface DeploymentObservation {
  directory: string;
  ownedRoot: boolean;
  rootIdentity: { device: number; inode: number; owner: number };
  imageId: string;
  runId: string;
  codeDirectory: string;
  override: string;
  command: string[];
  mounts: ObservationMount[];
  current: ObserverGeneration;
  generations: ObserverGeneration[];
  retirementCommand: AsyncDockerCommand;
  retired: boolean;
}

function observerMount(source: string, target: string, readOnly: boolean): ObservationMount {
  return { type: 'bind', source, target, read_only: readOnly, bind: { create_host_path: false } };
}

async function publishContainerOverride(observation: DeploymentObservation): Promise<void> {
  const preload = pathToFileURL(join(CODE_TARGET, 'verification-docker-observer.mjs'));
  preload.searchParams.set('bootstrap', observation.current.authority.bootstrap);
  preload.searchParams.set('authority', observation.current.authority.authority);
  observation.command = ['node', '--import', preload.href, 'platform/dist/main.js'];
  observation.mounts = [
    observerMount(observation.codeDirectory, CODE_TARGET, true),
    observerMount(
      observation.current.authority.bootstrap,
      observation.current.authority.bootstrap,
      true,
    ),
    observerMount(
      join(observation.directory, SUBMISSION_AUTHORITY),
      join(observation.directory, SUBMISSION_AUTHORITY),
      true,
    ),
    observerMount(
      join(observation.directory, 'submission-evidence'),
      join(observation.directory, 'submission-evidence'),
      false,
    ),
  ];
  await writeReceipt(observation.override, {
    services: {
      platform: {
        command: observation.command,
        labels: { [AUTHORITY_LABEL]: observation.current.authority.authority },
        volumes: observation.mounts,
      },
    },
  });
}

export async function createDeploymentObservation(
  lifecycle: UserImageLifecycle,
  imageId: string,
): Promise<DeploymentObservation> {
  // The existing image runs uid1000; private evidence never becomes group/world writable.
  if (process.getuid?.() !== 1000)
    throw new Error('Deployment observation requires qualified uid1000');
  const journal = process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS;
  const ownedRoot = journal === undefined;
  // Inherited TMPDIR may itself be removed by an outer verifier after a failed scenario.
  const directory =
    journal === undefined
      ? await realpath(await mkdtemp('/tmp/dsh-team-observer-'))
      : dirname(dirname(journal));
  if (journal !== undefined && journal !== join(directory, SUBMISSION_JOURNAL))
    throw new Error('Deployment observation journal path is not canonical');
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700)
      throw new Error('Deployment observation root authority unavailable');
    if (ownedRoot) initializeVerificationSubmissions(directory);
    const inspectionConfig = join(directory, `observer-docker-${lifecycle.runId}`);
    await mkdir(inspectionConfig, { mode: 0o700 });
    const retirementCommand = createDockerCommands(
      lifecycle.repositoryRoot,
      inspectionConfig,
      true,
    ).commandAsync;
    const codeDirectory = join(directory, `observer-code-${lifecycle.runId}`);
    await mkdir(codeDirectory, { mode: 0o700 });
    for (const name of [
      'verification-docker-observer.mjs',
      'verification-submissions.mjs',
      'verification-submission-storage.mjs',
      'verification-docker-generations.mjs',
      'probe-browser-receipt.mjs',
      'probe-browser-native.mjs',
    ]) {
      const destination = join(codeDirectory, name);
      await copyFile(join(lifecycle.repositoryRoot, 'scripts', name), destination);
      await chmod(destination, 0o600);
    }
    const authority = createVerificationDockerObserverAuthority(directory, {
      moduleUrl: 'file:///app/platform/dist/orchestrator/client.js',
      socketPath: '/var/run/docker.sock',
      imageId,
    });
    const current = { authority, reservation: await reserveVerificationDockerObserver(authority) };
    const observation: DeploymentObservation = {
      directory,
      ownedRoot,
      rootIdentity: { device: info.dev, inode: info.ino, owner: info.uid },
      imageId,
      runId: lifecycle.runId,
      codeDirectory,
      override: join(directory, `observer-compose-${lifecycle.runId}.json`),
      command: [],
      mounts: [],
      current,
      generations: [current],
      retirementCommand,
      retired: false,
    };
    await publishContainerOverride(observation);
    return observation;
  } catch (error) {
    throw new Error(`Deployment observer preparation failed; retained ${directory}`, {
      cause: error,
    });
  }
}

function requireObserverMounts(observation: DeploymentObservation, values: unknown): void {
  if (!Array.isArray(values)) throw new Error('Deployment observer mounts unavailable');
  const mounts = values.map((value: unknown) => record(value));
  for (const expected of observation.mounts) {
    const found = mounts.filter((mount) => mount.Destination === expected.target);
    if (
      found.length !== 1 ||
      found[0]?.Type !== 'bind' ||
      found[0].Source !== expected.source ||
      found[0].RW !== !expected.read_only
    )
      throw new Error('Deployment observer mount authority changed');
  }
  for (const mount of mounts) {
    if (typeof mount.Source !== 'string') throw new Error('Deployment mount source unavailable');
    if (observation.mounts.some((expected) => expected.source === mount.Source)) continue;
    if (
      mount.Source === observation.directory ||
      observation.directory.startsWith(`${mount.Source.replace(/\/$/, '')}/`)
    )
      throw new Error('Deployment exposes observation authority ancestors');
  }
}

function inspectObserverContainer(
  observation: DeploymentObservation,
  container: Record<string, unknown>,
): { id: string; startedAt: string; state: Record<string, unknown> } {
  const config = record(container.Config);
  const labels = record(config.Labels);
  if (
    typeof container.Id !== 'string' ||
    !/^[a-f0-9]{64}$/.test(container.Id) ||
    container.Name !== '/dsh-team-platform' ||
    container.Image !== observation.imageId ||
    labels[OWNER_LABEL] !== observation.runId ||
    labels[AUTHORITY_LABEL] !== observation.current.authority.authority
  )
    throw new Error('Deployment observer container authority changed');
  deepStrictEqual(config.Cmd, observation.command, 'Deployment observer command changed');
  requireObserverMounts(observation, container.Mounts);
  const state = record(container.State);
  if (
    typeof state.StartedAt !== 'string' ||
    !Number.isFinite(Date.parse(state.StartedAt)) ||
    Date.parse(state.StartedAt) <= 0
  )
    throw new Error('Deployment observer process incarnation unavailable');
  return { id: container.Id, startedAt: state.StartedAt, state };
}

export async function bindDeploymentObservation(
  observation: DeploymentObservation,
  lifecycle: UserImageLifecycle,
  id = 'dsh-team-platform',
): Promise<void> {
  const found = inspectObserverContainer(observation, await inspectAsync(lifecycle, id));
  if (found.state.Running !== true) throw new Error('Deployment observer process did not start');
  bindVerificationDockerObserver(observation.current.reservation, {
    kind: 'container',
    generation: observation.current.reservation.generation,
    authority: observation.current.authority.authority,
    id: found.id,
    imageId: observation.imageId,
    startedAt: found.startedAt,
  });
  observation.current.bound = { id: found.id, startedAt: found.startedAt };
}

export function requireDeploymentObservationReady(observation: DeploymentObservation): void {
  if (observation.current.bound === undefined)
    throw new Error('Deployment observer parent binding missing');
  requireVerificationDockerObserverInitialized(observation.current.reservation);
}

export async function prepareDeploymentRestart(
  observation: DeploymentObservation,
  lifecycle: UserImageLifecycle,
  id: string,
): Promise<void> {
  const previous = observation.current;
  const found = inspectObserverContainer(observation, await inspectAsync(lifecycle, id));
  if (
    previous.bound?.id !== id ||
    found.id !== id ||
    previous.bound.startedAt !== found.startedAt ||
    found.state.Running !== false ||
    found.state.ExitCode !== 0 ||
    found.state.OOMKilled !== false
  )
    throw new Error('Deployment observer predecessor has not retired');
  requireVerificationDockerObserverSettled(previous.reservation);
  const current = {
    authority: previous.authority,
    reservation: await reserveVerificationDockerObserver(previous.authority),
  };
  observation.current = current;
  observation.generations.push(current);
}

export async function prepareDeploymentReplacement(
  observation: DeploymentObservation,
): Promise<void> {
  requireVerificationDockerObserverSettled(observation.current.reservation);
  const authority = createVerificationDockerObserverAuthority(observation.directory, {
    moduleUrl: 'file:///app/platform/dist/orchestrator/client.js',
    socketPath: '/var/run/docker.sock',
    imageId: observation.imageId,
  });
  const current = { authority, reservation: await reserveVerificationDockerObserver(authority) };
  observation.current = current;
  observation.generations.push(current);
  await publishContainerOverride(observation);
}

/**
 * Removes only this invocation's own retired root, after the captured identity fence. Callers
 * may run after the deployment lock was released; a custody-owned root is never removed here.
 */
export async function removeRetiredObservationRoot(
  observation: Pick<DeploymentObservation, 'directory' | 'ownedRoot' | 'rootIdentity' | 'retired'>,
): Promise<void> {
  if (!observation.ownedRoot) return;
  if (!observation.retired) throw new Error('Deployment observation has not retired');
  const current = await lstat(observation.directory);
  if (
    !current.isDirectory() ||
    current.dev !== observation.rootIdentity.device ||
    current.ino !== observation.rootIdentity.inode ||
    current.uid !== observation.rootIdentity.owner ||
    (current.mode & 0o777) !== 0o700
  )
    throw new Error('Deployment observer root changed before cleanup');
  await rm(observation.directory, { recursive: true });
}

/** Called after canonical resource cleanup, with the host-wide deployment lock still held. */
export async function finishDeploymentObservation(
  observation: DeploymentObservation,
  scenarioSucceeded: boolean,
): Promise<void> {
  try {
    const ids = new Set<string>();
    for (const generation of observation.generations) {
      if (generation.bound === undefined) throw new Error('Deployment generation was never bound');
      ids.add(generation.bound.id);
    }
    for (const id of ids) {
      const absent = await observation.retirementCommand(['container', 'inspect', id], 30_000);
      if (!isAbsentResource(absent, 'container', id))
        throw new Error('Deployment observer writer/container retirement unconfirmed');
    }
    for (const generation of observation.generations) {
      requireVerificationDockerObserverSettled(generation.reservation);
      requireVerificationDockerObserverRequestsSettled(generation.reservation);
    }
    if (observation.ownedRoot) requireVerificationSubmissionsSettled(observation.directory);
    observation.retired = true;
    if (scenarioSucceeded) await removeRetiredObservationRoot(observation);
  } catch (error) {
    throw new Error(`Deployment observation unconfirmed; retained ${observation.directory}`, {
      cause: error,
    });
  }
}
