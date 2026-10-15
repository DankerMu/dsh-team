import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { expect } from 'vitest';
import { MODEL_CONFIG } from './admin-config-fixture.ts';
import { matchingPasswords, runPty } from './cli-process-fixture.ts';
import { registerInstanceUser } from './instance-fixture.ts';
import type { Deployment } from './deployment-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

export async function waitForDeployment(deployment: Deployment) {
  // Only readiness polling; never recreate a failed deployment to obtain success.
  await expect
    .poll(
      async () => {
        const response = await deployment.request(`${deployment.base}/healthz`, {
          signal: AbortSignal.timeout(2_000),
        });
        return { status: response.status, body: await response.json() };
      },
      { timeout: 30_000 },
    )
    .toEqual({ status: 200, body: { status: 'ok' } });
}

export async function registerDeploymentEmployee(
  lifecycle: UserImageLifecycle,
  deployment: Deployment,
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

export async function configureDeployment(
  lifecycle: UserImageLifecycle,
  start: () => Promise<Deployment>,
) {
  const deployment = await start();
  await waitForDeployment(deployment);
  const email = 'administrator@deployment.example.test';
  const password = randomUUID();
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
    },
  );
  expect(terminal.exitCode).toBe(0);
  expect(terminal.leakedInput).toBe(false);
  expect(terminal.modeRestored).toBe(true);
  const login = await deployment.request(`${deployment.base}/_platform/api/login`, {
    method: 'POST',
    headers: { origin: deployment.base, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  expect(login.status).toBe(200);
  expect(await login.json()).toMatchObject({ role: 'admin', email });
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  if (cookie === undefined) throw new Error('Deployed administrator session missing');
  const configured = await deployment.request(
    `${deployment.base}/_platform/api/admin/model-config`,
    {
      method: 'PUT',
      headers: { origin: deployment.base, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ ...MODEL_CONFIG, apiKey: 'deployment-acceptance-key' }),
    },
  );
  expect(configured.status).toBe(200);
  expect(await configured.json()).toEqual({
    ...MODEL_CONFIG,
    apiKeyConfigured: true,
    runningInstances: 0,
  });
  const employee = await registerDeploymentEmployee(
    lifecycle,
    deployment,
    'employee@deployment.example.test',
  );
  return { deployment, employee, admin: { email, password, cookie } };
}
