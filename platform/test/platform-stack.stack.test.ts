import { realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { readPrivateJsonFile } from '../../scripts/docker-proxy-environment.mjs';
import { SEED_DATASETS, readSeedDatasets } from '../../scripts/seed-stack.mjs';
import {
  STACK_CONFIG_RELATIVE_PATH,
  configuredStack,
} from '../../scripts/test-stack-prerequisites.mjs';
import {
  buildPlatformImage,
  platformImageId,
  pollHealth,
  writeComposeConfiguration,
} from './deployment-compose-fixture.ts';
import type { DockerOutput } from './deployment-compose-fixture.ts';
import {
  acquireDeploymentLock,
  drainDeploymentPlatform,
  output,
  OWNER_LABEL,
} from './docker-cleanup.ts';
import { isAbsentResource } from './docker-command.ts';
import { unusedPort } from './gateway-http-fixture.ts';
import { runUserImage } from './user-image-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

type Stack = NonNullable<ReturnType<typeof configuredStack>>;
const PLATFORM = 'dsh-team-platform';

/** The RAGFlow origin and key come only from the private file; nothing here may print them. */
function privateStack(): Stack {
  let config: Parameters<typeof configuredStack>[0];
  try {
    config = readPrivateJsonFile(
      join(homedir(), STACK_CONFIG_RELATIVE_PATH),
      process.getuid?.() ?? -1,
    );
  } catch {
    config = 'invalid';
  }
  const stack = configuredStack(config);
  if (stack === undefined) throw new Error('Private stack configuration unavailable');
  return stack;
}

/** Read-only GETs; an unreadable or incomplete seed fails the case and is never seeded here. */
async function seedSnapshot(stack: Stack) {
  try {
    return await readSeedDatasets(stack);
  } catch (error) {
    // SeedFailure lines name only datasets and files.
    const reason = error instanceof Error ? error.message : 'unknown failure';
    throw new Error(`Seeded RAGFlow data unreadable; run pnpm seed:stack first (${reason})`, {
      cause: error,
    });
  }
}

/** Docker Desktop's socket group, observed through the same source/target bind compose uses. */
async function socketGroup(run: DockerOutput, lifecycle: UserImageLifecycle, image: string) {
  const probe = `dsh-team-test-${lifecycle.runId}-socket-probe`;
  const gid = await run([
    'run',
    '--rm',
    '--name',
    probe,
    '--label',
    `${OWNER_LABEL}=${lifecycle.runId}`,
    '--network',
    'none',
    '--mount',
    'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
    '--entrypoint',
    'stat',
    image,
    '-c',
    '%g',
    '/var/run/docker.sock',
  ]);
  if (!/^\d+\r?\n?$/.test(gid)) throw new Error('Docker socket group probe malformed');
  return Number(gid.trim());
}

interface Timings {
  userImageBuildMs?: number;
  platformImageBuildMs?: number;
}

async function composeScenario(lifecycle: UserImageLifecycle, timings: Timings): Promise<string> {
  const { runId } = lifecycle;
  const run: DockerOutput = async (args, timeout = 30_000) =>
    output(await lifecycle.commandAsync(args, timeout), args);
  const ownership = { [OWNER_LABEL]: runId };
  const image = `dsh-team-test-${runId}:platform`;
  const project = `dsh-team-test-${runId}`;
  const network = `${project}_default`;
  // Compose binds source and target identically: Docker Desktop needs the resolved host path.
  // The lifecycle's private directory outlives this case: `finish()` removes it only after the
  // exact-owned retirement, so an undrained platform never loses its bind sources while alive.
  const directory = realpathSync(dirname(lifecycle.overlayDirectory));
  let submitted = false;
  const failures: unknown[] = [];
  try {
    const existing = await lifecycle.commandAsync(['container', 'inspect', PLATFORM], 30_000);
    if (!isAbsentResource(existing, 'container', PLATFORM))
      throw new Error(
        'Platform container already exists or absence is unproven; refusing deployment',
      );
    for (const [kind, name] of [
      ['image', image],
      ['container', `dsh-team-test-${runId}-socket-probe`],
      ['container', PLATFORM],
      ['network', network],
    ] as const)
      await lifecycle.registerResourceAsync(kind, name, ownership);
    const started = performance.now();
    await buildPlatformImage(run, runId, image);
    timings.platformImageBuildMs = Math.round(performance.now() - started);
    const imageId = await platformImageId(run, image);
    const dockerGid = await socketGroup(run, lifecycle, imageId);
    const dataDir = join(directory, 'platform-data');
    const managedDir = join(directory, 'managed');
    await mkdir(dataDir, { mode: 0o700 });
    await mkdir(managedDir, { mode: 0o700 });
    const { base, compose } = await writeComposeConfiguration({
      repositoryRoot: lifecycle.repositoryRoot,
      directory,
      dataDir,
      managedDir,
      port: await unusedPort(),
      userImage: lifecycle.imageId,
      platformImage: imageId,
      dockerGid,
      runId,
      project,
      network,
      overrides: [],
    });
    submitted = true;
    await run([...compose, 'up', '-d', '--no-build', '--pull', 'never'], 120_000);
    await pollHealth(fetch, base, 60_000);
  } catch (error) {
    failures.push(error);
  }
  // Drain this run's verified platform by exact-ID SIGTERM before exact-owned removal.
  if (submitted) {
    try {
      await drainDeploymentPlatform(lifecycle.commandAsync, runId);
    } catch (error) {
      failures.push(error);
    }
  }
  // The original failure stays first; a drainage failure follows it.
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, 'Local stack deployment and drainage failed');
  return 'verified';
}

it('builds both images, starts the delivered compose platform and reads the seeded stack', async () => {
  const stack = privateStack();
  const before = await seedSnapshot(stack);
  expect(before).toEqual(
    SEED_DATASETS.map(({ name, files }) => ({
      name,
      files: files.map((file) => ({ name: file, status: 'COMPLETED' })),
    })),
  );
  const timings: Timings = {};
  // Held from before fixed-name admission through exact-owned teardown.
  const release = await acquireDeploymentLock();
  try {
    const started = performance.now();
    await runUserImage(
      'container-start',
      () => undefined,
      undefined,
      (lifecycle) => {
        timings.userImageBuildMs = Math.round(performance.now() - started);
        return composeScenario(lifecycle, timings);
      },
    );
  } finally {
    await release();
  }
  expect(await seedSnapshot(stack)).toEqual(before);
  process.stdout.write(
    `${JSON.stringify({ stackEvidence: { ...timings, datasets: 3, files: 6 } })}\n`,
  );
});
