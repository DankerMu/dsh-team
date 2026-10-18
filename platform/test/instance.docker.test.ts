import { stat } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { applyMigrations, openDatabase, writeSettings } from '../src/db/index.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import type { PlatformConfig } from '../src/config.ts';
import {
  createInstanceService,
  createOrchestrator,
  extractLaunchToken,
} from '../src/orchestrator/index.ts';
import type { DockerClient } from '../src/orchestrator/index.ts';
import {
  assertFailedStartupLogs,
  corruptOwnedOverlay,
  inspectAsync,
  record,
  startupClient,
} from './container-start-docker-fixture.ts';
import { instanceConfig, registerInstanceUser } from './instance-fixture.ts';
import { runUserImage } from './user-image-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';
import { isAbsentResource } from './docker-command.ts';
import { orderedMounts } from './instance-gateway-docker-fixture.ts';

function dockerAppContext(lifecycle: UserImageLifecycle, databaseName: string) {
  const database = openDatabase(join(dirname(lifecycle.overlayDirectory), databaseName));
  applyMigrations(database);
  const config = instanceConfig(dirname(lifecycle.overlayDirectory), {
    userImage: lifecycle.imageId,
    seccompProfilePath: lifecycle.seccomp,
    managedConfigDir: lifecycle.overlayDirectory,
    logLevel: 'info',
  });
  return { database, config, transport: startupClient(lifecycle) };
}

async function listenInstanceApp(
  database: DatabaseHandle,
  config: PlatformConfig,
  client: DockerClient,
) {
  const service = createInstanceService({ database, config, client });
  const lines: string[] = [];
  const app = await buildApp(
    config,
    database,
    { write: (line) => lines.push(line) },
    undefined,
    service,
  );
  try {
    await service.reconcile();
    await app.listen({ host: '127.0.0.1', port: 0 });
  } catch (error) {
    await app.close();
    throw error;
  }
  const base = `http://127.0.0.1:${String(app.addresses()[0]?.port)}`;
  return { lines, app, base };
}

it('registers and logs in over HTTP, explicitly starts, reaches real DSH HTML and reuses one container', async () => {
  expect(platform()).toBe('linux');
  expect(arch()).toBe('x64');
  await runUserImage(
    'container-start',
    () => undefined,
    undefined,
    async (lifecycle) => {
      const { database, config, transport } = dockerAppContext(lifecycle, 'instance-platform.db');
      const { lines, app, base } = await listenInstanceApp(database, config, transport.client);
      try {
        const user = await registerInstanceUser(
          base,
          config.publicUrl,
          'gateway-employee@example.test',
        );
        const sibling = await registerInstanceUser(
          base,
          config.publicUrl,
          'gateway-sibling@example.test',
        );
        for (const name of [`dsh-team-home-${user.id}`, `dsh-team-work-${user.id}`])
          await lifecycle.registerResourceAsync('volume', name, { 'dsh-team.user': user.id });
        await lifecycle.registerResourceAsync('container', `dsh-team-u-${user.id}`, {
          'dsh-team.user': user.id,
        });
        // Canonical stored settings feed the production composition; no provider request is needed.
        const modelKey = 'docker-instance-fixture-only-not-a-provider-key';
        writeSettings(database, {
          modelBaseUrl: 'http://model.invalid/v1',
          modelApiKey: modelKey,
          models: [{ name: 'office-model' }],
          defaultModel: 'office-model',
        });
        const headers = {
          cookie: user.cookie,
          origin: config.publicUrl,
          'content-type': 'application/json',
        };
        const before = transport.requests.length;
        const passive = await fetch(`${base}/_platform/api/instance`, {
          headers: { cookie: user.cookie },
        });
        expect(await passive.json()).toEqual({ status: 'stopped', reason: 'stopped' });
        const unavailable = await fetch(`${base}/`, {
          headers: { cookie: user.cookie, accept: 'application/json' },
        });
        expect(unavailable.status).toBe(503);
        await unavailable.arrayBuffer();
        expect(transport.requests.length).toBe(before);
        const anonymous = await fetch(`${base}/_platform/api/instance/start`, {
          method: 'POST',
          headers: { origin: config.publicUrl, 'content-type': 'application/json' },
          body: '{}',
        });
        expect(anonymous.status).toBe(401);
        await anonymous.arrayBuffer();
        const starts = await Promise.all(
          Array.from({ length: 3 }, () =>
            fetch(`${base}/_platform/api/instance/start`, { method: 'POST', headers, body: '{}' }),
          ),
        );
        for (const response of starts) {
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ status: 'starting', reason: 'starting' });
        }
        const deadline = Date.now() + 90_000;
        for (;;) {
          const status = await fetch(`${base}/_platform/api/instance`, {
            headers: { cookie: user.cookie },
          });
          expect(status.status).toBe(200);
          const current = record(await status.json());
          expect(Object.keys(current).sort()).toEqual(['reason', 'status']);
          if (current.status === 'running') {
            expect(current.reason).toBeNull();
            break;
          }
          expect(current).toEqual({ status: 'starting', reason: 'starting' });
          if (Date.now() >= deadline)
            throw new Error('Instance did not reach authenticated readiness');
          await delay(100);
        }
        const row = record(
          database.prepare('SELECT * FROM instances WHERE user_id=?').get(user.id),
        );
        if (typeof row.container_id !== 'string' || typeof row.dsh_cookie !== 'string')
          throw new Error('Missing ready identity');
        const container = await inspectAsync(lifecycle, row.container_id);
        expect(container.Name).toBe(`/dsh-team-u-${user.id}`);
        expect(container.Image).toBe(lifecycle.imageId);
        expect(record(container.Config).Labels).toEqual({
          'dsh-team.user': user.id,
          'dsh-team.test-run': lifecycle.runId,
        });
        const gateway = await fetch(`${base}/`, {
          headers: { cookie: user.cookie, accept: 'text/html', 'x-user-id': sibling.id },
        });
        expect(gateway.status).toBe(200);
        expect(gateway.headers.get('content-type')).toContain('text/html');
        expect(gateway.headers.get('set-cookie')).toBeNull();
        const html = await gateway.text();
        expect(html).toMatch(/<!doctype html/i);
        expect(html).toMatch(/<script[^>]+src=/i);
        const siblingStatus = await fetch(`${base}/_platform/api/instance?userId=${user.id}`, {
          headers: { cookie: sibling.cookie, 'x-user-id': user.id },
        });
        expect(await siblingStatus.json()).toEqual({ status: 'stopped', reason: 'stopped' });
        const audits = database
          .prepare("SELECT * FROM audit_events WHERE event_type LIKE 'instance.%' ORDER BY id")
          .all();
        const again = await fetch(`${base}/_platform/api/instance/start`, {
          method: 'POST',
          headers,
          body: '{}',
        });
        expect(await again.json()).toEqual({ status: 'running', reason: null });
        expect(database.prepare('SELECT * FROM instances WHERE user_id=?').get(user.id)).toEqual(
          row,
        );
        expect(
          database
            .prepare("SELECT * FROM audit_events WHERE event_type LIKE 'instance.%' ORDER BY id")
            .all(),
        ).toEqual(audits);
        expect(
          transport.requests.filter(
            ({ method, path }) =>
              method === 'POST' && path === `/containers/create?name=dsh-team-u-${user.id}`,
          ),
        ).toHaveLength(1);
        const exposed = html + lines.join('') + JSON.stringify(audits);
        expect(exposed).not.toContain(row.dsh_cookie);
        expect(exposed).not.toContain(modelKey);
        return row.container_id;
      } finally {
        await app.close();
      }
    },
  );
});

const MODEL_KEY = 'docker-unavailable-fixture-only-not-a-provider-key';
const UNAVAILABLE_SETTINGS = {
  maxRunningInstances: 1,
  modelBaseUrl: 'http://model.invalid/v1',
  modelApiKey: MODEL_KEY,
  models: [{ name: 'office-model' }],
  defaultModel: 'office-model',
};

async function withUnavailableApp(lifecycle: UserImageLifecycle, failOnce: boolean) {
  const { database, config, transport } = dockerAppContext(lifecycle, 'unavailable-platform.db');
  let failedId: string | undefined;
  let faultEnabled = failOnce;
  let injected = false;
  let userId = '';
  const client: typeof transport.client = {
    logs: (path, signal) => transport.client.logs(path, signal),
    async json(method, path, body, signal, maxBytes) {
      if (
        faultEnabled &&
        !injected &&
        method === 'POST' &&
        failedId !== undefined &&
        path === `/containers/${failedId}/start`
      ) {
        await corruptOwnedOverlay(lifecycle, userId, failedId);
        injected = true;
      }
      const result = await transport.client.json(method, path, body, signal, maxBytes);
      if (method === 'POST' && path === `/containers/create?name=dsh-team-u-${userId}`) {
        const id = record(result).Id;
        if (typeof id !== 'string') throw new Error('Missing owned create identity');
        failedId ??= id;
      }
      return result;
    },
  };
  // Capacity release uses this captured canonical owner, with no concurrent lifecycle work.
  // It is never used for failure/retry: production alone must retire the retained error container.
  const stopOwner = createOrchestrator({ database, config, client });
  const { lines, app, base } = await listenInstanceApp(database, config, client);
  const register = async (email: string) => {
    const user = await registerInstanceUser(base, config.publicUrl, email);
    if (userId === '') userId = user.id;
    const ownership = { 'dsh-team.user': user.id };
    await lifecycle.registerResourceAsync('container', `dsh-team-u-${user.id}`, ownership);
    for (const name of [`dsh-team-home-${user.id}`, `dsh-team-work-${user.id}`])
      await lifecycle.registerResourceAsync('volume', name, ownership);
    return user;
  };
  const state = async (cookie: string, post = false) => {
    const response = await fetch(`${base}/_platform/api/instance${post ? '/start' : ''}`, {
      method: post ? 'POST' : 'GET',
      headers: { cookie, origin: config.publicUrl, 'content-type': 'application/json' },
      ...(post ? { body: '{}' } : {}),
    });
    const body: unknown = await response.json();
    expect(response.status, `Public instance response: ${JSON.stringify(body)}`).toBe(200);
    return body;
  };
  const wait = async (cookie: string, status: 'running' | 'error') => {
    const deadline = Date.now() + 90_000;
    for (;;) {
      const current = await state(cookie);
      if (record(current).status === status) {
        expect(current).toEqual({ status, reason: status === 'running' ? null : status });
        return;
      }
      expect(current).toEqual({ status: 'starting', reason: 'starting' });
      if (Date.now() >= deadline) throw new Error('Public instance did not reach terminal state');
      await delay(100);
    }
  };
  return {
    app,
    base,
    database,
    transport,
    stopOwner,
    lines,
    register,
    state,
    wait,
    fault: () => ({ failedId, injected }),
    disableFault: () => {
      faultEnabled = false;
    },
  };
}

async function unavailableGateway(base: string, cookie: string, reason: string): Promise<void> {
  const navigation = await fetch(`${base}/`, {
    headers: { cookie, accept: 'text/html' },
    redirect: 'manual',
  });
  expect(navigation.status).toBe(302);
  expect(navigation.headers.get('location')).toBe('/_platform/wait');
  await navigation.arrayBuffer();
  const api = await fetch(`${base}/`, { headers: { cookie, accept: 'application/json' } });
  expect(api.status).toBe(503);
  expect(await api.json()).toEqual({
    statusCode: 503,
    error: 'Service Unavailable',
    message: 'Instance unavailable',
    reason,
  });
}

async function readyGateway(base: string, cookie: string): Promise<string> {
  const response = await fetch(`${base}/`, { headers: { cookie, accept: 'text/html' } });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/html');
  expect(response.headers.get('set-cookie')).toBeNull();
  const html = await response.text();
  expect(html).toMatch(/<!doctype html/i);
  expect(html).toMatch(/<script[^>]+src=/i);
  return html;
}

it('public unconfigured allocates nothing, full preserves ready A and same-session B retries after release', async () => {
  expect(platform()).toBe('linux');
  expect(arch()).toBe('x64');
  await runUserImage(
    'container-start',
    () => undefined,
    undefined,
    async (lifecycle) => {
      const f = await withUnavailableApp(lifecycle, false);
      try {
        const a = await f.register('unavailable-a@example.test');
        const b = await f.register('unavailable-b@example.test');
        const noAllocation = async (id: string) => {
          expect(
            f.database.prepare('SELECT * FROM instances WHERE user_id=?').get(id),
          ).toBeUndefined();
          await expect(
            stat(join(lifecycle.overlayDirectory, `${id}.patch.yml`)),
          ).rejects.toMatchObject({ code: 'ENOENT' });
          for (const [kind, name] of [
            ['container', `dsh-team-u-${id}`],
            ['network', `dsh-team-net-${id}`],
            ['volume', `dsh-team-home-${id}`],
            ['volume', `dsh-team-work-${id}`],
          ] as const) {
            expect(
              isAbsentResource(
                await lifecycle.commandAsync([kind, 'inspect', name], 15_000),
                kind,
                name,
              ),
            ).toBe(true);
          }
        };
        const initialRequests = [...f.transport.requests];
        const initialAudits = f.database.prepare('SELECT * FROM audit_events ORDER BY id').all();
        expect(await f.state(a.cookie, true)).toEqual({
          status: 'unconfigured',
          reason: 'unconfigured',
        });
        expect(await f.state(a.cookie)).toEqual({ status: 'unconfigured', reason: 'unconfigured' });
        await unavailableGateway(f.base, a.cookie, 'unconfigured');
        expect(f.transport.requests).toEqual(initialRequests);
        expect(f.database.prepare('SELECT * FROM audit_events ORDER BY id').all()).toEqual(
          initialAudits,
        );
        await noAllocation(a.id);

        writeSettings(f.database, UNAVAILABLE_SETTINGS);
        expect(await f.state(a.cookie, true)).toEqual({ status: 'starting', reason: 'starting' });
        await f.wait(a.cookie, 'running');
        const rowA = record(
          f.database.prepare('SELECT * FROM instances WHERE user_id=?').get(a.id),
        );
        if (typeof rowA.container_id !== 'string') throw new Error('Missing ready A identity');
        const beforeA = await inspectAsync(lifecycle, rowA.container_id);
        const requests = [...f.transport.requests];
        const audits = f.database.prepare('SELECT * FROM audit_events ORDER BY id').all();
        expect(await f.state(b.cookie, true)).toEqual({ status: 'full', reason: 'full' });
        for (let observation = 0; observation < 2; observation += 1)
          expect(await f.state(b.cookie)).toEqual({ status: 'full', reason: 'full' });
        await unavailableGateway(f.base, b.cookie, 'full');
        expect(f.transport.requests).toEqual(requests);
        expect(f.database.prepare('SELECT * FROM audit_events ORDER BY id').all()).toEqual(audits);
        await noAllocation(b.id);
        expect(f.database.prepare('SELECT * FROM instances WHERE user_id=?').get(a.id)).toEqual(
          rowA,
        );
        const afterA = await inspectAsync(lifecycle, rowA.container_id);
        expect(afterA.Id).toBe(beforeA.Id);
        expect(afterA.Config).toEqual(beforeA.Config);
        expect(afterA.HostConfig).toEqual(beforeA.HostConfig);
        expect(record(afterA.State).Running).toBe(true);
        expect(await f.state(a.cookie)).toEqual({ status: 'running', reason: null });
        await readyGateway(f.base, a.cookie);

        await f.stopOwner.stopUserContainer({ userId: a.id, reason: 'admin' });
        expect(await f.state(a.cookie)).toEqual({ status: 'stopped', reason: 'stopped' });
        expect(
          isAbsentResource(
            await lifecycle.commandAsync(['container', 'inspect', rowA.container_id], 15_000),
            'container',
            rowA.container_id,
          ),
        ).toBe(true);
        expect(await f.state(b.cookie, true)).toEqual({ status: 'starting', reason: 'starting' });
        await f.wait(b.cookie, 'running');
        await readyGateway(f.base, b.cookie);
        return 'public-capacity-unconfigured';
      } finally {
        await f.app.close();
      }
    },
  );
});

it('keeps an absent running identity unavailable after full refusal and readies a new identity after release', async () => {
  expect(platform()).toBe('linux');
  expect(arch()).toBe('x64');
  await runUserImage(
    'container-start',
    () => undefined,
    undefined,
    async (lifecycle) => {
      const f = await withUnavailableApp(lifecycle, false);
      try {
        const a = await f.register('absent-capacity-a@example.test');
        const b = await f.register('absent-capacity-b@example.test');
        writeSettings(f.database, { ...UNAVAILABLE_SETTINGS, maxRunningInstances: 2 });
        for (const user of [a, b]) {
          expect(await f.state(user.cookie, true)).toEqual({
            status: 'starting',
            reason: 'starting',
          });
          await f.wait(user.cookie, 'running');
        }
        // Readiness already proves authenticated upstream200. Probe gateway usability only after
        // the row comparison below: intentional gateway activity otherwise races its 1s flush.
        const row = (id: string) =>
          record(f.database.prepare('SELECT * FROM instances WHERE user_id=?').get(id));
        const oldA = row(a.id);
        const oldB = row(b.id);
        if (typeof oldA.container_id !== 'string' || typeof oldB.container_id !== 'string')
          throw new Error('Missing owned running identities');
        const beforeB = await inspectAsync(lifecycle, oldB.container_id);
        writeSettings(f.database, { maxRunningInstances: 1 });
        // External deletion is confined to this registered employee's immutable, freshly verified ID.
        const ownedA = await inspectAsync(lifecycle, oldA.container_id);
        expect(ownedA.Id).toBe(oldA.container_id);
        expect(ownedA.Name).toBe(`/dsh-team-u-${a.id}`);
        expect(ownedA.Image).toBe(lifecycle.imageId);
        expect(record(record(ownedA.Config).Labels)['dsh-team.user']).toBe(a.id);
        const removed = await lifecycle.commandAsync(
          ['container', 'rm', '--force', oldA.container_id],
          15_000,
        );
        expect(removed.status).toBe(0);
        expect(removed.error).toBeUndefined();

        expect(await f.state(a.cookie, true)).toEqual({ status: 'full', reason: 'full' });
        expect(await f.state(a.cookie)).toEqual({ status: 'full', reason: 'full' });
        await unavailableGateway(f.base, a.cookie, 'full');
        // Compare secret-bearing rows without allowing an assertion diff to print credentials.
        expect(isDeepStrictEqual(row(a.id), oldA)).toBe(true);
        expect(isDeepStrictEqual(row(b.id), oldB)).toBe(true);
        const afterB = await inspectAsync(lifecycle, oldB.container_id);
        expect(afterB.Id).toBe(beforeB.Id);
        expect(afterB.State).toEqual(beforeB.State);
        expect(afterB.NetworkSettings).toEqual(beforeB.NetworkSettings);
        await readyGateway(f.base, b.cookie);

        await f.stopOwner.stopUserContainer({ userId: b.id, reason: 'admin' });
        expect(await f.state(a.cookie)).toEqual({ status: 'stopped', reason: 'stopped' });
        await unavailableGateway(f.base, a.cookie, 'stopped');
        expect(await f.state(a.cookie, true)).toEqual({ status: 'starting', reason: 'starting' });
        await f.wait(a.cookie, 'running');
        const replacement = row(a.id);
        expect(replacement.container_id).not.toBe(oldA.container_id);
        expect(replacement.dsh_cookie === oldA.dsh_cookie).toBe(false);
        if (typeof replacement.container_id !== 'string')
          throw new Error('Missing replacement identity');
        const ready = await inspectAsync(lifecycle, replacement.container_id);
        expect(ready.Id).toBe(replacement.container_id);
        expect(record(ready.State).Running).toBe(true);
        expect(orderedMounts(ready.Mounts)).toEqual(orderedMounts(ownedA.Mounts));
        // A host port may be reallocated; routing must use the replacement's inspected binding.
        expect(record(record(ready.NetworkSettings).Ports)['3080/tcp']).toEqual([
          { HostIp: replacement.upstream_host, HostPort: String(replacement.upstream_port) },
        ]);
        expect(
          isAbsentResource(
            await lifecycle.commandAsync(['container', 'inspect', oldA.container_id], 15_000),
            'container',
            oldA.container_id,
          ),
        ).toBe(true);
        await readyGateway(f.base, a.cookie);
        return 'public-verified-absence-capacity-recovery';
      } finally {
        await f.app.close();
      }
    },
  );
});

it('public real startup error retains stopped container and volumes, then same-session retry replaces it', async () => {
  expect(platform()).toBe('linux');
  expect(arch()).toBe('x64');
  await runUserImage(
    'container-start',
    () => undefined,
    undefined,
    async (lifecycle) => {
      const f = await withUnavailableApp(lifecycle, true);
      try {
        const user = await f.register('unavailable-error@example.test');
        writeSettings(f.database, UNAVAILABLE_SETTINGS);
        const admission = await f.state(user.cookie, true);
        // Start acknowledges admission before asynchronous readiness; a very fast exit can already be error.
        expect([
          { status: 'starting', reason: 'starting' },
          { status: 'error', reason: 'error' },
        ]).toContainEqual(admission);
        await f.wait(user.cookie, 'error');
        const row = record(
          f.database.prepare('SELECT * FROM instances WHERE user_id=?').get(user.id),
        );
        const fault = f.fault();
        expect(fault.injected).toBe(true);
        expect(row.container_id).toBe(fault.failedId);
        if (typeof row.container_id !== 'string')
          throw new Error('Missing failed physical identity');
        const failed = await inspectAsync(lifecycle, row.container_id);
        expect(failed.Id).toBe(row.container_id);
        expect(failed.Name).toBe(`/dsh-team-u-${user.id}`);
        expect(failed.Image).toBe(lifecycle.imageId);
        expect(record(failed.Config).Labels).toMatchObject({ 'dsh-team.user': user.id });
        expect(record(failed.State).Running).toBe(false);
        expect(row.dsh_cookie).toBeNull();
        const actual = await lifecycle.commandAsync(
          ['logs', '--tail', '1000', row.container_id],
          15_000,
        );
        expect(actual.status).toBe(0);
        expect(actual.error).toBeUndefined();
        assertFailedStartupLogs(row, actual.stdout + actual.stderr);
        if (typeof row.last_error !== 'string') throw new Error('Missing startup diagnostic');
        expect(
          Array.from(row.last_error).some((character) => {
            const code = character.charCodeAt(0);
            return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
          }),
        ).toBe(false);
        const audits = f.database
          .prepare(
            "SELECT event_type, target, details FROM audit_events WHERE event_type LIKE 'instance.%' ORDER BY id",
          )
          .all();
        // Both sequences are allowed by the existing early-exit/readiness lifecycle oracle.
        expect([
          [
            { event_type: 'instance.created', target: user.id, details: '{}' },
            { event_type: 'instance.start-failed', target: user.id, details: '{}' },
          ],
          [
            { event_type: 'instance.created', target: user.id, details: '{}' },
            { event_type: 'instance.started', target: user.id, details: '{}' },
            { event_type: 'instance.start-failed', target: user.id, details: '{}' },
          ],
        ]).toContainEqual(audits);
        expect(
          isAbsentResource(
            await lifecycle.commandAsync(['network', 'inspect', `dsh-team-net-${user.id}`], 15_000),
            'network',
            `dsh-team-net-${user.id}`,
          ),
        ).toBe(true);
        const volumeNames = [`dsh-team-home-${user.id}`, `dsh-team-work-${user.id}`];
        expect(failed.Mounts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              Type: 'volume',
              Name: volumeNames[0],
              Destination: '/data/home',
            }),
            expect.objectContaining({
              Type: 'volume',
              Name: volumeNames[1],
              Destination: '/data/work',
            }),
          ]),
        );
        const volumes: unknown[] = [];
        for (const name of volumeNames) {
          const volume = await f.transport.raw.json('GET', `/volumes/${name}`);
          expect(record(volume).Name).toBe(name);
          expect(record(volume).Labels).toMatchObject({ 'dsh-team.user': user.id });
          volumes.push(volume);
        }
        const requests = [...f.transport.requests];
        expect(await f.state(user.cookie)).toEqual({ status: 'error', reason: 'error' });
        await unavailableGateway(f.base, user.cookie, 'error');
        expect(await f.state(user.cookie)).toEqual({ status: 'error', reason: 'error' });
        expect(f.transport.requests).toEqual(requests);
        expect(f.database.prepare('SELECT * FROM instances WHERE user_id=?').get(user.id)).toEqual(
          row,
        );
        const diagnostic =
          JSON.stringify(row.last_error) + JSON.stringify(audits) + f.lines.join('');
        expect(diagnostic).not.toContain(MODEL_KEY);
        const token = extractLaunchToken(actual.stdout);
        if (token !== undefined) expect(diagnostic).not.toContain(token);

        // No fixture retirement, deletion, row repair or new service/session: disable only the fault.
        f.disableFault();
        expect(await f.state(user.cookie, true)).toEqual({
          status: 'starting',
          reason: 'starting',
        });
        await f.wait(user.cookie, 'running');
        const ready = record(
          f.database.prepare('SELECT * FROM instances WHERE user_id=?').get(user.id),
        );
        expect(ready.container_id).not.toBe(row.container_id);
        expect(ready.last_error).toBeNull();
        if (typeof ready.container_id !== 'string' || typeof ready.dsh_cookie !== 'string')
          throw new Error('Missing retried ready identity');
        const replacement = await inspectAsync(lifecycle, ready.container_id);
        expect(replacement.Id).toBe(ready.container_id);
        expect(replacement.Image).toBe(lifecycle.imageId);
        expect(record(replacement.State).Running).toBe(true);
        expect(replacement.Mounts).toEqual(
          expect.arrayContaining(
            volumeNames.map((name, index) => {
              const mount: unknown = expect.objectContaining({
                Type: 'volume',
                Name: name,
                Destination: index === 0 ? '/data/home' : '/data/work',
              });
              return mount;
            }),
          ),
        );
        for (let index = 0; index < volumeNames.length; index += 1)
          expect(await f.transport.raw.json('GET', `/volumes/${volumeNames[index] ?? ''}`)).toEqual(
            volumes[index],
          );
        expect(
          f.transport.requests.filter(
            ({ method, path }) =>
              method === 'DELETE' &&
              volumeNames.some((name) => path.startsWith(`/volumes/${name}`)),
          ),
        ).toEqual([]);
        expect(
          isAbsentResource(
            await lifecycle.commandAsync(['container', 'inspect', row.container_id], 15_000),
            'container',
            row.container_id,
          ),
        ).toBe(true);
        const html = await readyGateway(f.base, user.cookie);
        const currentAudits = f.database
          .prepare("SELECT * FROM audit_events WHERE event_type LIKE 'instance.%' ORDER BY id")
          .all();
        for (const secret of [
          MODEL_KEY,
          ready.dsh_cookie,
          ready.dsh_cookie.split('=').slice(1).join('='),
        ])
          expect(html + f.lines.join('') + JSON.stringify(currentAudits)).not.toContain(secret);
        return 'public-error-retained-retry';
      } finally {
        await f.app.close();
      }
    },
  );
});
