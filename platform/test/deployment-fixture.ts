import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';
import { inspectAsync, record } from './container-start-docker-fixture.ts';
import { isAbsentResource } from './docker-command.ts';
import { output, OWNER_LABEL } from './docker-cleanup.ts';
import { unusedPort } from './gateway-http-fixture.ts';
import { runUserImage } from './user-image-fixture.ts';
import { deploymentSetupStep } from './deployment-setup-evidence.ts';
import type { DeploymentSetupEvidence } from './deployment-setup-evidence.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';
import { prepareVerificationImage } from '../../scripts/verification-image.mjs';
import {
  bindDeploymentObservation,
  createDeploymentObservation,
  finishDeploymentObservation,
  prepareDeploymentReplacement,
} from './deployment-observer-fixture.ts';
import type { DeploymentObservation } from './deployment-observer-fixture.ts';

export interface Deployment {
  base: string;
  port: number;
  directory: string;
  dataDir: string;
  compose: string[];
  request: (url: string, init?: RequestInit) => Promise<Response>;
  observation: DeploymentObservation;
}

async function startDeployment(
  lifecycle: UserImageLifecycle,
  submitted: (observation: DeploymentObservation) => void,
  prepare?: (lifecycle: UserImageLifecycle, deployment: Deployment) => Promise<void>,
  setup?: DeploymentSetupEvidence,
): Promise<Deployment> {
  return deploymentSetupStep(setup, 'deployment-creation', async () => {
    await deploymentSetupStep(setup, 'fixed-name-admission', async () => {
      const existing = await lifecycle.commandAsync(
        ['container', 'inspect', 'dsh-team-platform'],
        30_000,
      );
      if (!isAbsentResource(existing, 'container', 'dsh-team-platform'))
        throw new Error(
          'Platform container already exists or absence is unproven; refusing deployment',
        );
    });
    const command = async (args: string[], timeout = 30_000) =>
      output(await lifecycle.commandAsync(args, timeout), args);
    await deploymentSetupStep(setup, 'compose-capability', () =>
      command(['compose', 'version', '--short']),
    );
    const ownership = { [OWNER_LABEL]: lifecycle.runId };
    const image = `dsh-team-test-${lifecycle.runId}:platform`;
    const project = `dsh-team-test-${lifecycle.runId}`;
    const network = `${project}_default`;
    const artifact = prepareVerificationImage(
      'platform',
      image,
      ownership,
      dirname(lifecycle.overlayDirectory),
      lifecycle.command,
    );
    await deploymentSetupStep(setup, 'resource-registration', async () => {
      for (const [kind, name] of [
        ['image', image],
        ['container', 'dsh-team-platform'],
        ['network', network],
      ] as const)
        await lifecycle.registerResourceAsync(kind, name, ownership);
    });
    await deploymentSetupStep(setup, 'platform-build', () =>
      command(
        artifact?.args ?? [
          'build',
          '--label',
          `${OWNER_LABEL}=${lifecycle.runId}`,
          '--tag',
          image,
          '--file',
          'platform/Dockerfile',
          '.',
        ],
        600_000,
      ),
    );
    const imageId = await deploymentSetupStep(setup, 'platform-image-identity', async () => {
      const id = (await command(['image', 'inspect', '--format', '{{.Id}}', image])).trim();
      if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error('Platform image identity missing');
      artifact?.verify(id);
      return id;
    });
    const deployment = await deploymentSetupStep(setup, 'local-configuration', async () => {
      const observation = await createDeploymentObservation(lifecycle, imageId);
      submitted(observation);
      const directory = dirname(lifecycle.overlayDirectory);
      const dataDir = join(directory, 'platform-data');
      await mkdir(dataDir, { mode: 0o700 });
      await mkdir(lifecycle.overlayDirectory, { mode: 0o700 });
      const port = await unusedPort();
      const base = `http://127.0.0.1:${String(port)}`;
      const environment = {
        ...parseEnv(await readFile(join(lifecycle.repositoryRoot, '.env.example'), 'utf8')),
        PLATFORM_HOST: '0.0.0.0',
        PLATFORM_PORT: String(port),
        PLATFORM_LOG_LEVEL: 'silent',
        PLATFORM_DATA_DIR: dataDir,
        PLATFORM_MANAGED_CONFIG_DIR: lifecycle.overlayDirectory,
        PLATFORM_DOCKER_SOCKET: '/var/run/docker.sock',
        PLATFORM_USER_IMAGE: lifecycle.imageId,
        PLATFORM_SECCOMP_PROFILE: '/app/images/seccomp/dsh-user.json',
        PLATFORM_PUBLIC_URL: base,
        PLATFORM_UPSTREAM_MODE: 'network',
        PLATFORM_CONTAINER_NAME: 'dsh-team-platform',
        DEPLOY_DOCKER_GID: String((await stat('/var/run/docker.sock')).gid),
      };
      const environmentPath = join(directory, 'compose.env');
      const override = join(directory, 'compose.json');
      await writeFile(
        environmentPath,
        Object.entries(environment)
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
          .join('\n') + '\n',
        { mode: 0o600 },
      );
      await writeFile(
        override,
        JSON.stringify({
          services: { platform: { image: imageId, labels: ownership } },
          networks: { default: { name: network, labels: ownership } },
        }),
        { mode: 0o600 },
      );
      const compose = [
        'compose',
        '--project-directory',
        lifecycle.repositoryRoot,
        '--env-file',
        environmentPath,
        '--file',
        join(lifecycle.repositoryRoot, 'deploy/compose.yml'),
        '--file',
        override,
        '--file',
        observation.override,
        '--project-name',
        project,
      ];
      return { base, port, directory, dataDir, compose, request: fetch, observation };
    });
    if (prepare)
      await deploymentSetupStep(setup, 'scenario-preparation', () =>
        prepare(lifecycle, deployment),
      );
    await deploymentSetupStep(setup, 'compose-creation', async () => {
      await command([...deployment.compose, 'up', '-d', '--no-build', '--pull', 'never']);
      await bindDeploymentObservation(deployment.observation, lifecycle);
    });
    return deployment;
  });
}

async function drainDeployment(lifecycle: UserImageLifecycle): Promise<string | undefined> {
  const args = ['container', 'inspect', 'dsh-team-platform'];
  const inspected = await lifecycle.commandAsync(args, 30_000);
  // Compose may reject before creating its service; no owner exists to drain in that case.
  if (isAbsentResource(inspected, 'container', 'dsh-team-platform')) return;
  output(inspected, args);
  const platform = await inspectAsync(lifecycle, 'dsh-team-platform');
  const labels = record(record(platform.Config).Labels);
  if (
    platform.Name !== '/dsh-team-platform' ||
    labels[OWNER_LABEL] !== lifecycle.runId ||
    typeof platform.Id !== 'string'
  )
    throw new Error('Refusing shutdown of an unowned deployment');
  const state = record(platform.State);
  if (state.Status === 'created') return platform.Id;
  if (state.Running === true) {
    const signal = ['kill', '--signal', 'SIGTERM', platform.Id];
    output(await lifecycle.commandAsync(signal, 30_000), signal);
    // No Docker stop fallback: forced termination is not proof that helper retirement drained.
    const wait = ['wait', platform.Id];
    if (output(await lifecycle.commandAsync(wait, 30_000), wait).trim() !== '0')
      throw new Error('Deployment owner did not exit gracefully');
  }
  const settled = record((await inspectAsync(lifecycle, platform.Id)).State);
  if (settled.Running !== false || settled.ExitCode !== 0 || settled.OOMKilled !== false)
    throw new Error('Deployment owner drainage unconfirmed');
  return platform.Id;
}

/** Replace only this invocation's settled platform; instances and persistent binds stay untouched. */
export async function recreateDeployment(
  lifecycle: UserImageLifecycle,
  deployment: Deployment,
): Promise<void> {
  const id = await drainDeployment(lifecycle);
  if (id === undefined) throw new Error('Missing platform to recreate');
  const remove = ['container', 'rm', id];
  output(await lifecycle.commandAsync(remove, 30_000), remove);
  for (const identity of [id, 'dsh-team-platform']) {
    const absent = await lifecycle.commandAsync(['container', 'inspect', identity], 30_000);
    if (!isAbsentResource(absent, 'container', identity))
      throw new Error('Platform absence unconfirmed before recreation');
  }
  await prepareDeploymentReplacement(deployment.observation);
  const create = [...deployment.compose, 'up', '-d', '--no-build', '--pull', 'never'];
  output(await lifecycle.commandAsync(create, 30_000), create);
  await bindDeploymentObservation(deployment.observation, lifecycle);
}

/** The kernel lock spans build, fixed-name admission, the scenario and canonical resource cleanup. */
export async function withDeployment(
  run: (lifecycle: UserImageLifecycle, start: () => Promise<Deployment>) => Promise<void>,
  prepare?: (lifecycle: UserImageLifecycle, deployment: Deployment) => Promise<void>,
  setup?: DeploymentSetupEvidence,
): Promise<void> {
  const admit = () => {
    if (platform() !== 'linux' || arch() !== 'x64' || process.getuid?.() === 0)
      throw new Error('Deployment verification requires the trusted non-root Linux amd64 host');
  };
  if (setup) setup.runSync('deployment-host-admission', admit);
  else admit();
  const lockAdmission = setup?.begin('deployment-lock-admission');
  try {
    // stdin EOF releases the holder even if the verification parent dies; no stale-file takeover.
    const lock = spawn(
      'flock',
      [
        '--nonblock',
        // The fixed platform name is host-wide even when each invocation has a private TMPDIR.
        '/tmp/dsh-team-deployment.lock',
        process.execPath,
        '-e',
        "process.stdout.write('locked\\n');process.stdin.resume();",
      ],
      {
        env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const closed = once(lock, 'close');
    try {
      const ready: unknown = await Promise.race([
        once(lock.stdout, 'data'),
        closed.then(() => {
          throw new Error('Deployment verification lock unavailable');
        }),
      ]);
      if (!Array.isArray(ready) || !Buffer.isBuffer(ready[0]) || ready[0].toString() !== 'locked\n')
        throw new Error('Deployment lock admission failed');
      lockAdmission?.complete();
      let observation: DeploymentObservation | undefined;
      const finalFailures: unknown[] = [];
      try {
        await runUserImage(
          'container-start',
          () => undefined,
          undefined,
          async (lifecycle) => {
            const state = { submitted: false };
            const failures: unknown[] = [];
            try {
              await run(lifecycle, () =>
                startDeployment(
                  lifecycle,
                  (createdObservation) => {
                    state.submitted = true;
                    observation = createdObservation;
                    // Retirement remains unproved until finishDeploymentObservation itself returns.
                    setup?.cleanup('observation', 'unconfirmed');
                  },
                  prepare,
                  setup,
                ),
              );
            } catch (error) {
              failures.push(error);
            } finally {
              if (state.submitted) {
                setup?.cleanup('deploymentDrain', 'unconfirmed');
                try {
                  const owner = await drainDeployment(lifecycle);
                  setup?.cleanup(
                    'deploymentDrain',
                    owner === undefined ? 'not-required' : 'confirmed',
                  );
                } catch (error) {
                  failures.push(error);
                }
              }
            }
            if (failures.length === 1) throw failures[0];
            if (failures.length > 1)
              throw new AggregateError(failures, 'Deployment scenario and owner drainage failed');
            return 'verified';
          },
          setup,
        );
      } catch (error) {
        finalFailures.push(error);
      }
      if (observation !== undefined) {
        try {
          await finishDeploymentObservation(observation, finalFailures.length === 0);
          setup?.cleanup('observation', 'confirmed');
        } catch (error) {
          finalFailures.push(error);
        }
      }
      if (finalFailures.length === 1) throw finalFailures[0];
      if (finalFailures.length > 1)
        throw new AggregateError(
          finalFailures,
          'Deployment scenario and observation retirement failed',
        );
    } finally {
      lock.stdin.end();
      await closed;
    }
  } catch (error) {
    lockAdmission?.fail();
    throw error;
  }
}
