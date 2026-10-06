import { deepStrictEqual } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { profileSeedScript } from './profile-seed-fixture.ts';

export interface DockerCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

/** External Docker process boundary; timeout is milliseconds, no shell interpolation. */
export type DockerCommand = (args: readonly string[], timeout: number) => DockerCommandResult;
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

function removeOwned(
  command: DockerCommand,
  kind: 'container' | 'image' | 'volume',
  name: string,
  runId: string,
): void {
  const labels = kind === 'volume' ? '.Labels' : '.Config.Labels';
  const args = [kind, 'inspect', '--format', `{{ index ${labels} "${OWNER_LABEL}" }}`, name];
  const result = command(args, 30_000);
  if (result.error !== undefined || result.status === null) {
    output(result, args);
  }
  const absent = [kind, 'object'].some((missingKind) =>
    ['Error response from daemon:', 'Error:'].some(
      (prefix) =>
        result.stderr.replace(/\r?\n$/, '') === `${prefix} No such ${missingKind}: ${name}`,
    ),
  );
  const absentVolume =
    kind === 'volume' &&
    result.stderr.replace(/\r?\n$/, '') ===
      `Error response from daemon: get ${name}: no such volume`;
  if (
    result.error === undefined &&
    result.status === 1 &&
    result.stdout === '' &&
    (absent || absentVolume)
  ) {
    return;
  }
  if (output(result, args).replace(/\r?\n$/, '') !== runId) {
    throw new Error(`Refusing cleanup of ${kind} ${name}: invocation label does not match`);
  }
  const remove = [kind, 'rm', ...(kind === 'container' ? ['--force'] : []), name];
  output(command(remove, 30_000), remove);
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
interface CleanupTarget {
  readonly kind: 'container' | 'image' | 'volume';
  readonly name: string;
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

function cleanupTargets(
  command: DockerCommand,
  targets: readonly CleanupTarget[],
  runId: string,
  failures: unknown[],
): void {
  // Containers first, then their state volume, then image. Each target remains exact-owned.
  for (const kind of ['container', 'volume', 'image'] as const) {
    for (const target of targets.filter((candidate) => candidate.kind === kind).reverse()) {
      try {
        removeOwned(command, kind, target.name, runId);
      } catch (error) {
        failures.push(error);
      }
    }
  }
}

export function runUserImage(
  probe: Probe,
  assertOutput: (stdout: string) => void,
  injectedCommand?: DockerCommand,
): {
  runId: string;
  image: string;
  container: string;
  stdout: string;
  volume?: string;
  containers: string[];
} {
  const runId = randomUUID();
  const image = `dsh-team-test-${runId}:${probe}`;
  const container = `dsh-team-test-${runId}-${probe}`;
  const volume = probe === 'profile-seed' ? `dsh-team-test-${runId}-state` : undefined;
  const containers = [container];
  const config = mkdtempSync(join(tmpdir(), 'dsh-team-test-docker-'));
  const command: DockerCommand =
    injectedCommand ??
    ((args, timeout) =>
      spawnSync('docker', args, {
        cwd: repositoryRoot,
        // Docker gets no GitHub/SSH/model credentials or user Docker config from the parent.
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', DOCKER_CONFIG: config },
        encoding: 'utf8',
        timeout,
        killSignal: 'SIGKILL',
        maxBuffer: 16 * 1024 * 1024,
      }));
  const failures: unknown[] = [];
  const targets: CleanupTarget[] = [];
  let stdout = '';
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
      // Match existing probes; this Dockerfile needs no repository-root files or secrets.
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
    if (volume !== undefined) {
      const createVolume = ['volume', 'create', '--label', `${OWNER_LABEL}=${runId}`, volume];
      targets.push({ kind: 'volume', name: volume });
      output(command(createVolume, 30_000), createVolume);
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
  } finally {
    cleanupTargets(command, targets, runId, failures);
    try {
      rmSync(config, { recursive: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length !== 0) {
    const messages = failures.map((error) =>
      error instanceof Error ? error.message : String(error),
    );
    throw new AggregateError(failures, messages.join('\n'));
  }
  return {
    runId,
    image,
    container,
    stdout,
    containers,
    ...(volume === undefined ? {} : { volume }),
  };
}
