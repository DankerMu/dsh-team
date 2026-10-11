import { request } from 'node:http';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { deleteUserSessions } from '../src/auth/index.ts';
import { writeSettings } from '../src/db/index.ts';
import { createDockerClient, createInstanceService } from '../src/orchestrator/index.ts';
import {
  START_CONTAINER,
  startupBarrier,
  startupUnixOwnerFixture,
} from './container-start-fixture.ts';
import { instanceConfig, registerInstanceUser } from './instance-fixture.ts';
import { seedReconciliation } from './container-reconcile-fixture.ts';
import { observeHttp, withUpstream } from './gateway-http-fixture.ts';

async function fixture() {
  const f = await startupUnixOwnerFixture({
    rootPrefix: 'dsh-instance-',
    users: {},
    userImage: 'dsh-team-user:local',
    subnetPool: '172.30.0.0/16',
    transport: { upstreamMode: 'published-loopback', platformContainerName: 'dsh-team-platform' },
  });
  const config = instanceConfig(f.root, {
    ...f.input.config,
    dockerSocketPath: join(f.root, 'engine.sock'),
    logLevel: 'info',
  });
  const service = createInstanceService({
    database: f.database,
    config,
    client: createDockerClient(config.dockerSocketPath),
  });
  const lines: string[] = [];
  const app = await buildApp(
    config,
    f.database,
    { write: (line) => lines.push(line) },
    undefined,
    service,
  );
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${String(app.addresses()[0]?.port)}`;
  return {
    ...f,
    app,
    service,
    config,
    base,
    lines,
    async close() {
      await app.close();
      await f.close();
    },
  };
}

it('keeps one request-independent startup and readiness flight and drains it before closing the real database', async () => {
  const f = await fixture();
  const creating = startupBarrier();
  const readiness = startupBarrier();
  let outgoing: ClientRequest | undefined;
  try {
    const user = await registerInstanceUser(f.base, f.config.publicUrl, 'employee@example.test');
    const sibling = await registerInstanceUser(f.base, f.config.publicUrl, 'sibling@example.test');
    writeSettings(f.database, {
      modelBaseUrl: 'http://model.invalid/v1',
      modelApiKey: 'held-private-model-key',
      models: [{ name: 'office-model' }],
      defaultModel: 'office-model',
      maxRunningInstances: 1,
    });
    let acquisitions = 0;
    f.hold((method, path) => {
      if (method === 'POST' && path === `/containers/create?name=dsh-team-u-${user.id}`)
        return creating.hold();
      if (method === 'GET' && path.includes('/logs?stdout=true&stderr=true&follow=true')) {
        acquisitions += 1;
        return readiness.hold();
      }
      return undefined;
    });
    outgoing = request(`${f.base}/_platform/api/instance/start`, {
      method: 'POST',
      headers: {
        cookie: user.cookie,
        origin: f.config.publicUrl,
        'content-type': 'application/json',
      },
    });
    outgoing.on('error', () => undefined);
    outgoing.end('{}');
    await creating.reached;
    outgoing.destroy();
    const status = await fetch(`${f.base}/_platform/api/instance`, {
      headers: { cookie: user.cookie },
    });
    expect(await status.json()).toEqual({ status: 'starting', reason: 'starting' });
    const full = await fetch(`${f.base}/_platform/api/instance`, {
      headers: { cookie: sibling.cookie },
    });
    expect(await full.json()).toEqual({ status: 'full', reason: 'full' });
    const denied = await fetch(`${f.base}/_platform/api/instance/start`, {
      method: 'POST',
      headers: {
        cookie: sibling.cookie,
        origin: f.config.publicUrl,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(await denied.json()).toEqual({ status: 'full', reason: 'full' });
    expect(f.daemon.requests.some(({ path }) => path.includes(sibling.id))).toBe(false);
    creating.release();
    await readiness.reached;
    const repeated = await Promise.all(
      Array.from({ length: 4 }, () =>
        fetch(`${f.base}/_platform/api/instance/start`, {
          method: 'POST',
          headers: {
            cookie: user.cookie,
            origin: f.config.publicUrl,
            'content-type': 'application/json',
          },
          body: '{}',
        }),
      ),
    );
    for (const response of repeated)
      expect(await response.json()).toEqual({ status: 'starting', reason: 'starting' });
    expect(acquisitions).toBe(1);
    expect(
      f.daemon.requests.filter(
        ({ path }) => path === `/containers/create?name=dsh-team-u-${user.id}`,
      ),
    ).toHaveLength(1);
    expect(f.database.prepare('SELECT container_id FROM instances').get()).toEqual({
      container_id: START_CONTAINER,
    });
    let closed = false;
    const closing = f.app.close().then(() => {
      closed = true;
    });
    // Yield to Fastify's shutdown hooks, not to a timing-based sleep or direct service close.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(f.service.start(user.id)).rejects.toThrow('Instance service unavailable');
    expect(closed).toBe(false);
    expect(f.database.open).toBe(true);
    readiness.release();
    await closing;
    expect(f.database.open).toBe(false);
    expect(f.daemon.containers.get(START_CONTAINER)?.State.Running).toBe(false);
    expect(f.lines.join('')).not.toContain('held-private-model-key');
  } finally {
    outgoing?.destroy();
    creating.release();
    readiness.release();
    await f.close();
  }
});

it.each(['revoked', 'disabled'] as const)(
  'rechecks a %s identity after a held request body before startup',
  async (change) => {
    const f = await fixture();
    try {
      const user = await registerInstanceUser(f.base, f.config.publicUrl, 'delayed@example.test');
      const entered = Promise.withResolvers<undefined>();
      f.app.server.on('request', (incoming) => {
        if (incoming.url === '/_platform/api/instance/start')
          incoming.once('data', () => {
            entered.resolve(undefined);
          });
      });
      const outgoing = request(`${f.base}/_platform/api/instance/start`, {
        method: 'POST',
        headers: {
          cookie: user.cookie,
          origin: f.config.publicUrl,
          'content-type': 'application/json',
          'content-length': '2',
        },
      });
      const response = new Promise<IncomingMessage>((resolve, reject) => {
        outgoing.once('response', resolve);
        outgoing.once('error', reject);
      });
      outgoing.write('{');
      await entered.promise;
      if (change === 'revoked') deleteUserSessions(f.database, user.id);
      else f.database.prepare("UPDATE users SET status='disabled' WHERE id=?").run(user.id);
      outgoing.end('}');
      const message = await response;
      const chunks: Buffer[] = [];
      for await (const chunk of message) {
        // Node HTTP's async iterator yields byte buffers; narrow the untyped event boundary.
        if (!Buffer.isBuffer(chunk)) throw new Error('Non-byte HTTP response');
        chunks.push(chunk);
      }
      expect(message.statusCode).toBe(401);
      expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Unauthorized',
      });
      expect(f.daemon.requests).toEqual([]);
      expect(f.database.prepare('SELECT * FROM instances').all()).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

it('reports unexpected startup failure safely and exposes persisted errors without diagnostics', async () => {
  const f = await fixture();
  try {
    const user = await registerInstanceUser(f.base, f.config.publicUrl, 'failure@example.test');
    writeSettings(f.database, {
      modelBaseUrl: 'http://model.invalid/v1',
      modelApiKey: 'error-private-key',
      models: [{ name: 'office-model' }],
      defaultModel: 'office-model',
    });
    f.replyWith((accepted, reply) =>
      accepted.path.startsWith('/images/')
        ? { status: 500, document: { message: 'private-daemon-diagnostic' } }
        : reply,
    );
    const response = await fetch(`${f.base}/_platform/api/instance/start`, {
      method: 'POST',
      headers: {
        cookie: user.cookie,
        origin: f.config.publicUrl,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Internal Server Error',
    });
    const failedObservation = await fetch(`${f.base}/_platform/api/instance`, {
      headers: { cookie: user.cookie },
    });
    expect(failedObservation.status).toBe(500);
    expect(await failedObservation.json()).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Internal Server Error',
    });
    f.database
      .prepare(
        "INSERT INTO instances(user_id,status,last_error) VALUES (?, 'error', 'private-row-diagnostic')",
      )
      .run(user.id);
    const current = await fetch(`${f.base}/_platform/api/instance`, {
      headers: { cookie: user.cookie },
    });
    expect(await current.json()).toEqual({ status: 'error', reason: 'error' });
    expect(f.lines.join('')).not.toMatch(
      /private-daemon-diagnostic|private-row-diagnostic|error-private-key/,
    );
  } finally {
    await f.close();
  }
});

it.each([false, true])(
  'projects completed readiness failure truthfully with error persistence blocked=%s',
  async (blocked) => {
    const f = await fixture();
    try {
      const user = await registerInstanceUser(f.base, f.config.publicUrl, 'readiness@example.test');
      writeSettings(f.database, {
        modelBaseUrl: 'http://model.invalid/v1',
        modelApiKey: 'readiness-private-key',
        models: [{ name: 'office-model' }],
        defaultModel: 'office-model',
      });
      if (blocked)
        f.database.exec(
          "CREATE TRIGGER reject_error BEFORE UPDATE ON instances WHEN NEW.status='error' BEGIN SELECT RAISE(ABORT,'private-write-diagnostic'); END",
        );
      const started = await fetch(`${f.base}/_platform/api/instance/start`, {
        method: 'POST',
        headers: {
          cookie: user.cookie,
          origin: f.config.publicUrl,
          'content-type': 'application/json',
        },
        body: '{}',
      });
      expect(await started.json()).toEqual({ status: 'starting', reason: 'starting' });
      const deadline = Date.now() + 5000;
      for (;;) {
        const status = await fetch(`${f.base}/_platform/api/instance`, {
          headers: { cookie: user.cookie },
        });
        const current: unknown = await status.json();
        if (status.status === 500) {
          expect(blocked).toBe(true);
          expect(current).toEqual({
            statusCode: 500,
            error: 'Internal Server Error',
            message: 'Internal Server Error',
          });
          break;
        }
        expect(status.status).toBe(200);
        if (
          typeof current === 'object' &&
          current !== null &&
          'status' in current &&
          current.status === 'error'
        ) {
          expect(blocked).toBe(false);
          expect(current).toEqual({ status: 'error', reason: 'error' });
          break;
        }
        expect(current).toEqual({ status: 'starting', reason: 'starting' });
        if (Date.now() >= deadline)
          throw new Error('Readiness failure was not reflected by the public API');
      }
      const gateway = await fetch(`${f.base}/`, {
        headers: { cookie: user.cookie, accept: 'application/json' },
      });
      expect(gateway.status).toBe(blocked ? 502 : 503);
      await gateway.arrayBuffer();
      expect(f.database.prepare('SELECT status FROM instances').get()).toEqual({
        status: blocked ? 'starting' : 'error',
      });
      expect(f.lines.join('')).not.toMatch(/readiness-private-key|private-write-diagnostic/);
    } finally {
      await f.close();
    }
  },
);

it.each(['missing', 'replaced'] as const)(
  'fences the verified absent running identity during failed image work and preserves %s controls',
  async (transition) => {
    const f = await fixture();
    const image = startupBarrier();
    let oldHits = 0;
    try {
      await withUpstream(
        (_request, response) => {
          oldHits += 1;
          response.end('old');
        },
        async (old) => {
          await withUpstream(
            (_request, response) => response.end('current'),
            async (current) => {
              const user = await registerInstanceUser(
                f.base,
                f.config.publicUrl,
                'absence@example.test',
              );
              const sibling = await registerInstanceUser(
                f.base,
                f.config.publicUrl,
                'unaffected@example.test',
              );
              writeSettings(f.database, {
                modelBaseUrl: 'http://model.invalid/v1',
                modelApiKey: 'fixture-model-key',
                models: [{ name: 'office-model' }],
                defaultModel: 'office-model',
              });
              function seed(userId: string, id: string, port: number, startedAt: number) {
                seedReconciliation(f.database, f.daemon, userId, id);
                f.database
                  .prepare(
                    'UPDATE instances SET upstream_port=?, last_started_at=? WHERE user_id=?',
                  )
                  .run(port, startedAt, userId);
                const container = f.daemon.containers.get(id);
                if (container === undefined) throw new Error('Missing seeded container');
                container.NetworkSettings.Ports = {
                  '3080/tcp': [{ HostIp: '127.0.0.1', HostPort: String(port) }],
                };
              }
              seed(user.id, START_CONTAINER, old.port, 101);
              seed(sibling.id, 'd'.repeat(64), current.port, 202);
              const running = { status: 'running', reason: null };
              const gateway = (cookie: string) =>
                fetch(`${f.base}/probe`, {
                  headers: { cookie, accept: 'application/json' },
                });
              expect(await f.service.start(user.id)).toEqual(running);
              expect(await (await gateway(user.cookie)).text()).toBe('old');
              // A generic inspect failure is not verified absence of a healthy running identity.
              f.replyWith((request, reply) =>
                request.path === `/containers/${START_CONTAINER}/json`
                  ? { status: 500, document: {} }
                  : reply,
              );
              await expect(f.service.start(user.id)).rejects.toThrow('Instance operation failed');
              expect(f.service.status(user.id)).toEqual(running);
              expect(await (await gateway(user.cookie)).text()).toBe('old');
              f.daemon.removeContainer(START_CONTAINER);
              const imagePath = `/images/${encodeURIComponent(f.config.userImage)}/json`;
              f.replyWith((request, reply) =>
                request.path === imagePath ? { status: 500, document: {} } : reply,
              );
              f.hold((method, path) =>
                method === 'GET' && path === imagePath ? image.hold() : undefined,
              );
              const failed = f.service.start(user.id).then(
                () => false,
                (error: unknown) =>
                  error instanceof Error && error.message === 'Instance operation failed',
              );
              await observeHttp(image.reached);
              const hitsAtAbsence = oldHits;
              expect(f.service.status(user.id)).toEqual({ status: 'starting', reason: 'starting' });
              expect(f.service.resolveUpstream(user.id).outcome).toBe('starting');
              expect((await gateway(user.cookie)).status).toBe(503);
              expect(oldHits).toBe(hitsAtAbsence);
              expect(f.service.status(sibling.id)).toEqual(running);
              expect(await (await gateway(sibling.cookie)).text()).toBe('current');

              if (transition === 'replaced') {
                const network = [...f.daemon.networks.values()].find(
                  (candidate) => candidate.Name === `dsh-team-net-${user.id}`,
                );
                if (network === undefined) throw new Error('Missing old bridge');
                f.daemon.networks.delete(network.Id);
                f.database.prepare('DELETE FROM instances WHERE user_id=?').run(user.id);
                seed(user.id, 'f'.repeat(64), current.port, 303);
                expect(f.service.status(user.id)).toEqual(running);
                expect(await (await gateway(user.cookie)).text()).toBe('current');
              }
              image.release();
              expect(await observeHttp(failed)).toBe(true);

              if (transition === 'missing') {
                expect(() => f.service.status(user.id)).toThrow('Instance operation failed');
                expect(() => f.service.resolveUpstream(user.id)).toThrow(
                  'Instance operation failed',
                );
                expect((await gateway(user.cookie)).status).toBe(502);
                const status = await fetch(`${f.base}/_platform/api/instance`, {
                  headers: { cookie: user.cookie },
                });
                expect(status.status).toBe(500);
                // Retrying before any new verified absence must not resurrect the old route.
                f.replyWith((request, reply) =>
                  request.path === `/containers/${START_CONTAINER}/json`
                    ? { status: 500, document: {} }
                    : reply,
                );
                await expect(f.service.start(user.id)).rejects.toThrow('Instance operation failed');
                expect(() => f.service.resolveUpstream(user.id)).toThrow(
                  'Instance operation failed',
                );
                expect((await gateway(user.cookie)).status).toBe(502);
              } else {
                expect(f.service.status(user.id)).toEqual(running);
                expect(await (await gateway(user.cookie)).text()).toBe('current');
              }
              expect(oldHits).toBe(hitsAtAbsence);
              expect(f.service.status(sibling.id)).toEqual(running);
              expect(await (await gateway(sibling.cookie)).text()).toBe('current');
            },
          );
        },
      );
    } finally {
      image.release();
      await f.close();
    }
  },
);
