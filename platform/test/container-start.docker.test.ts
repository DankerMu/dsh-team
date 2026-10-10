import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { expect, it } from 'vitest';
import { applyMigrations, openDatabase, writeSettings } from '../src/db/index.ts';
import { buildApp } from '../src/app.ts';
import type { PlatformConfig } from '../src/config.ts';
import { createOrchestrator, extractLaunchToken } from '../src/orchestrator/index.ts';
import { runUserImage } from './user-image-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';
import { START_MODEL } from './container-start-fixture.ts';
import { observeWebEndpoint } from './web-startup-fixture.ts';
import { observeResourceOom } from './resource-oom-fixture.ts';
import {
  cookieHttpStatus,
  inspect,
  record,
  startupClient,
} from './container-start-docker-fixture.ts';

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
  const { startUserContainer } = createOrchestrator({
    client,
    database: db,
    config: { upstreamMode: 'published-loopback', platformContainerName: 'dsh-team-platform' },
  });
  const policy: unknown = JSON.parse(await readFile(lifecycle.seccomp, 'utf8'));
  try {
    applyMigrations(db);
    db.prepare(
      "INSERT INTO users VALUES (?, 'startup@example.test', 'unused-hash', 'employee', 'active', 1)",
    ).run(userId);
    const ids: string[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const input = {
        userId,
        config: {
          userImage: lifecycle.imageId,
          seccompProfilePath: lifecycle.seccomp,
          managedConfigDir: lifecycle.overlayDirectory,
          authority: 'startup.example:8443',
          subnetPool: '172.30.0.0/16',
        },
        modelSettings: START_MODEL,
        modelKey: 'docker-acceptance-only-not-a-model-credential',
      };
      const concurrentStarts = attempt === 0 ? 10 : 1;
      const results = await Promise.all(
        Array.from({ length: concurrentStarts }, () => startUserContainer(input)),
      );
      const result = results[0];
      if (result === undefined) throw new Error('Expected startup result');
      expect(results).toEqual(Array.from({ length: concurrentStarts }, () => result));
      expect(
        db.prepare('SELECT event_type, target, details FROM audit_events ORDER BY id').all(),
      ).toEqual(
        Array.from({ length: attempt + 1 }, () => [
          { event_type: 'instance.created', target: userId, details: '{}' },
          { event_type: 'instance.started', target: userId, details: '{}' },
        ]).flat(),
      );
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
        image_id: lifecycle.imageId,
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

// Diagnostics never serialize Docker JSON, process output or errors.
function resourceInspectDiagnostic(
  diagnostic: Record<string, number | boolean | null>,
  label: 'A' | 'B',
  container: Record<string, unknown>,
) {
  for (const [section, keys] of [
    ['HostConfig', ['NanoCpus', 'Memory', 'MemorySwap', 'PidsLimit']],
    ['State', ['Running', 'OOMKilled', 'ExitCode']],
  ] as const) {
    const sectionValue = container[section];
    if (typeof sectionValue !== 'object' || sectionValue === null || Array.isArray(sectionValue))
      continue;
    const values = record(sectionValue);
    for (const key of keys) {
      const value = values[key];
      if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))
        diagnostic[`${label}.${section}.${key}`] = value;
    }
  }
}

function reportResourceDiagnostic(
  stage: string,
  diagnostic: Record<string, number | boolean | null>,
  lifecycle: UserImageLifecycle,
  boundedId?: string,
) {
  if (boundedId !== undefined) {
    try {
      resourceInspectDiagnostic(diagnostic, 'B', inspect(lifecycle, boundedId));
      diagnostic['B.failureInspectAvailable'] = true;
    } catch {
      diagnostic['B.failureInspectAvailable'] = false;
    }
  }
  process.stdout.write(`Resource diagnostic: ${JSON.stringify({ stage, diagnostic })}\n`);
}

async function resourceScenario(lifecycle: UserImageLifecycle): Promise<string> {
  const userA = lifecycle.runId.replaceAll('-', '').slice(0, 12);
  const userB = `${userA.startsWith('a') ? 'b' : 'a'}${userA.slice(1)}`;
  const authority = 'resource.example:8443';
  const db = openDatabase(join(dirname(lifecycle.overlayDirectory), 'resource-platform.db'));
  const { raw, client, helperIds } = startupClient(lifecycle);
  const { startUserContainer } = createOrchestrator({
    client,
    database: db,
    config: { upstreamMode: 'published-loopback', platformContainerName: 'dsh-team-platform' },
  });
  const config: PlatformConfig = {
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    dataDir: dirname(lifecycle.overlayDirectory),
    managedConfigDir: lifecycle.overlayDirectory,
    dockerSocketPath: '/var/run/docker.sock',
    userImage: lifecycle.imageId,
    seccompProfilePath: lifecycle.seccomp,
    subnetPool: '172.30.0.0/16',
    upstreamMode: 'published-loopback',
    platformContainerName: 'dsh-team-platform',
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
  let stage = 'platform setup';
  let boundedId: string | undefined;
  const diagnostic: Record<string, number | boolean | null> = {};
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
    stage = 'A startup';
    const a = await startUserContainer({
      userId: userA,
      config,
      modelSettings: START_MODEL,
      modelKey: 'docker-acceptance-only-not-a-model-credential',
    });
    if (a.outcome !== 'starting') throw new Error('Expected configured sibling startup');
    stage = 'A independent inspection';
    const firstA = inspect(lifecycle, a.containerId);
    resourceInspectDiagnostic(diagnostic, 'A', firstA);
    expect(firstA.Id).toBe(a.containerId);
    expect(firstA.Image).toBe(lifecycle.imageId);
    expect(record(firstA.Config).Labels).toMatchObject({ 'dsh-team.user': userA });
    expect(firstA.HostConfig).toMatchObject(limitsA);
    stage = 'A readiness';
    await observeWebEndpoint(lifecycle.command, a.containerId, () => a.upstreamPort, authority);
    stage = 'platform health before B';
    await health();

    writeSettings(db, { cpuCores: 1.25, memoryMiB: 256 });
    stage = 'B startup';
    boundedId = `dsh-team-u-${userB}`;
    const b = await startUserContainer({
      userId: userB,
      config,
      modelSettings: START_MODEL,
      modelKey: 'docker-acceptance-only-not-a-model-credential',
    });
    if (b.outcome !== 'starting') throw new Error('Expected configured bounded startup');
    stage = 'B independent inspection';
    const bounded = inspect(lifecycle, b.containerId);
    resourceInspectDiagnostic(diagnostic, 'B', bounded);
    expect(bounded.Id).toBe(b.containerId);
    expect(bounded.Image).toBe(lifecycle.imageId);
    expect(record(bounded.Config).Labels).toMatchObject({ 'dsh-team.user': userB });
    expect(bounded.HostConfig).toMatchObject({
      ...limitsB,
      Privileged: false,
    });
    stage = 'sibling limits after B startup';
    expect(inspect(lifecycle, a.containerId).HostConfig).toMatchObject(limitsA);
    stage = 'B readiness';
    await observeWebEndpoint(lifecycle.command, b.containerId, () => b.upstreamPort, authority);
    stage = 'sibling readiness before pressure';
    await observeWebEndpoint(lifecycle.command, a.containerId, () => a.upstreamPort, authority);
    stage = 'platform health before pressure';
    await health();

    const oom = observeResourceOom(lifecycle, b.containerId, userB, diagnostic, (nextStage) => {
      stage = nextStage;
    });
    expect(oom).toMatchObject({
      requestedBytes: 536_870_912,
      limits: { 'memory.max': '268435456', 'memory.swap.max': '0', 'pids.max': '512' },
    });
    expect(oom.touchedBytes).toBeGreaterThan(0);
    expect(oom.touchedBytes).toBeLessThan(536_870_912);

    stage = 'sibling post-pressure inspection';
    const afterA = inspect(lifecycle, a.containerId);
    resourceInspectDiagnostic(diagnostic, 'A', afterA);
    expect(afterA.Id).toBe(firstA.Id);
    expect(afterA.HostConfig).toEqual(firstA.HostConfig);
    expect(record(afterA.State).Running).toBe(true);
    stage = 'sibling post-pressure readiness';
    await observeWebEndpoint(lifecycle.command, a.containerId, () => a.upstreamPort, authority);
    stage = 'platform post-pressure health';
    await health();
    stage = 'instance postchecks';
    expect(
      db.prepare('SELECT user_id, container_id FROM instances ORDER BY user_id').all(),
    ).toEqual(
      [
        { user_id: userA, container_id: a.containerId },
        { user_id: userB, container_id: b.containerId },
      ].sort((left, right) => left.user_id.localeCompare(right.user_id)),
    );
    stage = 'helper postchecks';
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
    reportResourceDiagnostic(stage, diagnostic, lifecycle, boundedId);
  } finally {
    try {
      if (app === undefined) db.close();
      else await app.close();
    } catch (error) {
      failures.push(error);
      reportResourceDiagnostic('platform cleanup', diagnostic, lifecycle);
    }
  }
  if (failures.length !== 0) throw new AggregateError(failures, 'Resource acceptance failed');
  reportResourceDiagnostic('complete', diagnostic, lifecycle);
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

function cookieImageCommand(lifecycle: UserImageLifecycle, args: readonly string[]): string {
  const result = lifecycle.command(args, 30_000);
  if (result.status !== 0 || result.error !== undefined)
    throw new Error('Owned image mutation failed');
  return result.stdout.trim();
}

async function cookieScenario(lifecycle: UserImageLifecycle): Promise<string> {
  const userId = lifecycle.runId.replaceAll('-', '').slice(0, 12);
  const ownership = { 'dsh-team.user': userId };
  lifecycle.registerResource('volume', lifecycle.stateVolume, ownership);
  lifecycle.registerResource('volume', lifecycle.workVolume, ownership);
  lifecycle.registerResource('container', `dsh-team-u-${userId}`, ownership);
  const mutableTag = `dsh-team-test-${lifecycle.runId}:cookie-mutable`;
  const replacementTag = `dsh-team-test-${lifecycle.runId}:cookie-replacement`;
  const imageOwnership = { 'dsh-team.test-run': lifecycle.runId };
  lifecycle.registerResource('image', mutableTag, imageOwnership);
  lifecycle.registerResource('image', replacementTag, imageOwnership);
  const database = openDatabase(join(dirname(lifecycle.overlayDirectory), 'cookie-platform.db'));
  const { client } = startupClient(lifecycle);
  const authority = 'cookie.example:8443';
  const config: PlatformConfig = {
    host: '127.0.0.1',
    port: 0,
    logLevel: 'info',
    dataDir: dirname(lifecycle.overlayDirectory),
    managedConfigDir: lifecycle.overlayDirectory,
    dockerSocketPath: '/var/run/docker.sock',
    userImage: mutableTag,
    seccompProfilePath: lifecycle.seccomp,
    subnetPool: '172.30.0.0/16',
    upstreamMode: 'published-loopback',
    platformContainerName: 'dsh-team-platform',
    publicUrl: `http://${authority}`,
    authority,
    cookieSecure: false,
    trustedProxies: [],
  };
  let platformLogs = '';
  let app: FastifyInstance | undefined;
  try {
    cookieImageCommand(lifecycle, ['image', 'tag', lifecycle.imageId, mutableTag]);
    const context = join(dirname(lifecycle.overlayDirectory), 'cookie-retag');
    await mkdir(context);
    const dockerfile = join(context, 'Dockerfile');
    await writeFile(dockerfile, `FROM ${mutableTag}\nLABEL dsh-team.cookie-retag=1\n`);
    cookieImageCommand(lifecycle, [
      'build',
      '--label',
      `dsh-team.test-run=${lifecycle.runId}`,
      '--tag',
      replacementTag,
      '--file',
      dockerfile,
      context,
    ]);
    const replacementId = cookieImageCommand(lifecycle, [
      'image',
      'inspect',
      '--format',
      '{{.Id}}',
      replacementTag,
    ]);
    expect(/^sha256:[a-f0-9]{64}$/.test(replacementId)).toBe(true);
    expect(replacementId !== lifecycle.imageId).toBe(true);
    applyMigrations(database);
    app = await buildApp(config, database, {
      write: (line) => {
        platformLogs += line;
      },
    });
    database
      .prepare(
        "INSERT INTO users VALUES (?, 'cookie@example.test', 'unused', 'employee', 'active', 1)",
      )
      .run(userId);
    const { startUserContainer, acquireDshCookie } = createOrchestrator({
      client,
      database,
      config,
    });
    const started = await startUserContainer({
      userId,
      config,
      modelSettings: START_MODEL,
      modelKey: 'docker-acceptance-only-not-a-model-credential',
    });
    if (started.outcome !== 'starting') throw new Error('Expected configured cookie startup');
    expect(
      database.prepare('SELECT image_tag, image_id FROM instances WHERE user_id = ?').get(userId),
    ).toEqual({
      image_tag: mutableTag,
      image_id: lifecycle.imageId,
    });
    cookieImageCommand(lifecycle, ['image', 'tag', replacementId, mutableTag]);
    const cookies: string[] = [];
    for (const mutation of ['retargeted', 'removed']) {
      if (mutation === 'removed') cookieImageCommand(lifecycle, ['image', 'rm', mutableTag]);
      let result: unknown;
      await acquireDshCookie({ userId, authority }).then((value: unknown) => {
        result = value;
      });
      app.log.info({ result }, 'Acquisition completed');
      expect(result === undefined).toBe(true);
      const row = record(
        database.prepare('SELECT status, dsh_cookie FROM instances WHERE user_id = ?').get(userId),
      );
      expect(row.status).toBe('starting');
      const cookie = row.dsh_cookie;
      if (typeof cookie !== 'string') throw new Error('Persisted authentication cookie missing');
      cookies.push(cookie);
      expect(await cookieHttpStatus(started.upstreamPort, authority, cookie)).toBe(200);
      expect(await cookieHttpStatus(started.upstreamPort, 'different.example:8443', cookie)).toBe(
        401,
      );
    }
    // A genuinely different expected image must still fail the exact container-image ownership guard.
    database
      .prepare('UPDATE instances SET image_id = ? WHERE user_id = ?')
      .run(replacementId, userId);
    let foreignRejected = false;
    try {
      await acquireDshCookie({ userId, authority });
    } catch (error) {
      foreignRejected = true;
      app.log.error({ err: error }, 'Foreign image rejected');
    }
    expect(foreignRejected).toBe(true);
    expect(
      record(database.prepare('SELECT dsh_cookie FROM instances WHERE user_id = ?').get(userId))
        .dsh_cookie === null,
    ).toBe(true);
    const observed = lifecycle.command(['logs', started.containerId], 15_000);
    if (observed.status !== 0 || observed.error !== undefined)
      throw new Error('Independent launch observation failed');
    const token = extractLaunchToken(observed.stdout);
    if (token === undefined) throw new Error('Independent genuine launch token missing');
    const audits = JSON.stringify(database.prepare('SELECT * FROM audit_events').all());
    for (const cookie of cookies) {
      for (const secret of [token, cookie, cookie.slice(cookie.indexOf('=') + 1)]) {
        expect((platformLogs + audits).includes(secret)).toBe(false);
      }
    }
    expect(database.prepare('SELECT event_type FROM audit_events ORDER BY id').all()).toEqual([
      { event_type: 'instance.created' },
      { event_type: 'instance.started' },
    ]);
    return JSON.stringify({
      starting: true,
      sameHostStatus: 200,
      differentHostStatus: 401,
      secretSafe: true,
      tagRetargeted: true,
      tagRemoved: true,
      foreignImageRejected: true,
    });
  } catch (error) {
    app?.log.error({ err: error }, 'Cookie acceptance failed');
    throw error;
  } finally {
    if (app !== undefined) await app.close();
    else database.close();
  }
}

it('acquires a real DSH cookie after exported startup and independently proves same-Host200 and different-Host401', async () => {
  if (platform() !== 'linux' || arch() !== 'x64')
    throw new Error('Docker verification requires the trusted giap-vps Linux amd64 environment');
  const result = await runUserImage(
    'container-start',
    (summary) => {
      expect(JSON.parse(summary)).toEqual({
        starting: true,
        sameHostStatus: 200,
        differentHostStatus: 401,
        secretSafe: true,
        tagRetargeted: true,
        tagRemoved: true,
        foreignImageRejected: true,
      });
    },
    undefined,
    cookieScenario,
  );
  process.stdout.write(
    `Docker cookie acquisition verified: run=${result.runId} image=${result.image} readback=${result.stdout} cleanup=complete\n`,
  );
});
