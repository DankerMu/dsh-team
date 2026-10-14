import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { MODEL_CONFIG } from './admin-config-fixture.ts';
import { postJson } from './auth-tcp-fixture.ts';
import { matchingPasswords, runPty } from './cli-process-fixture.ts';
import { inspectAsync, record } from './container-start-docker-fixture.ts';
import { cleanupTargets, output, OWNER_LABEL, removeOwned } from './docker-cleanup.ts';
import type { CleanupTarget } from './docker-cleanup.ts';
import { isAbsentResource } from './docker-command.ts';
import { recreateDeployment, withDeployment } from './deployment-fixture.ts';
import { activityUpgradeRequest, connectActivityPeer } from './gateway-activity-fixture.ts';
import { observeHttp } from './gateway-http-fixture.ts';
import { registerInstanceUser } from './instance-fixture.ts';
import { instanceGatewayFixture, orderedMounts } from './instance-gateway-docker-fixture.ts';
import type { Deployment } from './deployment-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

it('refuses a pre-existing fixed platform identity without adopting or removing it', async () => {
  await withDeployment(async (lifecycle, start) => {
    const ownership = { 'dsh-team.test-run': `foreign-${lifecycle.runId}` };
    await lifecycle.registerResourceAsync('container', 'dsh-team-platform', ownership);
    const args = [
      'create',
      '--name',
      'dsh-team-platform',
      '--network',
      'none',
      '--label',
      `dsh-team.test-run=${ownership['dsh-team.test-run']}`,
      lifecycle.imageId,
    ];
    const id = output(await lifecycle.commandAsync(args, 30_000), args).trim();

    await expect(start()).rejects.toThrow('Platform container already exists');

    const preserved = await inspectAsync(lifecycle, 'dsh-team-platform');
    expect(preserved.Id).toBe(id);
    expect(record(preserved.Config).Labels).toMatchObject(ownership);
    expect(record(preserved.State).Status).toBe('created');
  });
});

async function waitForDeployment(deployment: Deployment) {
  // Only readiness polling; never recreate a failed deployment to obtain success.
  await expect
    .poll(
      async () => {
        const response = await fetch(`${deployment.base}/healthz`, {
          signal: AbortSignal.timeout(2_000),
        });
        return { status: response.status, body: await response.json() };
      },
      { timeout: 30_000 },
    )
    .toEqual({ status: 200, body: { status: 'ok' } });
}

async function registerDeploymentEmployee(
  lifecycle: UserImageLifecycle,
  deployment: Deployment,
  email: string,
) {
  const employee = await registerInstanceUser(deployment.base, deployment.base, email);
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

async function configureDeployment(
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
  const login = await postJson(
    `${deployment.base}/_platform/api/login`,
    { email, password },
    { origin: deployment.base },
  );
  expect(login.status).toBe(200);
  expect(await login.json()).toMatchObject({ role: 'admin', email });
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  if (cookie === undefined) throw new Error('Deployed administrator session missing');
  const configured = await fetch(`${deployment.base}/_platform/api/admin/model-config`, {
    method: 'PUT',
    headers: { origin: deployment.base, cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ ...MODEL_CONFIG, apiKey: 'deployment-acceptance-key' }),
  });
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

it('boots delivered Compose and admits an employee through real administrator configuration to native DSH', async () => {
  await withDeployment(async (lifecycle, start) => {
    const { deployment, employee } = await configureDeployment(lifecycle, start);

    const admitted = await postJson(
      `${deployment.base}/_platform/api/instance/start`,
      {},
      { origin: deployment.base, cookie: employee.cookie },
    );
    expect(admitted.status).toBe(200);
    expect(await admitted.json()).toEqual({ status: 'starting', reason: 'starting' });
    await expect
      .poll(
        async () => {
          const response = await fetch(`${deployment.base}/_platform/api/instance`, {
            headers: { cookie: employee.cookie },
            signal: AbortSignal.timeout(2_000),
          });
          expect(response.status).toBe(200);
          return response.json();
        },
        { timeout: 60_000 },
      )
      .toEqual({ status: 'running', reason: null });

    const page = await fetch(deployment.base, { headers: { cookie: employee.cookie } });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    await page.arrayBuffer();
    const peer = await connectActivityPeer(deployment.port);
    try {
      peer.socket.write(
        activityUpgradeRequest(deployment.port, employee.cookie, deployment.base).replace(
          '/activity-ws',
          '/api/remote.mux',
        ),
      );
      expect((await observeHttp(peer.read('\r\n\r\n'))).toString()).toMatch(/^HTTP\/1\.1 101 /);
    } finally {
      peer.socket.destroy();
      await peer.closed;
    }
    const instance = await inspectAsync(lifecycle, `dsh-team-u-${employee.id}`);
    expect(record(instance.HostConfig).PortBindings ?? {}).toEqual({});
    const platform = await inspectAsync(lifecycle, 'dsh-team-platform');
    expect(platform.Mounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Source: deployment.dataDir,
          Destination: deployment.dataDir,
          RW: true,
        }),
        expect.objectContaining({
          Source: lifecycle.overlayDirectory,
          Destination: lifecycle.overlayDirectory,
          RW: true,
        }),
        expect.objectContaining({
          Source: '/var/run/docker.sock',
          Destination: '/var/run/docker.sock',
        }),
      ]),
    );
    expect(Object.keys(record(record(platform.HostConfig).PortBindings))).toEqual([
      `${String(deployment.port)}/tcp`,
    ]);
    const uidArgs = ['exec', 'dsh-team-platform', 'id', '-u'];
    expect(output(await lifecycle.commandAsync(uidArgs, 15_000), uidArgs).trim()).toBe('1000');
  });
});

it('drains an active composition helper after its caller disconnects before removing the platform', async () => {
  const fault = new Error('Controlled caller disconnect during composition');
  let owner: UserImageLifecycle | undefined;
  let helper: { id: string; labels: Record<string, string> } | undefined;
  let controller: ReturnType<typeof spawn> | undefined;
  let controllerClosed: Promise<number | null> | undefined;
  const controllerOutput: Buffer[] = [];
  const targets: CleanupTarget[] = [];
  const failures: unknown[] = [];
  try {
    let primary: unknown;
    await withDeployment(async (lifecycle, start) => {
      owner = lifecycle;
      const register = lifecycle.registerResourceAsync;
      lifecycle.registerResourceAsync = async (kind, name, ownership) => {
        await register(kind, name, ownership);
        targets.push({ kind, name, ownership });
      };
      targets.push(
        { kind: 'volume', name: lifecycle.stateVolume },
        { kind: 'volume', name: lifecycle.workVolume },
        { kind: 'image', name: `dsh-team-test-${lifecycle.runId}:container-start` },
      );
      const { deployment, employee } = await configureDeployment(lifecycle, start);
      const command = async (args: string[]) =>
        output(await lifecycle.commandAsync(args, 30_000), args);
      const home = `dsh-team-home-${employee.id}`;
      await command(['volume', 'create', '--label', `dsh-team.user=${employee.id}`, home]);
      const seed = `dsh-team-test-${lifecycle.runId}-fifo`;
      await lifecycle.registerResourceAsync('container', seed, { [OWNER_LABEL]: lifecycle.runId });
      await command([
        'create',
        '--name',
        seed,
        '--network',
        'none',
        '--label',
        `${OWNER_LABEL}=${lifecycle.runId}`,
        '--mount',
        `type=volume,source=${home},target=/data/home`,
        lifecycle.imageId,
        'sh',
        '-c',
        'rm -f /data/home/cordis.patch.yml && mkfifo -m 600 /data/home/cordis.patch.yml',
      ]);
      await command(['start', '--attach', seed]);
      const abort = new AbortController();
      const pending = fetch(`${deployment.base}/_platform/api/instance/start`, {
        method: 'POST',
        headers: {
          origin: deployment.base,
          cookie: employee.cookie,
          'content-type': 'application/json',
        },
        body: '{}',
        signal: abort.signal,
      }).catch((error: unknown) => error);
      try {
        await expect
          .poll(
            async () => {
              const ids = (
                await command([
                  'ps',
                  '--filter',
                  `label=dsh-team.user=${employee.id}`,
                  '--filter',
                  'label=dsh-team.role=managed-composition',
                  '--format',
                  '{{.ID}}',
                  '--no-trunc',
                ])
              )
                .trim()
                .split('\n')
                .filter(Boolean);
              const id = ids.length === 1 ? ids[0] : undefined;
              if (id === undefined) return false;
              const row = await inspectAsync(lifecycle, id);
              const invocation = record(record(row.Config).Labels)['dsh-team.invocation'];
              if (typeof invocation !== 'string') throw new Error('Missing helper invocation');
              const labels = {
                'dsh-team.user': employee.id,
                'dsh-team.role': 'managed-composition',
                'dsh-team.invocation': invocation,
              };
              expect(row.Id).toBe(id);
              expect(row.Name).toBe(`/dsh-team-compose-${employee.id}-${invocation}`);
              expect(row.Image).toBe(lifecycle.imageId);
              expect(record(row.Config).Labels).toMatchObject(labels);
              expect(row.Mounts).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({
                    Type: 'volume',
                    Name: home,
                    Destination: '/data/home',
                  }),
                ]),
              );
              helper = { id, labels };
              return (
                (await command(['exec', id, 'cat', '/proc/1/wchan'])).trim() === 'wait_for_partner'
              );
            },
            { timeout: 10_000, interval: 50 },
          )
          .toBe(true);
        if (helper === undefined) throw new Error('Missing captured helper');
        const platform = await inspectAsync(lifecycle, 'dsh-team-platform');
        expect(record(record(platform.Config).Labels)[OWNER_LABEL]).toBe(lifecycle.runId);
        if (typeof platform.Id !== 'string') throw new Error('Missing platform identity');
        // Independent child survives synchronous cleanup; event subscription precedes caller abort.
        const child = spawn(
          'python3',
          [
            join(lifecycle.repositoryRoot, 'platform/test/deployment-owner.py'),
            platform.Id,
            helper.id,
            dirname(lifecycle.overlayDirectory),
          ],
          { env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'ignore'] },
        );
        controller = child;
        controllerClosed = new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        child.stdout.on('data', (chunk: Buffer) => controllerOutput.push(chunk));
        const ready: unknown = await Promise.race([
          once(child.stdout, 'data'),
          controllerClosed.then(() => {
            throw new Error('Owner observer exited before subscription');
          }),
        ]);
        expect(Array.isArray(ready) && Buffer.isBuffer(ready[0]) ? ready[0].toString() : '').toBe(
          'armed\n',
        );
        abort.abort(fault);
        expect(await pending).toBe(fault);
        throw fault;
      } finally {
        abort.abort(fault);
        await pending;
      }
    }).catch((error: unknown) => {
      primary = error;
    });
    if (owner === undefined || helper === undefined) throw primary;
    expect(await controllerClosed).toBe(0);
    const lines = Buffer.concat(controllerOutput).toString().trim().split('\n');
    expect(lines[0]).toBe('armed');
    const summary: unknown = JSON.parse(lines[1] ?? 'null');
    expect(summary).toEqual({ signal: '15', helperDestroyedBeforeOwner: true, ownerExitCode: '0' });
    const observed = await owner.commandAsync(['container', 'inspect', helper.id], 15_000);
    expect(isAbsentResource(observed, 'container', helper.id)).toBe(true);
    expect(primary).toBeInstanceOf(AggregateError);
    if (!(primary instanceof AggregateError)) throw new Error('Missing original scenario failure');
    expect(primary.errors).toEqual([fault]);
  } catch (error) {
    failures.push(error);
  } finally {
    if (controller?.exitCode === null) controller.kill('SIGKILL');
    await controllerClosed?.catch((error: unknown) => failures.push(error));
    // Record the failure before emergency cleanup; only identities captured in this invocation.
    if (owner !== undefined) {
      if (helper !== undefined) {
        try {
          removeOwned(owner.command, 'container', helper.id, owner.runId, helper.labels);
        } catch (error) {
          failures.push(error);
        }
      }
      cleanupTargets(owner.command, targets, owner.runId, failures);
    }
  }
  if (failures.length > 0)
    throw new AggregateError(failures, 'Deployment failure-path regression failed');
});

it('preserves accounts, settings, audit and two unrestarted native instances across platform recreation', async () => {
  await withDeployment(async (lifecycle, start) => {
    const { deployment, employee, admin } = await configureDeployment(lifecycle, start);
    const second = await registerDeploymentEmployee(
      lifecycle,
      deployment,
      'second@deployment.example.test',
    );
    const gateway = instanceGatewayFixture({
      base: deployment.base,
      origin: deployment.base,
      lifecycle,
    });
    const adminRead = async (path: string) => {
      const response = await fetch(`${deployment.base}/_platform/api/admin/${path}`, {
        headers: { cookie: admin.cookie },
      });
      expect(response.status).toBe(200);
      return record(await response.json());
    };
    const settingsDigest = async () => {
      const args = [
        'exec',
        'dsh-team-platform',
        'node',
        '--input-type=module',
        '-e',
        `import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {loadConfig} from './platform/dist/config.js';
import {openDatabase,readSettings} from './platform/dist/db/index.js';
const db=openDatabase(join(loadConfig(process.env).dataDir,'platform.db'));
try { process.stdout.write(createHash('sha256').update(JSON.stringify(readSettings(db))).digest('hex')); }
finally { db.close(); }`,
      ];
      const digest = output(await lifecycle.commandAsync(args, 15_000), args);
      expect(digest).toMatch(/^[a-f0-9]{64}$/);
      return digest;
    };
    try {
      const instances = [];
      for (const user of [employee, second]) {
        expect(await gateway.state(user.cookie, true)).toEqual({
          status: 'starting',
          reason: 'starting',
        });
        await gateway.ready(user.cookie);
        const before = await inspectAsync(lifecycle, `dsh-team-u-${user.id}`);
        expect(record(before.State).Running).toBe(true);
        const created = await gateway.rpc(user.cookie, 'session/create', {
          request: { cwd: '/data/work', agentPreset: 'office-general' },
        });
        if (typeof created.sessionId !== 'string')
          throw new Error('Native Session identity missing');
        const title = `Persistence ${user.email}`;
        expect(
          await gateway.rpc(user.cookie, 'session/rename', {
            request: { sessionId: created.sessionId, title },
          }),
        ).toMatchObject({ title });
        instances.push({ user, before, sessionId: created.sessionId, title });
      }
      expect(instances.map((value) => value.sessionId)[0]).not.toBe(instances[1]?.sessionId);
      const originalPlatform = await inspectAsync(lifecycle, 'dsh-team-platform');
      const model = await adminRead('model-config');
      expect(model).toMatchObject({ ...MODEL_CONFIG, apiKeyConfigured: true });
      const settings = await settingsDigest();
      const audit = await adminRead('audit-events?pageSize=100');
      expect(audit.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ targetEmail: employee.email }),
          expect.objectContaining({ targetEmail: second.email }),
        ]),
      );
      expect((await adminRead('audit-events?pageSize=100&page=2')).items).toEqual([]);

      await recreateDeployment(lifecycle, deployment);
      await waitForDeployment(deployment);

      const replacement = await inspectAsync(lifecycle, 'dsh-team-platform');
      expect(replacement.Id).not.toBe(originalPlatform.Id);
      expect(record(replacement.Config).Labels).toMatchObject({ [OWNER_LABEL]: lifecycle.runId });
      // Inspect before fresh logins append their legitimate audit events.
      expect(await adminRead('model-config')).toEqual(model);
      expect(await settingsDigest()).toBe(settings);
      expect(await adminRead('audit-events?pageSize=100')).toEqual(audit);
      for (const { user, before, sessionId, title } of instances) {
        const after = await inspectAsync(lifecycle, `dsh-team-u-${user.id}`);
        expect(after.Id).toBe(before.Id);
        expect(record(after.State)).toMatchObject({
          Running: true,
          StartedAt: record(before.State).StartedAt,
        });
        expect(after.RestartCount).toBe(before.RestartCount);
        expect(orderedMounts(after.Mounts)).toEqual(orderedMounts(before.Mounts));
        expect(record(after.NetworkSettings).Networks).toEqual(
          record(before.NetworkSettings).Networks,
        );
        const login = await postJson(
          `${deployment.base}/_platform/api/login`,
          { email: user.email, password: 'instance-acceptance-password' },
          { origin: deployment.base },
        );
        expect(login.status).toBe(200);
        expect(await login.json()).toMatchObject({ id: user.id, email: user.email });
        const cookie = login.headers.get('set-cookie')?.split(';')[0];
        if (cookie === undefined) throw new Error('Restored account session missing');
        expect(await gateway.state(cookie)).toEqual({ status: 'running', reason: null });
        const projection = await gateway.rpc(cookie, 'session/projections', {
          request: { sessionId },
        });
        expect(record(projection.values).title).toBe(title);
        const peer = await gateway.open(cookie);
        peer.socket.destroy();
        await peer.closed;
      }
      const adminLogin = await postJson(
        `${deployment.base}/_platform/api/login`,
        { email: admin.email, password: admin.password },
        { origin: deployment.base },
      );
      expect(adminLogin.status).toBe(200);
      expect(await adminLogin.json()).toMatchObject({ email: admin.email, role: 'admin' });
    } finally {
      gateway.close();
    }
  });
});
