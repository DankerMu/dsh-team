import { deepStrictEqual } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { profileSeedScript } from './profile-seed-fixture.ts';
import { runWebStartup } from './web-startup-fixture.ts';
import type { WebStartupBoundary } from './web-startup-fixture.ts';
import { isAbsentResource } from './docker-command.ts';
import type { DockerCommand, DockerCommandResult } from './docker-command.ts';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const OWNER_LABEL = 'dsh-team.test-run';

const offlineDocxScript = `
import json
import os
from docx import Document

path = "/data/work/offline.docx"
document = Document()
document.add_paragraph("离线办公验证")
document.add_paragraph("中文段落：无需联网即可生成文档。")
table = document.add_table(rows=2, cols=2)
for row, values in zip(table.rows, (("项目", "状态"), ("文档生成", "成功"))):
    for cell, value in zip(row.cells, values):
        cell.text = value
document.save(path)
reopened = Document(path)
print(json.dumps({
    "effectiveUid": os.geteuid(),
    "path": path,
    "paragraphs": [paragraph.text for paragraph in reopened.paragraphs],
    "tables": [
        [[cell.text for cell in row.cells] for row in table.rows]
        for table in reopened.tables
    ],
}, ensure_ascii=False))
`;

/** Independent exact oracle shared by real Docker and invalid-readback regressions. */
export function assertDocxReadback(stdout: string): void {
  const readback: unknown = JSON.parse(stdout);
  deepStrictEqual(
    readback,
    {
      effectiveUid: 1001,
      path: '/data/work/offline.docx',
      paragraphs: ['离线办公验证', '中文段落：无需联网即可生成文档。'],
      tables: [
        [
          ['项目', '状态'],
          ['文档生成', '成功'],
        ],
      ],
    },
    'Offline DOCX readback must match exact non-root workspace and Chinese content',
  );
}

function output(result: DockerCommandResult, args: readonly string[]): string {
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `docker ${args.join(' ')} failed (${String(result.status)}): ` +
        `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function nestedMessages(error: unknown): string[] {
  if (error instanceof AggregateError) {
    return error.errors.flatMap((inner) => nestedMessages(inner));
  }
  if (error instanceof Error) return [error.message];
  return [String(error)];
}

function networkDocument(
  result: DockerCommandResult,
  args: readonly string[],
): Record<string, unknown> {
  const rows: unknown = JSON.parse(output(result, args));
  if (!Array.isArray(rows) || rows.length !== 1)
    throw new Error('Owned network inspection unavailable');
  const value: unknown = rows[0];
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Owned network inspection malformed');
  // Docker JSON is untyped; destructive callers validate the consumed identity fields.
  return value as Record<string, unknown>;
}

function removeOwnedNetwork(
  command: DockerCommand,
  name: string,
  ownership: Readonly<Record<string, string>>,
  expectedId?: string,
): void {
  const args = ['network', 'inspect', name];
  const result = command(args, 30_000);
  if (isAbsentResource(result, 'network', name)) {
    if (
      expectedId !== undefined &&
      !isAbsentResource(command(['network', 'inspect', expectedId], 30_000), 'network', expectedId)
    )
      throw new Error('Owned network ID remains after its name disappeared');
    return;
  }
  const network = networkDocument(result, args);
  const id = network.Id;
  const identityError = 'Refusing network cleanup: immutable identity does not match';
  deepStrictEqual(network.Name, name, identityError);
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error(identityError);
  deepStrictEqual(id, expectedId ?? id, identityError);
  const labels = network.Labels;
  if (typeof labels !== 'object' || labels === null || Array.isArray(labels))
    throw new Error('Refusing network cleanup: invocation label does not match');
  for (const [label, expected] of Object.entries(ownership)) {
    deepStrictEqual(
      Reflect.get(labels, label),
      expected,
      'Refusing network cleanup: invocation label does not match',
    );
  }
  deepStrictEqual(
    network.Containers,
    {},
    'Refusing network cleanup: network is not verified empty',
  );
  const exact = ['network', 'inspect', id];
  deepStrictEqual(networkDocument(command(exact, 30_000), exact), network);
  const remove = ['network', 'rm', id];
  output(command(remove, 30_000), remove);
  for (const target of [name, id]) {
    if (!isAbsentResource(command(['network', 'inspect', target], 30_000), 'network', target))
      throw new Error('Owned network remains after cleanup');
  }
}

function removeOwned(
  command: DockerCommand,
  kind: 'container' | 'image' | 'volume' | 'network',
  name: string,
  runId: string,
  ownership?: Readonly<Record<string, string>>,
  networkId?: string,
): void {
  if (kind === 'network') {
    removeOwnedNetwork(command, name, ownership ?? { [OWNER_LABEL]: runId }, networkId);
    return;
  }
  const labels = kind === 'volume' ? '.Labels' : '.Config.Labels';
  const expected = ownership ?? { [OWNER_LABEL]: runId };
  for (const [label, value] of Object.entries(expected)) {
    const args = [kind, 'inspect', '--format', `{{ index ${labels} "${label}" }}`, name];
    const result = command(args, 30_000);
    if (isAbsentResource(result, kind, name)) return;
    if (output(result, args).replace(/\r?\n$/, '') !== value) {
      throw new Error(`Refusing cleanup of ${kind} ${name}: invocation label does not match`);
    }
  }
  const remove = [kind, 'rm', ...(kind === 'container' ? ['--force'] : []), name];
  output(command(remove, 30_000), remove);
  if (ownership !== undefined) {
    const absent = command([kind, 'inspect', name], 30_000);
    if (!isAbsentResource(absent, kind, name)) {
      throw new Error(`Owned ${kind} remains after cleanup`);
    }
  }
}

function assertOfflineContainerConfiguration(command: DockerCommand, container: string): void {
  const network = ['container', 'inspect', '--format', '{{.HostConfig.NetworkMode}}', container];
  const mode = output(command(network, 30_000), network).replace(/\r?\n$/, '');
  if (mode !== 'none') throw new Error(`Expected offline Docker network none, got ${mode}`);
  const user = ['container', 'inspect', '--format', '{{.Config.User}}', container];
  const configuredUser = output(command(user, 30_000), user).replace(/\r?\n$/, '');
  if (configuredUser !== 'dsh') {
    throw new Error(`Expected default Docker user dsh, got ${configuredUser}`);
  }
}

type Probe = 'version' | 'offline-docx' | 'profile-seed';
export interface UserImageLifecycle {
  readonly command: DockerCommand;
  readonly imageId: string;
  readonly runId: string;
  readonly stateVolume: string;
  readonly workVolume: string;
  readonly overlayDirectory: string;
  readonly seccomp: string;
  readonly repositoryRoot: string;
  registerContainer: (name: string) => void;
  registerResource: (
    kind: 'container' | 'volume' | 'image' | 'network',
    name: string,
    ownership: Readonly<Record<string, string>>,
  ) => void;
  removeNetwork: (name: string, id: string) => void;
}
export type UserImageScenario = (lifecycle: UserImageLifecycle) => Promise<string>;
interface CleanupTarget {
  readonly kind: 'container' | 'image' | 'volume' | 'network';
  readonly name: string;
  readonly ownership?: Readonly<Record<string, string>>;
  networkId?: string;
}

function runContainer(
  command: DockerCommand,
  targets: CleanupTarget[],
  probe: Probe,
  container: string,
  imageId: string,
  runId: string,
  volume: string | undefined,
  phase: 'fresh' | 'reuse',
): string {
  const offline = probe !== 'version';
  const script = probe === 'profile-seed' ? profileSeedScript : offlineDocxScript;
  if (volume !== undefined) {
    const inspectVolume = [
      'volume',
      'inspect',
      '--format',
      `{{ index .Labels "${OWNER_LABEL}" }}`,
      volume,
    ];
    if (output(command(inspectVolume, 30_000), inspectVolume).replace(/\r?\n$/, '') !== runId) {
      throw new Error('Refusing use of state volume: invocation label does not match');
    }
  }
  const create = [
    'create',
    ...(offline ? ['--network', 'none'] : []),
    ...(volume === undefined ? [] : ['--mount', `type=volume,source=${volume},target=/data/home`]),
    '--name',
    container,
    '--label',
    `${OWNER_LABEL}=${runId}`,
    imageId,
    ...(offline ? ['python3', '-c', script, phase] : ['dsh', '--version']),
  ];
  targets.push({ kind: 'container', name: container });
  output(command(create, 30_000), create);
  if (offline) assertOfflineContainerConfiguration(command, container);
  if (volume !== undefined) {
    const inspect = ['container', 'inspect', '--format', '{{json .Mounts}}', container];
    const mounts: unknown = JSON.parse(output(command(inspect, 30_000), inspect));
    if (
      !Array.isArray(mounts) ||
      !mounts.some(
        (mount: unknown) =>
          typeof mount === 'object' &&
          mount !== null &&
          'Type' in mount &&
          mount.Type === 'volume' &&
          'Name' in mount &&
          mount.Name === volume &&
          'Destination' in mount &&
          mount.Destination === '/data/home' &&
          'RW' in mount &&
          mount.RW === true,
      )
    ) {
      throw new Error('Profile probe requires the owned writable named volume at /data/home');
    }
  }
  const start = ['start', '--attach', container];
  const stdout = output(command(start, 30_000), start);
  const wait = ['wait', container];
  const exit = output(command(wait, 30_000), wait).replace(/\r?\n$/, '');
  if (exit !== '0') throw new Error(`${probe} container exited ${exit}:\n${stdout}`);
  return stdout;
}

function createOwnedVolumes(
  command: DockerCommand,
  targets: CleanupTarget[],
  runId: string,
  names: (string | undefined)[],
): void {
  for (const name of names) {
    if (name === undefined) continue;
    const args = ['volume', 'create', '--label', `${OWNER_LABEL}=${runId}`, name];
    targets.push({ kind: 'volume', name });
    output(command(args, 30_000), args);
  }
}

function lifecycleVolumes(
  probe: Probe | 'web-startup' | 'managed-policy' | 'container-start',
  runId: string,
): { volume: string | undefined; workVolume: string | undefined } {
  if (probe === 'container-start') {
    const userId = runId.replaceAll('-', '').slice(0, 12);
    return { volume: `dsh-team-home-${userId}`, workVolume: `dsh-team-work-${userId}` };
  }
  const volume =
    probe === 'profile-seed' || probe === 'web-startup' || probe === 'managed-policy'
      ? `dsh-team-test-${runId}-state`
      : undefined;
  const workVolume =
    probe === 'web-startup' || probe === 'managed-policy'
      ? `dsh-team-test-${runId}-work`
      : undefined;
  return { volume, workVolume };
}

function cleanupTargets(
  command: DockerCommand,
  targets: readonly CleanupTarget[],
  runId: string,
  failures: unknown[],
): void {
  // Containers before networks, then their persistent volumes and images; each remains exact-owned.
  for (const kind of ['container', 'network', 'volume', 'image'] as const) {
    for (const target of targets.filter((candidate) => candidate.kind === kind).reverse()) {
      try {
        removeOwned(command, kind, target.name, runId, target.ownership, target.networkId);
      } catch (error) {
        failures.push(error);
      }
    }
  }
}

interface UserImageResult {
  runId: string;
  image: string;
  container: string;
  stdout: string;
  volume?: string;
  workVolume?: string;
  containers: string[];
}

function lifecycleCommand(
  probe: Probe | 'web-startup' | 'managed-policy' | 'container-start',
  injectedCommand: DockerCommand | undefined,
  config: string,
): DockerCommand {
  const bounded =
    probe === 'web-startup' || probe === 'managed-policy' || probe === 'container-start';
  const externalCommand: DockerCommand =
    injectedCommand ??
    ((args, timeout) =>
      spawnSync('docker', args, {
        cwd: repositoryRoot,
        // Docker gets no GitHub/SSH/model credentials or user Docker config from the parent.
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', DOCKER_CONFIG: config },
        encoding: 'utf8',
        timeout,
        killSignal: 'SIGKILL',
        // Startup logs and process observations must be bounded and stay in memory.
        maxBuffer: bounded && args[0] !== 'build' ? 64 * 1024 : 16 * 1024 * 1024,
      }));
  if (!bounded) return externalCommand;
  return (args, timeout) => {
    try {
      const result = externalCommand(args, timeout);
      const kind = args[0];
      if (
        args[1] === 'inspect' &&
        (kind === 'image' || kind === 'container' || kind === 'volume' || kind === 'network') &&
        isAbsentResource(result, kind, args.at(-1) ?? '')
      ) {
        return result;
      }
      if (result.error !== undefined || result.status !== 0) {
        return {
          status: result.status === 0 ? 1 : result.status,
          stdout: '',
          stderr: 'Web Docker operation failed',
        };
      }
      return result;
    } catch {
      throw new Error('Web Docker operation failed');
    }
  };
}

export function runUserImage(
  probe: 'web-startup',
  assertOutput: (stdout: string) => void,
  injectedCommand?: DockerCommand,
  webBoundary?: Partial<WebStartupBoundary>,
): Promise<UserImageResult>;
export function runUserImage(
  probe: Probe,
  assertOutput: (stdout: string) => void,
  injectedCommand?: DockerCommand,
): UserImageResult;
export function runUserImage(
  probe: 'managed-policy' | 'container-start',
  assertOutput: (stdout: string) => void,
  injectedCommand: DockerCommand | undefined,
  scenario: UserImageScenario,
): Promise<UserImageResult>;
export function runUserImage(
  probe: Probe | 'web-startup' | 'managed-policy' | 'container-start',
  assertOutput: (stdout: string) => void,
  injectedCommand?: DockerCommand,
  extra?: Partial<WebStartupBoundary> | UserImageScenario,
): UserImageResult | Promise<UserImageResult> {
  if (probe === 'web-startup') {
    return Promise.resolve().then(() =>
      runImageLifecycle(probe, assertOutput, injectedCommand, extra as Partial<WebStartupBoundary>),
    );
  }
  if (probe === 'managed-policy' || probe === 'container-start') {
    return Promise.resolve().then(() =>
      runImageLifecycle(probe, assertOutput, injectedCommand, extra as UserImageScenario),
    );
  }
  return runImageLifecycle(probe, assertOutput, injectedCommand);
}

function runImageLifecycle(
  probe: Probe | 'web-startup' | 'managed-policy' | 'container-start',
  assertOutput: (stdout: string) => void,
  injectedCommand?: DockerCommand,
  extra?: Partial<WebStartupBoundary> | UserImageScenario,
): UserImageResult | Promise<UserImageResult> {
  const runId = randomUUID();
  const image = `dsh-team-test-${runId}:${probe}`;
  const container = `dsh-team-test-${runId}-${probe}`;
  const { volume, workVolume } = lifecycleVolumes(probe, runId);
  const containers = [container];
  const config = mkdtempSync(join(tmpdir(), 'dsh-team-test-docker-'));
  const command = lifecycleCommand(probe, injectedCommand, config);
  const failures: unknown[] = [];
  const targets: CleanupTarget[] = [];
  let stdout = '';
  function finish(): UserImageResult {
    cleanupTargets(command, targets, runId, failures);
    if (
      targets.some(
        (target) => target.kind === 'network' && target.ownership?.[OWNER_LABEL] === runId,
      )
    ) {
      try {
        const inventory = [
          'network',
          'ls',
          '--filter',
          `label=${OWNER_LABEL}=${runId}`,
          '--quiet',
          '--no-trunc',
        ];
        if (output(command(inventory, 30_000), inventory).trim() !== '')
          throw new Error('Invocation network inventory remains after cleanup');
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      rmSync(config, { recursive: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length !== 0) {
      const messages = failures.flatMap((error) => nestedMessages(error));
      throw new AggregateError(failures, messages.join('\n'));
    }
    return {
      runId,
      image,
      container,
      stdout,
      containers,
      ...(volume === undefined ? {} : { volume }),
      ...(workVolume === undefined ? {} : { workVolume }),
    };
  }
  try {
    const prerequisite = ['version', '--format', '{{.Server.Version}}'];
    if (output(command(prerequisite, 10_000), prerequisite).trim() === '') {
      throw new Error('Docker daemon version prerequisite returned no version');
    }
    const build = [
      'build',
      '--label',
      `${OWNER_LABEL}=${runId}`,
      '--tag',
      image,
      '--file',
      join(repositoryRoot, 'images/dsh-user/Dockerfile'),
      '--build-context',
      `zh-locale=${join(repositoryRoot, 'plugins/zh-locale')}`,
      '--build-context',
      `permission-tiers=${join(repositoryRoot, 'plugins/permission-tiers')}`,
      // Keep the primary context narrow: no repository-root files or secrets.
      join(repositoryRoot, 'images/dsh-user'),
    ];
    // Register ownership before potentially partial build/create operations.
    targets.push({ kind: 'image', name: image });
    output(command(build, 600_000), build);
    const inspect = ['image', 'inspect', '--format', '{{.Id}}', image];
    const imageId = output(command(inspect, 30_000), inspect).replace(/\r?\n$/, '');
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) {
      throw new Error('Built Docker image did not return an exact image identity');
    }
    if (probe !== 'container-start')
      createOwnedVolumes(command, targets, runId, [volume, workVolume]);
    if (probe === 'web-startup') {
      if (volume === undefined || workVolume === undefined)
        throw new Error('Web volume setup missing');
      const overlay = join(config, 'web.patch.yml');
      writeFileSync(overlay, '- id: webserver\n  config:\n    host: 0.0.0.0\n    port: 3080\n', {
        mode: 0o444,
      });
      targets.push({ kind: 'container', name: container });
      return runWebStartup(
        command,
        {
          container,
          imageId,
          runId,
          stateVolume: volume,
          workVolume,
          overlay,
          seccomp: join(repositoryRoot, 'images/seccomp/dsh-user.json'),
        },
        extra as Partial<WebStartupBoundary>,
      )
        .then((summary) => {
          stdout = summary;
          assertOutput(summary);
        })
        .catch((error: unknown) => {
          failures.push(error);
        })
        .then(finish);
    }
    if (probe === 'managed-policy' || probe === 'container-start') {
      if (volume === undefined || workVolume === undefined)
        throw new Error('Image scenario volume setup missing');
      if (typeof extra !== 'function') throw new Error('Image scenario missing');
      const overlayDirectory = join(config, 'managed');
      const lifecycle: UserImageLifecycle = {
        command,
        imageId,
        runId,
        stateVolume: volume,
        workVolume,
        overlayDirectory,
        seccomp: join(repositoryRoot, 'images/seccomp/dsh-user.json'),
        repositoryRoot,
        registerContainer: (name: string): void => {
          if (!containers.includes(name)) containers.push(name);
          targets.push({ kind: 'container', name });
        },
        registerResource: (kind, name, ownership): void => {
          if (!name.startsWith('dsh-team-') || Object.keys(ownership).length === 0)
            throw new Error('Acceptance target requires exact owned identity');
          if (targets.some((target) => target.kind === kind && target.name === name)) return;
          const absent = command([kind, 'inspect', name], 30_000);
          if (!isAbsentResource(absent, kind, name))
            throw new Error('Acceptance resource already exists; refusing cleanup authority');
          targets.push({ kind, name, ownership });
        },
        removeNetwork: (name, id): void => {
          const target = targets.find((entry) => entry.kind === 'network' && entry.name === name);
          if (target === undefined) throw new Error('Network cleanup target was not registered');
          target.networkId = id;
          removeOwned(command, 'network', name, runId, target.ownership, id);
        },
      };
      return extra(lifecycle)
        .then((summary) => {
          stdout = summary;
          assertOutput(summary);
        })
        .catch((error: unknown) => {
          failures.push(error);
        })
        .then(finish);
    }
    stdout = runContainer(command, targets, probe, container, imageId, runId, volume, 'fresh');
    assertOutput(stdout);
    if (volume !== undefined) {
      const reusedContainer = `${container}-reuse`;
      containers.push(reusedContainer);
      stdout = runContainer(
        command,
        targets,
        probe,
        reusedContainer,
        imageId,
        runId,
        volume,
        'reuse',
      );
      assertOutput(stdout);
    }
  } catch (error) {
    failures.push(error);
  }
  return finish();
}
