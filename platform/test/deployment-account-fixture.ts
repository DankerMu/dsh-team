import { randomUUID } from 'node:crypto';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { expect } from 'vitest';
import { MODEL_CONFIG } from './admin-config-fixture.ts';
import { matchingPasswords, runPty } from './cli-process-fixture.ts';
import { DOCKER_CLI_PATH } from './docker-command.ts';
import { registerInstanceUser } from './instance-fixture.ts';
import type { Deployment } from './deployment-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';
import { requireDeploymentObservationReady } from './deployment-observer-fixture.ts';
import { pollHealth } from './deployment-compose-fixture.ts';
import type { DeploymentSetupEvidence } from './deployment-setup-evidence.ts';

export async function waitForDeployment(deployment: Deployment, setup?: DeploymentSetupEvidence) {
  const wait = async () => {
    await pollHealth(deployment.request, deployment.base, 30_000);
    requireDeploymentObservationReady(deployment.observation);
  };
  return setup ? setup.run('health', wait) : wait();
}

/** The deployed platform an account preparation reaches; Docker Desktop or the Linux host. */
export type AccountTarget = Pick<
  Deployment,
  'base' | 'request' | 'directory' | 'dataDir' | 'compose'
>;

/** Shared model settings the administrator saves; the key is a nonsecret invocation value. */
export interface AccountModel {
  readonly settings: Readonly<Record<string, unknown>>;
  readonly apiKey: string;
}

export async function registerDeploymentEmployee(
  lifecycle: UserImageLifecycle,
  deployment: Pick<Deployment, 'base' | 'request'>,
  email: string,
) {
  const employee = await registerInstanceUser(
    deployment.base,
    deployment.base,
    email,
    deployment.request,
  );
  const ownership = { 'dsh-team.user': employee.id };
  for (const [kind, name] of [
    ['container', `dsh-team-u-${employee.id}`],
    ['volume', `dsh-team-home-${employee.id}`],
    ['volume', `dsh-team-work-${employee.id}`],
    ['network', `dsh-team-net-${employee.id}`],
  ] as const)
    await lifecycle.registerResourceAsync(kind, name, ownership);
  return { ...employee, email };
}

/**
 * Lane-independent accounts on a healthy deployed platform: administrator through the container
 * CLI's real PTY, login, shared model configuration, and one registered employee whose instance
 * resources are journaled before any start.
 */
export async function prepareDeploymentAccounts(
  lifecycle: UserImageLifecycle,
  deployment: AccountTarget,
  model: AccountModel = { settings: MODEL_CONFIG, apiKey: 'deployment-acceptance-key' },
  setup?: DeploymentSetupEvidence,
) {
  const email = 'administrator@deployment.example.test';
  const password = randomUUID();
  const initialize = () => {
    const terminal = runPty(
      {
        directory: deployment.directory,
        dataDir: deployment.dataDir,
        databasePath: join(deployment.dataDir, 'platform.db'),
      },
      {
        command: [
          'docker',
          '--config',
          dirname(lifecycle.overlayDirectory),
          ...deployment.compose,
          'exec',
          'platform',
          'node',
          'platform/dist/cli.js',
        ],
        args: ['admin', 'create', email],
        actions: matchingPasswords(password),
        secrets: [password],
        // Docker Desktop's CLI lives only in /usr/local/bin; the Linux terminal PATH is unchanged.
        ...(platform() === 'darwin' ? { env: { PATH: DOCKER_CLI_PATH } } : {}),
      },
    );
    expect(terminal.exitCode).toBe(0);
    expect(terminal.leakedInput).toBe(false);
    expect(terminal.modeRestored).toBe(true);
  };
  if (setup) setup.runSync('administrator-terminal', initialize);
  else initialize();
  const authenticate = async () => {
    const login = await deployment.request(`${deployment.base}/_platform/api/login`, {
      method: 'POST',
      headers: { origin: deployment.base, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(login.status).toBe(200);
    expect(await login.json()).toMatchObject({ role: 'admin', email });
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    if (cookie === undefined) throw new Error('Deployed administrator session missing');
    return cookie;
  };
  const cookie = setup
    ? await setup.run('administrator-login', authenticate)
    : await authenticate();
  const configureModel = async () => {
    const configured = await deployment.request(
      `${deployment.base}/_platform/api/admin/model-config`,
      {
        method: 'PUT',
        headers: { origin: deployment.base, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ ...model.settings, apiKey: model.apiKey }),
      },
    );
    expect(configured.status).toBe(200);
    expect(await configured.json()).toEqual({
      ...model.settings,
      apiKeyConfigured: true,
      runningInstances: 0,
    });
  };
  if (setup) await setup.run('model-configuration', configureModel);
  else await configureModel();
  const employee = setup
    ? await setup.run('employee-registration', () =>
        registerDeploymentEmployee(lifecycle, deployment, 'employee@deployment.example.test'),
      )
    : await registerDeploymentEmployee(lifecycle, deployment, 'employee@deployment.example.test');
  return { employee, admin: { email, password, cookie } };
}

export async function configureDeployment(
  lifecycle: UserImageLifecycle,
  start: () => Promise<Deployment>,
  setup?: DeploymentSetupEvidence,
) {
  const configure = async () => {
    const deployment = await start();
    await waitForDeployment(deployment, setup);
    return {
      deployment,
      ...(await prepareDeploymentAccounts(lifecycle, deployment, undefined, setup)),
    };
  };
  return setup ? setup.run('account-configuration', configure) : configure();
}
