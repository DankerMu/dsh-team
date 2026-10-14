import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { MODEL_CONFIG } from './admin-config-fixture.ts';
import { postJson } from './auth-tcp-fixture.ts';
import { matchingPasswords, runPty } from './cli-process-fixture.ts';
import { inspectAsync, record } from './container-start-docker-fixture.ts';
import { output } from './docker-cleanup.ts';
import { withDeployment } from './deployment-fixture.ts';
import { activityUpgradeRequest, connectActivityPeer } from './gateway-activity-fixture.ts';
import { observeHttp } from './gateway-http-fixture.ts';
import { registerInstanceUser } from './instance-fixture.ts';

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

it('boots delivered Compose and admits an employee through real administrator configuration to native DSH', async () => {
  await withDeployment(async (lifecycle, start) => {
    const deployment = await start();
    // Only readiness polling; failed deployment is never retried or recreated.
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
    const employee = await registerInstanceUser(
      deployment.base,
      deployment.base,
      'employee@deployment.example.test',
    );
    const ownership = { 'dsh-team.user': employee.id };
    for (const [kind, name] of [
      ['container', `dsh-team-u-${employee.id}`],
      ['volume', `dsh-team-home-${employee.id}`],
      ['volume', `dsh-team-work-${employee.id}`],
      ['network', `dsh-team-net-${employee.id}`],
    ] as const)
      await lifecycle.registerResourceAsync(kind, name, ownership);

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
