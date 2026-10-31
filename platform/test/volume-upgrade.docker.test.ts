import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { applyMigrations, openDatabase } from '../src/db/index.ts';
import { writeManagedConfig } from '../src/managed-config/index.ts';
import { createOrchestrator } from '../src/orchestrator/index.ts';
import {
  bridgeAddress,
  createStandInPlatform,
  inspectAsync,
  instanceRpcScript,
  record,
  runNetworkAcceptance,
  startDockerInstance,
  startupClient,
  volumeProbe,
} from './container-start-docker-fixture.ts';
import { isAbsentResource } from './docker-command.ts';
import { lifecycleWebNetwork, qualifyHostSession } from './managed-policy-fixture.ts';
import {
  completeOwnedTurn,
  mappedSessionRpc,
  OWNED_COMPLETION_URL,
  ownedCompletionInstallScript,
  ownedCompletionRows,
  ownedTurnCompleted,
  sessionEvents,
} from './owned-completion-fixture.ts';
import type { SessionRpc } from './owned-completion-fixture.ts';
import { profileSeedOracle, profileSeedScript } from './profile-seed-fixture.ts';
import { PLUGIN_CONTEXTS, userImageBuildArgs } from './user-image-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';
import { execWebScript, runWebStartup, webAddress } from './web-startup-fixture.ts';
import type { WebContainer } from './web-startup-fixture.ts';

// The pre-upgrade main commit (this branch's parent): its user image is the real stage-1 image.
const STAGE1_COMMIT = '3482a5205be018c0716b5bd4e7718023f8e3af98';
const HOST = 'dsh-team-managed.invalid';
const AUTHORITY = 'volume-upgrade.example:8443';
const KEY_ENV = 'DMXAPI_KEY';
const MARKER = '/data/work/dsh-team-legacy-marker.txt';
const MARKER_BODY = 'stage-1 workspace file survives the DSH 0.2.1-rc.2 upgrade\n';
const PROMPT = 'stage-1 Session survives the DSH 0.2.1-rc.2 upgrade';
// 0.2.0-rc.2 announced its loopback URL plus a LAN suffix; 0.2.1 parsing rejects this line.
const STAGE1_LAUNCH =
  /(?:^|\r?\n)dsh web: http:\/\/127\.0\.0\.1:3080\/\?token=([A-Za-z0-9_-]+)(?: \(LAN: http:\/\/[^\s/?]+:3080\/\?token=[A-Za-z0-9_-]+\))?(?:\r?\n|$)/;

function stage1Token(logs: string): string | undefined {
  return STAGE1_LAUNCH.exec(logs)?.[1];
}

function docker(lifecycle: UserImageLifecycle, args: string[], timeout = 30_000): string {
  const result = lifecycle.command(args, timeout);
  if (result.status !== 0 || result.error !== undefined)
    throw new Error(`Volume upgrade Docker ${args[0] ?? 'operation'} failed`);
  return result.stdout;
}

/** `git archive <commit> <user-image sources> | tar -x`; a missing object fails, never skips. */
function extractStage1Sources(repositoryRoot: string, directory: string): void {
  const paths = ['images/dsh-user', ...PLUGIN_CONTEXTS.map((plugin) => `plugins/${plugin}`)];
  const archive = spawnSync('git', ['-C', repositoryRoot, 'archive', STAGE1_COMMIT, ...paths], {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (archive.status !== 0 || archive.error !== undefined)
    throw new Error(`Stage-1 commit ${STAGE1_COMMIT} is not available in this checkout`);
  const extract = spawnSync('tar', ['-x', '-C', directory], { input: archive.stdout });
  if (extract.status !== 0 || extract.error !== undefined)
    throw new Error('Stage-1 source extraction failed');
  const dockerfile = readFileSync(join(directory, 'images/dsh-user/Dockerfile'), 'utf8');
  if (!dockerfile.includes('@deepseek-ai/dsh@0.2.0-rc.2'))
    throw new Error('Stage-1 Dockerfile must pin @deepseek-ai/dsh@0.2.0-rc.2');
}

function buildStage1Image(lifecycle: UserImageLifecycle, sources: string): string {
  // Explicit tag: Docker reports an untagged missing name as `<name>:latest`, which the exact
  // absence predicate would not match.
  const tag = `dsh-team-test-${lifecycle.runId}:legacy-0.2.0-rc.2`;
  lifecycle.registerResource('image', tag, { 'dsh-team.test-run': lifecycle.runId });
  docker(lifecycle, userImageBuildArgs(lifecycle.runId, tag, undefined, sources), 600_000);
  const imageId = docker(lifecycle, ['image', 'inspect', '--format', '{{.Id}}', tag]).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('Stage-1 image identity missing');
  const probe = `dsh-team-test-${lifecycle.runId}-legacy-version`;
  lifecycle.registerContainer(probe);
  const version = docker(lifecycle, [
    'run',
    '--rm',
    '--name',
    probe,
    '--label',
    `dsh-team.test-run=${lifecycle.runId}`,
    '--network',
    'none',
    imageId,
    'dsh',
    '--version',
  ]).trim();
  if (version !== '0.2.0-rc.2') throw new Error(`Stage-1 image reports DSH ${version}`);
  return imageId;
}

/** Orchestrator volume names/labels, pre-created and first mounted (copy-up) by stage 1. */
function initializeStage1Volumes(lifecycle: UserImageLifecycle, userId: string, image: string) {
  const ownership = { 'dsh-team.user': userId, 'dsh-team.test-run': lifecycle.runId };
  for (const volume of [lifecycle.stateVolume, lifecycle.workVolume]) {
    lifecycle.registerResource('volume', volume, ownership);
    docker(lifecycle, [
      'volume',
      'create',
      ...Object.entries(ownership).flatMap(([label, value]) => ['--label', `${label}=${value}`]),
      volume,
    ]);
  }
  const init = `dsh-team-test-${lifecycle.runId}-legacy-init`;
  lifecycle.registerContainer(init);
  docker(lifecycle, [
    'run',
    '--rm',
    '--name',
    init,
    '--label',
    `dsh-team.test-run=${lifecycle.runId}`,
    '--network',
    'none',
    '--mount',
    `type=volume,source=${lifecycle.stateVolume},target=/data/home`,
    '--mount',
    `type=volume,source=${lifecycle.workVolume},target=/data/work`,
    image,
    'node',
    '--input-type=module',
    '-e',
    ownedCompletionInstallScript(),
  ]);
}

/** Session headers of every plain JSONL generation of one Session, observed read-only. */
function sessionHeaderScript(sessionId: string): string {
  return `
import { createHash } from 'node:crypto';
import { closeSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
const headers = [];
const walk = (directory, depth) => {
  if (depth > 6) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, depth + 1);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      const handle = openSync(path, 'r');
      const buffer = Buffer.alloc(65536);
      const length = readSync(handle, buffer, 0, buffer.length, 0);
      closeSync(handle);
      try {
        const header = JSON.parse(buffer.subarray(0, length).toString('utf8').split('\\n')[0]);
        if (header.type === 'session' && header.id === ${JSON.stringify(sessionId)})
          headers.push({ file: entry.name, formatVersion: header.version });
      } catch {}
    }
  }
};
walk('/data/home/sessions', 0);
const profile = readFileSync('/data/home/profiles/web/package.json');
process.stdout.write(JSON.stringify({
  headers: headers.sort((left, right) => left.file.localeCompare(right.file)),
  bundles: JSON.parse(profile).dsh?.profile?.bundles ?? null,
  profileSha256: createHash('sha256').update(profile).digest('hex'),
  marker: readFileSync(${JSON.stringify(MARKER)}, 'utf8'),
}));`;
}

/** Stage-1 Web on its own bridge with a wildcard overlay; one real Session and one owned turn. */
async function stage1Session(lifecycle: UserImageLifecycle, image: string) {
  const network = lifecycleWebNetwork(lifecycle, 'legacy');
  const overlay = await writeManagedConfig(
    lifecycle.overlayDirectory,
    'stageoneweb1',
    JSON.stringify([
      // 0.2.0-rc.2 accepts only 127.0.0.1 or 0.0.0.0; loopback is unreachable via publication.
      { id: 'webserver', config: { host: '0.0.0.0', port: 3080 } },
      {
        id: 'llm-pi-ai',
        config: {
          providers: {
            intranet: {
              displayName: '内网模型',
              apiKeyEnv: KEY_ENV,
              api: 'openai-completions',
              baseURL: OWNED_COMPLETION_URL,
              models: [{ id: 'owned', name: 'owned' }],
            },
          },
        },
      },
      { id: 'agent-default-model', config: { provider: 'intranet', model: 'owned' } },
      ...ownedCompletionRows(),
    ]),
  );
  const container: WebContainer = {
    container: `dsh-team-test-${lifecycle.runId}-legacy-web`,
    imageId: image,
    runId: lifecycle.runId,
    stateVolume: lifecycle.stateVolume,
    workVolume: lifecycle.workVolume,
    overlay,
    seccomp: lifecycle.seccomp,
    network,
    trustedHost: HOST,
    env: { [KEY_ENV]: 'stage1-owned-nonsecret' },
    announced: (logs) => stage1Token(logs) !== undefined,
  };
  lifecycle.registerContainer(container.container);
  const startup = record(JSON.parse(await runWebStartup(lifecycle.command, container)));
  const logs = docker(lifecycle, ['logs', '--tail', '50', container.container]);
  if (typeof startup.hostPort !== 'number') throw new Error('Stage-1 Web publication missing');
  const host = await qualifyHostSession(
    startup.hostPort,
    logs,
    webAddress(network),
    stage1Token(logs),
  );
  const sessionId = await completeOwnedTurn(mappedSessionRpc(host.origin, host.cookie), PROMPT);
  execWebScript(
    lifecycle.command,
    container,
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(MARKER)}, ${JSON.stringify(MARKER_BODY)});`,
  );
  const observed = record(
    JSON.parse(execWebScript(lifecycle.command, container, sessionHeaderScript(sessionId))),
  );
  docker(lifecycle, ['stop', container.container]);
  docker(lifecycle, ['rm', container.container]);
  return { sessionId, observed };
}

/** 0.2.1 reads the stage-1 profile bundles as incompatible; the read-only mount keeps them. */
function skippedBeforeReset(lifecycle: UserImageLifecycle): Record<string, unknown> {
  const name = `dsh-team-test-${lifecycle.runId}-legacy-dump`;
  lifecycle.registerContainer(name);
  return record(
    JSON.parse(
      docker(
        lifecycle,
        [
          'run',
          '--rm',
          '--name',
          name,
          '--label',
          `dsh-team.test-run=${lifecycle.runId}`,
          '--network',
          'none',
          '--mount',
          `type=volume,source=${lifecycle.stateVolume},target=/data/home,readonly,volume-nocopy`,
          lifecycle.imageId,
          'python3',
          '-c',
          `
import json, subprocess
run = subprocess.run(["dsh", "--profile", "web", "--dump-default-config"], capture_output=True, timeout=60)
lines = run.stderr.decode("utf-8", "replace").splitlines()
print(json.dumps({"exit": run.returncode, "skippingBundle": any(line.startswith("dsh: skipping profile bundle") for line in lines)}))
`,
        ],
        90_000,
      ),
    ),
  );
}

async function upgradeScenario(lifecycle: UserImageLifecycle): Promise<string> {
  const userId = lifecycle.runId.replaceAll('-', '').slice(0, 12);
  const sources = mkdtempSync(join(tmpdir(), 'dsh-team-test-stage1-'));
  const database = openDatabase(join(dirname(lifecycle.overlayDirectory), 'volume-upgrade.db'));
  const platformName = `dsh-team-test-platform-${lifecycle.runId}`;
  const { client } = startupClient(lifecycle);
  const owner = createOrchestrator({
    client,
    database,
    config: loadConfig({
      PLATFORM_PUBLIC_URL: `http://${AUTHORITY}`,
      PLATFORM_CONTAINER_NAME: platformName,
    }),
  });
  try {
    extractStage1Sources(lifecycle.repositoryRoot, sources);
    const stage1Image = buildStage1Image(lifecycle, sources);
    initializeStage1Volumes(lifecycle, userId, stage1Image);
    const stage1 = await stage1Session(lifecycle, stage1Image);
    expect(stage1.observed.marker).toBe(MARKER_BODY);
    const dump = skippedBeforeReset(lifecycle);
    expect(dump.skippingBundle).toBe(true);

    applyMigrations(database);
    lifecycle.registerResource('container', `dsh-team-u-${userId}`, { 'dsh-team.user': userId });
    database
      .prepare("INSERT INTO users VALUES (?, ?, 'unused', 'employee', 'active', 1)")
      .run(userId, `${userId}@volume-upgrade.example`);
    // A stage-1 account at rest: a stopped row without a container, as retirement leaves it.
    database.prepare("INSERT INTO instances(user_id,status) VALUES (?,'stopped')").run(userId);
    createStandInPlatform(lifecycle, platformName);
    const restore = () =>
      owner.restoreUserProfiles({
        userId,
        config: { userImage: lifecycle.imageId, seccompProfilePath: lifecycle.seccomp },
      });
    await restore();
    profileSeedOracle()(await volumeProbe(lifecycle, userId, profileSeedScript, 'fresh'));
    // The oracle's own uid1001 edit probe changed the live profile; reset it once more.
    await restore();
    const started = await startDockerInstance(owner, lifecycle, userId, AUTHORITY);
    const container = await inspectAsync(lifecycle, started.containerId);
    expect(container.Image).toBe(lifecycle.imageId);
    const row = record(database.prepare('SELECT * FROM instances WHERE user_id=?').get(userId));
    expect(row.status).toBe('running');
    if (typeof row.dsh_cookie !== 'string') throw new Error('Upgraded instance not authenticated');
    const exec = async (script: string) => {
      const result = await lifecycle.commandAsync(
        [
          'exec',
          '--user',
          '1001',
          started.containerId,
          'node',
          '--input-type=module',
          '-e',
          script,
        ],
        15_000,
      );
      if (result.status !== 0 || result.error !== undefined)
        throw new Error('Upgraded instance probe failed');
      return result.stdout;
    };
    const target = {
      host: bridgeAddress(container, userId),
      authority: AUTHORITY,
      origin: `http://${AUTHORITY}`,
      cookie: row.dsh_cookie,
    };
    const rpc: SessionRpc = async (method, args) =>
      record(JSON.parse(await exec(instanceRpcScript(target, method, args, randomUUID()))));
    const list = await rpc('session/list', { _request: {} });
    expect(
      Array.isArray(list.items) &&
        list.items.some((item: unknown) => record(item).sessionId === stage1.sessionId),
    ).toBe(true);
    expect(ownedTurnCompleted(await sessionEvents(rpc, stage1.sessionId), PROMPT)).toBe(true);
    const upgraded = record(JSON.parse(await exec(sessionHeaderScript(stage1.sessionId))));
    expect(upgraded.marker).toBe(MARKER_BODY);

    const networkId = String(
      record(record(record(container.NetworkSettings).Networks)[`dsh-team-net-${userId}`])
        .NetworkID,
    );
    await owner.stopUserContainer({ userId, reason: 'admin' });
    for (const [kind, id] of [
      ['container', started.containerId],
      ['network', networkId],
    ] as const)
      expect(isAbsentResource(lifecycle.command([kind, 'inspect', id], 15_000), kind, id)).toBe(
        true,
      );
    return JSON.stringify({
      stage1: {
        dsh: '0.2.0-rc.2',
        bundles: stage1.observed.bundles,
        profileSha256: stage1.observed.profileSha256,
        sessionHeaders: stage1.observed.headers,
      },
      skippedBeforeReset: dump.skippingBundle,
      dumpExit: dump.exit,
      profilesEqual: true,
      markerIntact: true,
      sessionReadable: true,
      upgraded: {
        bundles: upgraded.bundles,
        profileSha256: upgraded.profileSha256,
        sessionHeaders: upgraded.headers,
      },
      retired: true,
    });
  } finally {
    await owner.drain();
    database.close();
    rmSync(sources, { recursive: true, force: true });
  }
}

it('resets a stage-1 DSH 0.2.0-rc.2 volume pair to the 0.2.1-rc.2 seed and keeps its Session and files', async () => {
  await runNetworkAcceptance(upgradeScenario, 'volume upgrade', (summary) => {
    expect(JSON.parse(summary)).toMatchObject({
      stage1: { dsh: '0.2.0-rc.2' },
      skippedBeforeReset: true,
      profilesEqual: true,
      markerIntact: true,
      sessionReadable: true,
      retired: true,
    });
  });
});
