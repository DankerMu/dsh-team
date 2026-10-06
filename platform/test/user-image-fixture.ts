import { deepStrictEqual } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  kind: 'container' | 'image',
  name: string,
  runId: string,
): void {
  const args = [kind, 'inspect', '--format', `{{ index .Config.Labels "${OWNER_LABEL}" }}`, name];
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
  if (result.error === undefined && result.status === 1 && result.stdout === '' && absent) {
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

export function runUserImage(
  probe: 'version' | 'offline-docx',
  assertOutput: (stdout: string) => void,
  injectedCommand?: DockerCommand,
): { runId: string; image: string; container: string; stdout: string } {
  const runId = randomUUID();
  const image = `dsh-team-test-${runId}:${probe}`;
  const container = `dsh-team-test-${runId}-${probe}`;
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
  let imageAttempted = false;
  let containerAttempted = false;
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
    imageAttempted = true;
    output(command(build, 600_000), build);
    const inspect = ['image', 'inspect', '--format', '{{.Id}}', image];
    const imageId = output(command(inspect, 30_000), inspect).replace(/\r?\n$/, '');
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) {
      throw new Error('Built Docker image did not return an exact image identity');
    }
    const create = [
      'create',
      ...(probe === 'offline-docx' ? ['--network', 'none'] : []),
      '--name',
      container,
      '--label',
      `${OWNER_LABEL}=${runId}`,
      imageId,
      ...(probe === 'offline-docx' ? ['python3', '-c', offlineDocxScript] : ['dsh', '--version']),
    ];
    containerAttempted = true;
    output(command(create, 30_000), create);
    if (probe === 'offline-docx') {
      assertOfflineContainerConfiguration(command, container);
    }
    const start = ['start', '--attach', container];
    stdout = output(command(start, 30_000), start);
    const wait = ['wait', container];
    const exit = output(command(wait, 30_000), wait).replace(/\r?\n$/, '');
    if (exit !== '0') {
      throw new Error(`${probe} container exited ${exit}:\n${stdout}`);
    }
    assertOutput(stdout);
  } catch (error) {
    failures.push(error);
  } finally {
    for (const [kind, name, attempted] of [
      ['container', container, containerAttempted],
      ['image', image, imageAttempted],
    ] as const) {
      if (!attempted) continue;
      try {
        removeOwned(command, kind, name, runId);
      } catch (error) {
        failures.push(error);
      }
    }
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
  return { runId, image, container, stdout };
}
