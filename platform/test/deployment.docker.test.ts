import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { MODEL_CONFIG } from './admin-config-fixture.ts';
import { postJson } from './auth-tcp-fixture.ts';
import { inspectAsync, record } from './container-start-docker-fixture.ts';
import { cleanupTargets, output, OWNER_LABEL, removeOwned } from './docker-cleanup.ts';
import type { CleanupTarget } from './docker-cleanup.ts';
import { isAbsentResource } from './docker-command.ts';
import { verifyAssetTransfer } from './deployment-asset-transfer-fixture.ts';
import { recreateDeployment, withDeployment } from './deployment-fixture.ts';
import { removeRetiredObservationRoot } from './deployment-observer-fixture.ts';
import type { DeploymentObservation } from './deployment-observer-fixture.ts';
import {
  configureDeployment,
  registerDeploymentEmployee,
  waitForDeployment,
} from './deployment-account-fixture.ts';
import { verifyCredentialIsolation } from './deployment-credential-isolation-fixture.ts';
import { verifyHttpIsolation } from './deployment-http-isolation-fixture.ts';
import { verifyInternalIsolation } from './deployment-internal-isolation-fixture.ts';
import { verifyStreamIsolation } from './deployment-stream-isolation-fixture.ts';
import { verifyDeployedCredentialPrivacy } from './deployment-privacy-fixture.ts';
import { prepareTlsDeployment, verifyTlsCarrier } from './deployment-tls-fixture.ts';
import { activityUpgradeRequest, connectActivityPeer } from './gateway-activity-fixture.ts';
import { observeHttp } from './gateway-http-fixture.ts';
import { instanceGatewayFixture, orderedMounts } from './instance-gateway-docker-fixture.ts';
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

it('keeps deployment admission exclusive across distinct invocation temporary directories', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-team-deployment-lock-'));
  const contenderTemporary = join(temporary, 'contender');
  await mkdir(contenderTemporary);
  const fixtureUrl = new URL('./deployment-fixture.ts', import.meta.url).href;
  // Keep real lifecycle/flock; replace only Docker work and unused Vitest-dependent helpers.
  const source = `
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
const fixtureUrl = ${JSON.stringify(fixtureUrl)};
const dependencies = {
  './user-image-fixture.ts': 'export async function runUserImage() { process.stdout.write("admitted\\\\n"); }',
  './gateway-http-fixture.ts': 'export const unusedPort = () => { throw new Error("Unexpected listener"); };',
};
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === fixtureUrl && Object.hasOwn(dependencies, specifier))
      return { url: 'data:text/javascript,' + encodeURIComponent(dependencies[specifier]), shortCircuit: true };
    return next(specifier, context);
  },
});
if (tmpdir() !== ${JSON.stringify(contenderTemporary)}) throw new Error('Private temporary directory lost');
const { withDeployment } = await import(fixtureUrl);
try { await withDeployment(async () => {}); }
catch (error) {
  if (error.message !== 'Deployment verification lock unavailable') throw error;
  process.stdout.write('excluded\\n');
}
`;
  const contender = () =>
    promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: contenderTemporary },
      encoding: 'utf8',
      timeout: 15_000,
    });
  try {
    await withDeployment(async () => {
      const held = await contender();

      expect(held.stdout).toBe('excluded\n');
    });
    const released = await contender();

    expect(released.stdout).toBe('admitted\n');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

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
    await verifyAssetTransfer(deployment, employee.cookie);
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
  let observation: DeploymentObservation | undefined;
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
      observation = deployment.observation;
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
  // Only a fully asserted controlled failure retires its own retained evidence root.
  if (failures.length === 0) {
    if (observation === undefined) failures.push(new Error('Deployment observation missing'));
    else
      await removeRetiredObservationRoot(observation).catch((error: unknown) =>
        failures.push(error),
      );
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

async function expectSocketIsolation(
  container: Record<string, unknown>,
  isPlatform: boolean,
  socketSource: string,
) {
  if (!Array.isArray(container.Mounts)) throw new Error('Missing deployment mount inventory');
  const mounts = container.Mounts.map((value: unknown) => record(value));
  if (isPlatform) {
    expect(mounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Type: 'bind',
          Source: '/var/run/docker.sock',
          Destination: '/var/run/docker.sock',
        }),
      ]),
    );
    return;
  }
  for (const mount of mounts) {
    expect(mount.Destination).not.toBe('/var/run/docker.sock');
    if (mount.Type !== 'bind') continue;
    if (typeof mount.Source !== 'string') throw new Error('Missing bind source');
    const source = await realpath(mount.Source);
    const prefix = source.endsWith('/') ? source : `${source}/`;
    expect(
      source === socketSource || socketSource.startsWith(prefix),
      'Non-platform Docker socket source exposure',
    ).toBe(false);
  }
}

it('publishes only the platform port and mounts the Docker socket only there with two native instances', async () => {
  await withDeployment(async (lifecycle, start) => {
    const { deployment, employee } = await configureDeployment(lifecycle, start);
    const second = await registerDeploymentEmployee(
      lifecycle,
      deployment,
      'second@exposure.example.test',
    );
    const gateway = instanceGatewayFixture({
      base: deployment.base,
      origin: deployment.base,
      lifecycle,
    });
    const expectedIds = [];
    try {
      for (const user of [employee, second]) {
        expect(await gateway.state(user.cookie, true)).toEqual({
          status: 'starting',
          reason: 'starting',
        });
        await gateway.ready(user.cookie);
        const instance = await inspectAsync(lifecycle, `dsh-team-u-${user.id}`);
        expect(record(instance.State).Running).toBe(true);
        expectedIds.push(instance.Id);
      }
      const platform = await inspectAsync(lifecycle, 'dsh-team-platform');
      expectedIds.push(platform.Id);
      const project = record(record(platform.Config).Labels)['com.docker.compose.project'];
      if (typeof project !== 'string') throw new Error('Missing deployment project identity');
      const ids = new Set<string>();
      for (const label of [
        `${OWNER_LABEL}=${lifecycle.runId}`,
        `com.docker.compose.project=${project}`,
        `dsh-team.user=${employee.id}`,
        `dsh-team.user=${second.id}`,
      ]) {
        const args = [
          'ps',
          '-a',
          '--filter',
          `label=${label}`,
          '--format',
          '{{.ID}}',
          '--no-trunc',
        ];
        const listed = output(await lifecycle.commandAsync(args, 30_000), args);
        for (const id of listed.trim().split('\n').filter(Boolean)) ids.add(id);
      }
      expect([...ids]).toEqual(expect.arrayContaining(expectedIds));
      const socketSource = await realpath('/var/run/docker.sock');
      const publications = new Set<string>();
      for (const id of ids) {
        const container = await inspectAsync(lifecycle, id);
        const host = record(container.HostConfig);
        const ports = record(record(container.NetworkSettings).Ports);
        const isPlatform = id === platform.Id;
        expect(host.PublishAllPorts).toBe(false);
        expect(host.NetworkMode).not.toMatch(/^(?:host$|container:)/);
        const configured = record(host.PortBindings ?? {});
        if (isPlatform) {
          const portKey = `${String(deployment.port)}/tcp`;
          expect(Object.keys(configured)).toEqual([portKey]);
          expect(configured[portKey]).toEqual([
            expect.objectContaining({ HostPort: String(deployment.port) }),
          ]);
          // Image EXPOSE entries with null bindings are not published host ports.
          expect(Object.keys(ports).filter((key) => ports[key] !== null)).toEqual([portKey]);
          const effective: unknown = ports[portKey];
          if (!Array.isArray(effective)) throw new Error('Missing effective platform publication');
          for (const binding of effective) {
            expect(record(binding).HostPort).toBe(String(deployment.port));
            publications.add(`${String(record(binding).HostPort)}/tcp`);
          }
        } else {
          expect(configured, 'Non-platform configured publication').toEqual({});
          for (const binding of Object.values(ports))
            expect(binding, 'Non-platform effective publication').toBeNull();
        }
        await expectSocketIsolation(container, isPlatform, socketSource);
      }
      expect([...publications]).toEqual([`${String(deployment.port)}/tcp`]);
    } finally {
      gateway.close();
    }
  });
});

it('serves native HTTPS and WSS behind an exact trusted TLS proxy with Secure cookies and client audit identity', async () => {
  let tls: Awaited<ReturnType<typeof prepareTlsDeployment>> | undefined;
  await withDeployment(
    async (lifecycle, start) => {
      const { deployment, employee, admin } = await configureDeployment(lifecycle, start);
      if (tls === undefined) throw new Error('TLS preparation missing');
      const correlation = randomUUID();
      const login = await deployment.request(`${deployment.base}/_platform/api/login`, {
        method: 'POST',
        headers: {
          origin: deployment.base,
          'content-type': 'application/json',
          'x-test-correlation': correlation,
          'x-forwarded-for': '203.0.113.99',
        },
        body: JSON.stringify({ email: employee.email, password: 'instance-acceptance-password' }),
      });
      expect(login.status).toBe(200);
      expect(await login.json()).toMatchObject({ id: employee.id });
      const setCookie = login.headers.get('set-cookie');
      expect(
        setCookie?.split(';').some((part) => part.trim() === 'Secure'),
        'Secure session attribute',
      ).toBe(true);
      const cookie = setCookie?.split(';')[0];
      if (cookie === undefined) throw new Error('TLS employee session missing');
      const headers = { cookie, origin: deployment.base, 'content-type': 'application/json' };
      const started = await deployment.request(`${deployment.base}/_platform/api/instance/start`, {
        method: 'POST',
        headers,
        body: '{}',
      });
      expect(await started.json()).toEqual({ status: 'starting', reason: 'starting' });
      await expect
        .poll(
          async () => {
            const response = await deployment.request(`${deployment.base}/_platform/api/instance`, {
              headers,
            });
            expect(response.status).toBe(200);
            return response.json();
          },
          { timeout: 60_000 },
        )
        .toEqual({ status: 'running', reason: null });
      const page = await deployment.request(deployment.base, { headers });
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toContain('text/html');
      const html = await page.text();
      expect(html).toMatch(/<!doctype html/i);
      expect(html).toMatch(/<script[^>]+src=/i);
      await verifyTlsCarrier(deployment, tls.certificate, cookie);
      const logs = ['logs', tls.name];
      const peers = output(await lifecycle.commandAsync(logs, 30_000), logs)
        .trim()
        .split('\n')
        .map((line) => record(JSON.parse(line) as unknown))
        .filter((entry) => entry.correlation === correlation);
      expect(peers).toHaveLength(1);
      const client = peers[0]?.peer;
      expect(typeof client).toBe('string');
      expect(client).not.toBe(tls.address);
      expect(client).not.toBe('203.0.113.99');
      const audit = await deployment.request(
        `${deployment.base}/_platform/api/admin/audit-events?pageSize=100`,
        {
          headers: { cookie: admin.cookie },
        },
      );
      expect(audit.status).toBe(200);
      const items = record(await audit.json()).items;
      if (!Array.isArray(items)) throw new Error('Missing HTTPS audit inventory');
      const logins = items
        .map((item: unknown) => record(item))
        .filter((item) => item.type === 'login.succeeded' && item.targetEmail === employee.email);
      expect(logins).toHaveLength(2);
      expect(logins[0]?.sourceAddress, 'Trusted proxy client audit source').toBe(client);
    },
    async (lifecycle, deployment) => {
      tls = await prepareTlsDeployment(lifecycle, deployment);
    },
  );
});

it('keeps hostile employee HTTP requests inside their own native instance and rejects administrator access', async () => {
  await withDeployment(async (lifecycle, start) => {
    const { deployment, employee: a, admin } = await configureDeployment(lifecycle, start);
    const b = await registerDeploymentEmployee(
      lifecycle,
      deployment,
      'isolated@deployment.example.test',
    );
    await verifyHttpIsolation(lifecycle, deployment, a, b, admin);
  });
});

it('rejects another employee Session over native logical streams while preserving own live delivery', async () => {
  await withDeployment(async (lifecycle, start) => {
    const { deployment, employee } = await configureDeployment(lifecycle, start);
    const second = await registerDeploymentEmployee(
      lifecycle,
      deployment,
      'stream@deployment.example.test',
    );
    await verifyStreamIsolation(lifecycle, deployment, employee, second);
  });
});

it('denies internal employee access to sibling volumes, listening ports, Docker and platform authority', async () => {
  await withDeployment(async (lifecycle, start) => {
    const { deployment, employee, admin } = await configureDeployment(lifecycle, start);
    const second = await registerDeploymentEmployee(
      lifecycle,
      deployment,
      'internal@deployment.example.test',
    );
    await verifyInternalIsolation(lifecycle, deployment, employee, second, admin);
  });
});

it('rejects sibling native credentials and keeps platform data outside employee files and environments', async () => {
  await withDeployment(async (lifecycle, start) => {
    const { deployment, employee, admin } = await configureDeployment(lifecycle, start);
    const second = await registerDeploymentEmployee(
      lifecycle,
      deployment,
      'credential@deployment.example.test',
    );
    await verifyCredentialIsolation(lifecycle, deployment, employee, second, admin);
  });
});

it('keeps every used credential and marked conversation out of deployed audit rows and platform logs while covering all declared audit events', () =>
  verifyDeployedCredentialPrivacy());
