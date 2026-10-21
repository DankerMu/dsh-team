import { dirname, join } from 'node:path';
import { extractLaunchToken } from '../src/orchestrator/index.ts';
import { runPty } from './cli-process-fixture.ts';
import { inspectAsync } from './container-start-docker-fixture.ts';
import { waitForDeployment } from './deployment-account-fixture.ts';
import { OWNER_LABEL } from './docker-cleanup.ts';
import type { Deployment } from './deployment-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';
import { expect } from 'vitest';
import { record } from './container-start-docker-fixture.ts';
import {
  bindDeploymentObservation,
  prepareDeploymentRestart,
} from './deployment-observer-fixture.ts';

interface Identity {
  id: string;
  email: string;
}

export function verifyDeployedAuditEvents(
  values: unknown,
  admin: Identity,
  employee: Identity,
): void {
  if (!Array.isArray(values)) throw new Error('Missing deployed audit rows');
  const rows = values.map((value: unknown) => record(value));
  const target = (identity: Identity, actor: string | null) => ({
    actor_email: actor,
    target: identity.id,
    target_email: identity.email,
  });
  const self = target(employee, employee.email);
  const managed = target(employee, admin.email);
  const automatic = target(employee, null);
  // Independent contract inventory: do not derive expectations from the production event registry.
  const expected: Record<string, readonly object[]> = {
    'account.registered': [self],
    'login.succeeded': [self, target(admin, admin.email)],
    'login.failed': [{ actor_email: employee.email, target: null, target_email: null }],
    'logout.succeeded': [self],
    'password.changed': [self],
    'account.disabled': [managed],
    'account.enabled': [managed],
    'password.reset': [managed],
    'admin.created': [target(admin, null)],
    'admin.promoted': [automatic],
    'model-config.updated': [{ actor_email: admin.email, target: null, target_email: null }],
    'runtime-config.updated': [{ actor_email: admin.email, target: null, target_email: null }],
    'instance.restarted': [managed],
    'instance.config-reset': [managed],
    'instance.created': [automatic],
    'instance.started': [automatic],
    'instance.ready': [automatic],
    'instance.stopped': [automatic],
    'instance.start-failed': [automatic],
  };
  for (const [type, identities] of Object.entries(expected)) {
    const matching = rows.filter((row) => row.event_type === type);
    if (matching.length === 0) {
      process.stdout.write(JSON.stringify({ missingAuditEvent: type }) + '\n');
      throw new Error(`Missing deployed audit event: ${type}`);
    }
    for (const row of matching) {
      const actual = {
        actor_email: row.actor_email,
        target: row.target,
        target_email: row.target_email,
      };
      expect(identities, `Audit identity for ${type}`).toContainEqual(actual);
    }
  }
  const stops = rows.filter((row) => row.event_type === 'instance.stopped');
  for (const reason of ['idle', 'admin', 'disabled', 'error']) {
    expect(
      stops.some((row) => row.details === JSON.stringify({ reason })),
      `Stop reason ${reason}`,
    ).toBe(true);
  }
  process.stdout.write(
    JSON.stringify({
      deployedAuditCoverage: { eventTypes: 19, stopReasons: 4, rows: rows.length },
    }) + '\n',
  );
}

interface AuditSequence {
  lifecycle: UserImageLifecycle;
  deployment: Deployment;
  employee: Identity;
  adminCookie: string;
  password: string;
  progress: { phase: string };
  databaseScript: string;
  read: (script: string) => Promise<Record<string, unknown>>;
  run: (args: string[], timeout?: number) => Promise<{ stdout: string }>;
  mutate: (
    path: string,
    method: string,
    body: unknown,
    cookie: string,
    status: number,
  ) => Promise<Response>;
}

export async function completeDeployedAuditSequence(input: AuditSequence): Promise<string[]> {
  const { lifecycle, deployment, employee, adminCookie, password, progress, mutate } = input;
  const credentials: string[] = [];
  const userPath = `/_platform/api/admin/users/${employee.id}`;
  const instancePath = `/_platform/api/admin/instances/${employee.id}`;
  progress.phase = 'audit-enable-and-password-reset';
  await mutate(`${userPath}/status`, 'PUT', { status: 'active' }, adminCookie, 204);
  await mutate(`${userPath}/password`, 'PUT', { newPassword: password }, adminCookie, 204);
  const login = async () => {
    const response = await mutate(
      '/_platform/api/login',
      'POST',
      { email: employee.email, password },
      '',
      200,
    );
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    if (!cookie) throw new Error('Missing audit login cookie');
    credentials.push(cookie.slice(cookie.indexOf('=') + 1));
    return cookie;
  };
  await mutate('/_platform/api/logout', 'POST', {}, await login(), 204);
  const cookie = await login();
  const status = async () => {
    const response = await deployment.request(`${deployment.base}/_platform/api/instance`, {
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    return record(await response.json()).status;
  };
  const captureReady = async () => {
    // Avoid default 50ms sampling flooding the complete bounded platform-log observation.
    await expect.poll(status, { timeout: 60_000, interval: 1_000 }).toBe('running');
    const container = await inspectAsync(lifecycle, `dsh-team-u-${employee.id}`);
    expect(record(record(container.Config).Labels)['dsh-team.user']).toBe(employee.id);
    expect(container.Name).toBe(`/dsh-team-u-${employee.id}`);
    expect(container.Image).toBe(lifecycle.imageId);
    if (typeof container.Id !== 'string') throw new Error('Missing owned audit container');
    const token = extractLaunchToken((await input.run(['logs', container.Id])).stdout);
    const row = await input.read(
      `${input.databaseScript}try{process.stdout.write(JSON.stringify(db.prepare('SELECT dsh_cookie FROM instances WHERE user_id=?').get(${JSON.stringify(employee.id)})));}finally{db.close();}`,
    );
    if (!token || typeof row.dsh_cookie !== 'string')
      throw new Error('Missing audit native credentials');
    credentials.push(token, row.dsh_cookie.slice(row.dsh_cookie.indexOf('=') + 1));
    return container.Id;
  };
  const start = async () => {
    await mutate('/_platform/api/instance/start', 'POST', {}, cookie, 200);
    return captureReady();
  };
  progress.phase = 'audit-runtime-and-restart';
  const runtime = await deployment.request(
    `${deployment.base}/_platform/api/admin/runtime-config`,
    { headers: { cookie: adminCookie } },
  );
  expect(runtime.status).toBe(200);
  await mutate(
    '/_platform/api/admin/runtime-config',
    'PUT',
    { ...record(await runtime.json()), idleMinutes: 1 },
    adminCookie,
    200,
  );
  await start();
  await mutate(`${instancePath}/restart`, 'POST', {}, adminCookie, 200);
  await captureReady();
  progress.phase = 'audit-real-idle-retirement';
  // First minute establishes continuity, the next due sweep retires. No clock or row mutation.
  // One-second status sampling itself overflowed the unchanged complete-log output bound.
  await expect.poll(status, { timeout: 185_000, interval: 5_000 }).toBe('stopped');
  progress.phase = 'audit-error-retirement';
  const stoppedId = await start();
  await input.run(['stop', '--time', '5', stoppedId]);
  // Explicit start rejects a running index whose Engine container is stopped. Startup reconciliation owns recovery.
  const platform = await inspectAsync(lifecycle, 'dsh-team-platform');
  expect(record(record(platform.Config).Labels)[OWNER_LABEL]).toBe(lifecycle.runId);
  expect(platform.Name).toBe('/dsh-team-platform');
  if (typeof platform.Id !== 'string') throw new Error('Missing owned platform identity');
  // Preserve the full 30s Engine grace plus command completion/transport margin.
  await input.run(['stop', '--time', '30', platform.Id], 45_000);
  expect(record((await inspectAsync(lifecycle, platform.Id)).State).ExitCode).toBe(0);
  await prepareDeploymentRestart(deployment.observation, lifecycle, platform.Id);
  await input.run(['start', platform.Id]);
  await bindDeploymentObservation(deployment.observation, lifecycle, platform.Id);
  await waitForDeployment(deployment);
  expect(await status()).toBe('stopped');
  const replacementId = await start();
  expect(replacementId).not.toBe(stoppedId);
  progress.phase = 'audit-start-failed-and-config-reset';
  await input.run([
    'exec',
    '--user',
    '1001',
    replacementId,
    'node',
    '--input-type=module',
    '-e',
    `import {writeFileSync} from 'node:fs';
const root='/data/home/profiles/web';
writeFileSync(root+'/audit-boot-exit.mjs','process.exit(71);');
writeFileSync(root+'/cordis.patch.yml',JSON.stringify([{insert:[{id:'audit-boot-exit',name:root+'/audit-boot-exit.mjs'}]}]));`,
  ]);
  await mutate(`${instancePath}/restart`, 'POST', {}, adminCookie, 200);
  await expect.poll(status, { timeout: 60_000, interval: 1_000 }).toBe('error');
  const failed = await inspectAsync(lifecycle, `dsh-team-u-${employee.id}`);
  expect(failed.Id).not.toBe(replacementId);
  expect(failed.Image).toBe(lifecycle.imageId);
  expect(record(record(failed.Config).Labels)['dsh-team.user']).toBe(employee.id);
  expect(record(failed.State)).toMatchObject({ Running: false, ExitCode: 71 });
  if (typeof failed.Id !== 'string') throw new Error('Missing failed owned instance');
  expect(extractLaunchToken((await input.run(['logs', failed.Id])).stdout)).toBeUndefined();
  await mutate(`${instancePath}/reset-config`, 'POST', {}, adminCookie, 204);
  expect(await status()).toBe('stopped');
  progress.phase = 'audit-terminal-promotion';
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
      args: ['admin', 'create', employee.email],
      actions: [{ prompt: 'Reset password? [y/N]: ', text: '' }],
    },
  );
  expect(terminal.exitCode).toBe(0);
  expect(terminal.modeRestored).toBe(true);
  expect(terminal.leakedInput).toBe(false);
  await mutate(`${userPath}/status`, 'PUT', { status: 'disabled' }, adminCookie, 204);
  return credentials;
}
