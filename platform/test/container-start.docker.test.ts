import { readFile, stat } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { expect, it } from 'vitest';
import { applyMigrations, openDatabase, writeSettings } from '../src/db/index.ts';
import { buildApp } from '../src/app.ts';
import type { PlatformConfig } from '../src/config.ts';
import { createDockerClient, startUserContainer } from '../src/orchestrator/index.ts';
import { runUserImage } from './user-image-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';
import { START_MODEL, START_PERMISSION } from './container-start-fixture.ts';
import { observeWebEndpoint } from './web-startup-fixture.ts';

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid acceptance inspect');
  // Docker JSON crosses an external boundary; callers assert each consumed field.
  return value as Record<string, unknown>;
}

function inspect(lifecycle: UserImageLifecycle, name: string): Record<string, unknown> {
  const result = lifecycle.command(['container', 'inspect', name], 15_000);
  if (result.status !== 0 || result.error !== undefined)
    throw new Error('Independent container inspect failed');
  const rows: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(rows) || rows.length !== 1)
    throw new Error('Independent inspect missing container');
  return record(rows[0]);
}

/** Shared actual-start transport: registers production helpers before their create request. */
function startupClient(lifecycle: UserImageLifecycle) {
  const raw = createDockerClient('/var/run/docker.sock');
  const helperIds: string[] = [];
  const client: typeof raw = {
    logs: (path, signal) => raw.logs(path, signal),
    async json(method, path, body, signal) {
      const helperCreate =
        method === 'POST' && path.startsWith('/containers/create?name=dsh-team-compose-');
      let helperName = '';
      let userId = '';
      if (helperCreate) {
        helperName = new URL(`http://docker${path}`).searchParams.get('name') ?? '';
        const labels = record(record(body).Labels);
        const invocation = labels['dsh-team.invocation'];
        const user = labels['dsh-team.user'];
        if (typeof invocation !== 'string' || typeof user !== 'string')
          throw new Error('Helper ownership missing');
        userId = user;
        lifecycle.registerResource('container', helperName, {
          'dsh-team.user': userId,
          'dsh-team.role': 'managed-composition',
          'dsh-team.invocation': invocation,
        });
      }
      const deadline = AbortSignal.timeout(30_000);
      const result = await raw.json(
        method,
        path,
        body,
        signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
      );
      if (helperCreate) {
        const helper = inspect(lifecycle, helperName);
        expect(helper.Image).toBe(lifecycle.imageId);
        const configuration = record(helper.Config);
        expect(configuration.User).toBe('1001');
        expect(configuration.Env).not.toEqual(
          expect.arrayContaining([expect.stringMatching(/^DMXAPI_KEY=/)]),
        );
        const host = record(helper.HostConfig);
        expect(host.NetworkMode).toBe('none');
        expect(host.Privileged).toBe(false);
        expect(
          host.PortBindings === null || Object.keys(record(host.PortBindings)).length === 0,
        ).toBe(true);
        expect(helper.Mounts).toEqual([
          expect.objectContaining({
            Type: 'volume',
            Name: `dsh-team-home-${userId}`,
            Destination: '/data/home',
            RW: true,
          }),
        ]);
        helperIds.push(String(helper.Id));
      }
      return result;
    },
  };
  return { raw, client, helperIds };
}

async function startupScenario(lifecycle: UserImageLifecycle): Promise<string> {
  const userId = lifecycle.runId.replaceAll('-', '').slice(0, 12);
  const name = `dsh-team-u-${userId}`;
  const ownership = { 'dsh-team.user': userId };
  // Grant cleanup authority only after exact preflight absence, before any production create.
  lifecycle.registerResource('volume', lifecycle.stateVolume, ownership);
  lifecycle.registerResource('volume', lifecycle.workVolume, ownership);
  lifecycle.registerResource('container', name, ownership);
  const db = openDatabase(join(dirname(lifecycle.overlayDirectory), 'platform.db'));
  const { raw, client, helperIds } = startupClient(lifecycle);
  const policy: unknown = JSON.parse(await readFile(lifecycle.seccomp, 'utf8'));
  try {
    applyMigrations(db);
    db.prepare(
      "INSERT INTO users VALUES (?, 'startup@example.test', 'unused-hash', 'employee', 'active', 1)",
    ).run(userId);
    const ids: string[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await startUserContainer({
        client,
        database: db,
        userId,
        config: {
          userImage: lifecycle.imageId,
          seccompProfilePath: lifecycle.seccomp,
          managedConfigDir: lifecycle.overlayDirectory,
          authority: 'startup.example:8443',
        },
        modelSettings: START_MODEL,
        modelKey: 'docker-acceptance-only-not-a-model-credential',
        permission: START_PERMISSION,
      });
      expect(result.outcome).toBe('starting');
      if (result.outcome !== 'starting') throw new Error('Expected configured startup');
      const container = inspect(lifecycle, name);
      expect(container.Id).toBe(result.containerId);
      expect(container.Image).toBe(lifecycle.imageId);
      expect(container.Name).toBe(`/${name}`);
      expect(record(container.State).Running).toBe(true);
      const config = record(container.Config);
      expect(config.Hostname).toBe(`u-${userId}`);
      expect(config.User).toBe('1001');
      expect(config.WorkingDir).toBe('/data/work');
      expect(config.Labels).toMatchObject(ownership);
      expect(config.Cmd).toEqual([
        'dsh',
        '--profile',
        'web',
        '--patch',
        '/managed/patch.yml',
        '--no-open',
        '--trusted-host',
        'startup.example:8443',
      ]);
      expect(config.Env).toEqual(
        expect.arrayContaining([
          'DSH_HOME=/data/home',
          'DSH_TELEMETRY_DISABLED=1',
          'DMXAPI_KEY=docker-acceptance-only-not-a-model-credential',
        ]),
      );
      const host = record(container.HostConfig);
      expect(host.Privileged).toBe(false);
      expect(host.CapAdd === null || (Array.isArray(host.CapAdd) && host.CapAdd.length === 0)).toBe(
        true,
      );
      expect(Array.isArray(host.MaskedPaths) && host.MaskedPaths.length > 0).toBe(true);
      expect(Array.isArray(host.ReadonlyPaths) && host.ReadonlyPaths.length > 0).toBe(true);
      const options = host.SecurityOpt;
      if (
        !Array.isArray(options) ||
        options.length !== 1 ||
        typeof options[0] !== 'string' ||
        !options[0].startsWith('seccomp=')
      )
        throw new Error('Expected only configured seccomp');
      expect(JSON.parse(options[0].slice('seccomp='.length))).toEqual(policy);
      const overlay = join(lifecycle.overlayDirectory, `${userId}.patch.yml`);
      expect(container.Mounts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            Type: 'volume',
            Name: lifecycle.stateVolume,
            Destination: '/data/home',
            RW: true,
          }),
          expect.objectContaining({
            Type: 'volume',
            Name: lifecycle.workVolume,
            Destination: '/data/work',
            RW: true,
          }),
          expect.objectContaining({
            Type: 'bind',
            Source: overlay,
            Destination: '/managed/patch.yml',
            RW: false,
          }),
        ]),
      );
      expect(container.Mounts).toHaveLength(3);
      expect((await stat(overlay)).mode & 0o777).toBe(0o444);
      const overlayText = await readFile(overlay, 'utf8');
      expect(overlayText).not.toContain('docker-acceptance-only-not-a-model-credential');
      expect(JSON.parse(overlayText)).toContainEqual({
        id: 'webserver',
        config: { host: '0.0.0.0', port: 3080 },
      });
      expect(record(container.NetworkSettings).Ports).toEqual({
        '3080/tcp': [{ HostIp: '127.0.0.1', HostPort: String(result.upstreamPort) }],
      });
      expect(result.upstreamHost).toBe('127.0.0.1');
      expect(result.upstreamPort).toBeGreaterThan(0);
      expect(db.prepare('SELECT * FROM instances WHERE user_id = ?').get(userId)).toMatchObject({
        status: 'starting',
        container_id: result.containerId,
        image_tag: lifecycle.imageId,
        upstream_host: '127.0.0.1',
        upstream_port: result.upstreamPort,
        // Vitest's matcher is untyped; it is an expected-value sentinel, not database data.
        last_started_at: expect.any(Number) as unknown,
        dsh_cookie: null,
      });
      ids.push(result.containerId);
      if (attempt === 0) {
        // Fixture-owned exact removal only; production operation does not adopt or delete instances.
        expect(record(inspect(lifecycle, name).Config).Labels).toMatchObject(ownership);
        await raw.json(
          'DELETE',
          `/containers/${result.containerId}?force=true`,
          undefined,
          AbortSignal.timeout(15_000),
        );
      }
    }
    expect(ids[0]).not.toBe(ids[1]);
    expect(
      db.prepare('SELECT event_type, target, details FROM audit_events ORDER BY id').all(),
    ).toEqual([
      { event_type: 'instance.created', target: userId, details: '{}' },
      { event_type: 'instance.started', target: userId, details: '{}' },
      { event_type: 'instance.created', target: userId, details: '{}' },
      { event_type: 'instance.started', target: userId, details: '{}' },
    ]);
    expect(helperIds).toHaveLength(2);
    for (const id of helperIds)
      await expect(
        raw.json('GET', `/containers/${id}/json`, undefined, AbortSignal.timeout(15_000)),
      ).rejects.toMatchObject({ statusCode: 404 });
    return JSON.stringify({
      status: 'starting',
      starts: 2,
      hostname: `u-${userId}`,
      independentInspection: true,
      audits: 4,
      helpersRemoved: 2,
    });
  } finally {
    db.close();
  }
}

it('starts through the exported operation and recreates owned DSH with stable hostname, inspected endpoint and SQLite audits', async () => {
  if (platform() !== 'linux' || arch() !== 'x64')
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  const result = await runUserImage(
    'container-start',
    (summary) => {
      expect(JSON.parse(summary)).toMatchObject({
        status: 'starting',
        starts: 2,
        independentInspection: true,
        audits: 4,
        helpersRemoved: 2,
      });
    },
    undefined,
    startupScenario,
  );
  process.stdout.write(
    `Docker exported startup verified: run=${result.runId} image=${result.image} readback=${result.stdout} cleanup=complete\n`,
  );
});

// Only the forked child touches the oversized mapping. Parent observes its cgroup
// and wait status; a timeout, allocation exception or exit137 alone is not an OOM.
const oomScript = `
import json, mmap, os, pathlib, signal, struct
cgroup = pathlib.Path("/sys/fs/cgroup")
events = cgroup / "memory.events"
if not events.is_file():
    raise RuntimeError("Resource acceptance requires observable cgroup v2 memory.events")
def counters():
    return dict((key, int(value)) for key, value in
                (line.split() for line in events.read_text().splitlines()))
limits = {name: (cgroup / name).read_text().strip()
          for name in ["memory.max", "memory.swap.max", "pids.max"]}
if limits != {"memory.max": "268435456", "memory.swap.max": "0", "pids.max": "512"}:
    raise RuntimeError("Owned allocation cgroup limits differ from inspected settings")
before = counters()
progress = mmap.mmap(-1, 8)
signal.alarm(25)
pid = os.fork()
if pid == 0:
    signal.alarm(20)
    allocation = mmap.mmap(-1, 536870912)
    for offset in range(0, 536870912, 4096):
        allocation[offset] = 1
        struct.pack_into("Q", progress, 0, offset + 4096)
    os._exit(0)
_, status = os.waitpid(pid, 0)
signal.alarm(0)
after = counters()
print(json.dumps({
    "requestedBytes": 536870912,
    "touchedBytes": struct.unpack_from("Q", progress, 0)[0],
    "childSignal": os.WTERMSIG(status) if os.WIFSIGNALED(status) else 0,
    "oomKillBefore": before["oom_kill"], "oomKillAfter": after["oom_kill"],
    "limits": limits
}), flush=True)
`;

async function resourceScenario(lifecycle: UserImageLifecycle): Promise<string> {
  const userA = lifecycle.runId.replaceAll('-', '').slice(0, 12);
  const userB = `${userA.startsWith('a') ? 'b' : 'a'}${userA.slice(1)}`;
  const authority = 'resource.example:8443';
  const db = openDatabase(join(dirname(lifecycle.overlayDirectory), 'resource-platform.db'));
  const { raw, client, helperIds } = startupClient(lifecycle);
  const config: PlatformConfig = {
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    dataDir: dirname(lifecycle.overlayDirectory),
    managedConfigDir: lifecycle.overlayDirectory,
    dockerSocketPath: '/var/run/docker.sock',
    userImage: lifecycle.imageId,
    seccompProfilePath: lifecycle.seccomp,
    publicUrl: `http://${authority}`,
    authority,
    cookieSecure: false,
    trustedProxies: [],
  };
  const limitsA = {
    NanoCpus: 500_000_000,
    Memory: 536_870_912,
    MemorySwap: 536_870_912,
    PidsLimit: 512,
  };
  const limitsB = {
    NanoCpus: 1_250_000_000,
    Memory: 268_435_456,
    MemorySwap: 268_435_456,
    PidsLimit: 512,
  };
  let app: FastifyInstance | undefined;
  const failures: unknown[] = [];
  let summary = '';
  try {
    applyMigrations(db);
    app = await buildApp(config, db);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const health = async () => {
      const response = await fetch(`${address}/healthz`, { signal: AbortSignal.timeout(2_000) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok' });
    };
    for (const user of [userA, userB]) {
      const ownership = { 'dsh-team.user': user };
      lifecycle.registerResource('volume', `dsh-team-home-${user}`, ownership);
      lifecycle.registerResource('volume', `dsh-team-work-${user}`, ownership);
      lifecycle.registerResource('container', `dsh-team-u-${user}`, ownership);
      db.prepare("INSERT INTO users VALUES (?, ?, 'unused-hash', 'employee', 'active', 1)").run(
        user,
        `${user}@resource.example`,
      );
    }
    writeSettings(db, { cpuCores: 0.5, memoryMiB: 512 });
    const a = await startUserContainer({
      client,
      database: db,
      userId: userA,
      config,
      modelSettings: START_MODEL,
      modelKey: 'docker-acceptance-only-not-a-model-credential',
      permission: START_PERMISSION,
    });
    if (a.outcome !== 'starting') throw new Error('Expected configured sibling startup');
    const firstA = inspect(lifecycle, a.containerId);
    expect(firstA.Id).toBe(a.containerId);
    expect(firstA.Image).toBe(lifecycle.imageId);
    expect(record(firstA.Config).Labels).toMatchObject({ 'dsh-team.user': userA });
    expect(firstA.HostConfig).toMatchObject(limitsA);
    await observeWebEndpoint(lifecycle.command, a.containerId, () => a.upstreamPort, authority);
    await health();

    writeSettings(db, { cpuCores: 1.25, memoryMiB: 256 });
    const b = await startUserContainer({
      client,
      database: db,
      userId: userB,
      config,
      modelSettings: START_MODEL,
      modelKey: 'docker-acceptance-only-not-a-model-credential',
      permission: START_PERMISSION,
    });
    if (b.outcome !== 'starting') throw new Error('Expected configured bounded startup');
    const bounded = inspect(lifecycle, b.containerId);
    expect(bounded.Id).toBe(b.containerId);
    expect(bounded.Image).toBe(lifecycle.imageId);
    expect(record(bounded.Config).Labels).toMatchObject({ 'dsh-team.user': userB });
    expect(bounded.HostConfig).toMatchObject({
      ...limitsB,
      Privileged: false,
      OomKillDisable: false,
    });
    expect(inspect(lifecycle, a.containerId).HostConfig).toMatchObject(limitsA);
    await observeWebEndpoint(lifecycle.command, b.containerId, () => b.upstreamPort, authority);
    await observeWebEndpoint(lifecycle.command, a.containerId, () => a.upstreamPort, authority);
    await health();

    const pressure = lifecycle.command(
      ['exec', '--user', '1001', b.containerId, 'python3', '-c', oomScript],
      30_000,
    );
    if (pressure.error !== undefined || pressure.status !== 0)
      throw new Error('Owned OOM observer failed or exceeded its deadline');
    const oom = record(JSON.parse(pressure.stdout));
    expect(oom).toMatchObject({
      requestedBytes: 536_870_912,
      childSignal: 9,
      limits: { 'memory.max': '268435456', 'memory.swap.max': '0', 'pids.max': '512' },
    });
    if (
      typeof oom.touchedBytes !== 'number' ||
      typeof oom.oomKillBefore !== 'number' ||
      typeof oom.oomKillAfter !== 'number'
    )
      throw new Error('Missing physical-touch or cgroup OOM evidence');
    expect(oom.touchedBytes).toBeGreaterThan(0);
    expect(oom.touchedBytes).toBeLessThan(536_870_912);
    expect(oom.oomKillAfter).toBeGreaterThan(oom.oomKillBefore);

    const afterA = inspect(lifecycle, a.containerId);
    expect(afterA.Id).toBe(firstA.Id);
    expect(afterA.HostConfig).toEqual(firstA.HostConfig);
    expect(record(afterA.State).Running).toBe(true);
    await observeWebEndpoint(lifecycle.command, a.containerId, () => a.upstreamPort, authority);
    await health();
    expect(
      db.prepare('SELECT user_id, container_id FROM instances ORDER BY user_id').all(),
    ).toEqual(
      [
        { user_id: userA, container_id: a.containerId },
        { user_id: userB, container_id: b.containerId },
      ].sort((left, right) => left.user_id.localeCompare(right.user_id)),
    );
    expect(helperIds).toHaveLength(2);
    for (const id of helperIds)
      await expect(
        raw.json('GET', `/containers/${id}/json`, undefined, AbortSignal.timeout(15_000)),
      ).rejects.toMatchObject({ statusCode: 404 });
    summary = JSON.stringify({
      independentInspection: true,
      settingsRefreshed: true,
      siblingUnchanged: true,
      siblingHttpBeforeAfter: 401,
      platformHealthBeforeAfter: 200,
      oom,
    });
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      if (app === undefined) db.close();
      else await app.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length !== 0) throw new AggregateError(failures, 'Resource acceptance failed');
  return summary;
}

it('enforces refreshed create-time limits and confines a physical 512MiB OOM to the 256MiB instance', async () => {
  if (platform() !== 'linux' || arch() !== 'x64')
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  const result = await runUserImage(
    'container-start',
    (summary) => {
      expect(JSON.parse(summary)).toMatchObject({
        independentInspection: true,
        settingsRefreshed: true,
        siblingUnchanged: true,
        siblingHttpBeforeAfter: 401,
        platformHealthBeforeAfter: 200,
      });
    },
    undefined,
    resourceScenario,
  );
  process.stdout.write(
    `Docker resource isolation verified: run=${result.runId} image=${result.image} readback=${result.stdout} cleanup=complete\n`,
  );
});
