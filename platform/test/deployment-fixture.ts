import { mkdir, stat } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { isAbsentResource } from './docker-command.ts';
import {
  acquireDeploymentLock,
  drainDeploymentPlatform,
  output,
  OWNER_LABEL,
} from './docker-cleanup.ts';
import { unusedPort } from './gateway-http-fixture.ts';
import { runUserImage } from './user-image-fixture.ts';
import { deploymentSetupStep } from './deployment-setup-evidence.ts';
import type { DeploymentSetupEvidence } from './deployment-setup-evidence.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';
import { prepareVerificationImage } from '../../scripts/verification-image.mjs';
import {
  buildPlatformImage,
  platformImageId,
  writeComposeConfiguration,
} from './deployment-compose-fixture.ts';
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
      buildPlatformImage(command, lifecycle.runId, image, artifact?.args),
    );
    const imageId = await deploymentSetupStep(setup, 'platform-image-identity', async () => {
      const id = await platformImageId(command, image);
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
      const { base, compose } = await writeComposeConfiguration({
        repositoryRoot: lifecycle.repositoryRoot,
        directory,
        dataDir,
        managedDir: lifecycle.overlayDirectory,
        port,
        userImage: lifecycle.imageId,
        platformImage: imageId,
        // The trusted Linux host's actual socket group, never a hardcoded verification value.
        dockerGid: (await stat('/var/run/docker.sock')).gid,
        runId: lifecycle.runId,
        project,
        network,
        overrides: [observation.override],
      });
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

/** Replace only this invocation's settled platform; instances and persistent binds stay untouched. */
export async function recreateDeployment(
  lifecycle: UserImageLifecycle,
  deployment: Deployment,
): Promise<void> {
  const id = await drainDeploymentPlatform(lifecycle.commandAsync, lifecycle.runId);
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
    const release = await acquireDeploymentLock();
    try {
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
                  const owner = await drainDeploymentPlatform(
                    lifecycle.commandAsync,
                    lifecycle.runId,
                  );
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
      await release();
    }
  } catch (error) {
    lockAdmission?.fail();
    throw error;
  }
}
