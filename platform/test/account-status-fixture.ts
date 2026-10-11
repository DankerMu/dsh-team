import { rm } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { expect } from 'vitest';
import { createGatewayConnections } from '../src/gateway/index.ts';
import { RECONCILE_COOKIE } from './container-reconcile-fixture.ts';
import type { FastifyInstance } from 'fastify';
import type { DatabaseHandle } from '../src/db/index.ts';
import { buildApp } from '../src/app.ts';
import { createSession } from '../src/auth/index.ts';
import { createInstanceService } from '../src/orchestrator/index.ts';
import type { DockerClient } from '../src/orchestrator/index.ts';
import { administrator } from './admin-config-fixture.ts';
import { PUBLIC_ORIGIN, SOURCE, jsonRequestHeaders } from './auth-fixture.ts';
import {
  startupOwnerFixture,
  START_CONTAINER,
  START_IMAGE,
  startupBarrier,
  START_USER,
} from './container-start-fixture.ts';
import { configureInstanceModel, instanceConfig } from './instance-fixture.ts';

export async function accountStatusFixture(
  beforeReady?: (app: FastifyInstance, database: DatabaseHandle) => void,
  adapt?: (client: DockerClient) => DockerClient,
) {
  const f = await startupOwnerFixture();
  const config = instanceConfig(f.root, {
    ...f.input.config,
    publicUrl: PUBLIC_ORIGIN,
    logLevel: 'info',
  });
  const service = createInstanceService({ ...f, config, client: adapt?.(f.client) ?? f.client });
  const lines: string[] = [];
  const app = await buildApp(
    config,
    f.database,
    { write: (line) => lines.push(line) },
    undefined,
    service,
  );
  beforeReady?.(app, f.database);
  const admin = await administrator(app, f.database);
  return {
    ...f,
    app,
    service,
    config,
    lines,
    admin,
    holdEngine(matches: (method: string, path: string) => boolean, gate = startupBarrier()) {
      f.beforeRequest(async (method, path) => {
        if (matches(method, path)) await gate.hold();
        return undefined;
      });
      return gate;
    },
    async seedOwnedRunning() {
      await f.owner.startUserContainer(f.input);
      f.database
        .prepare("UPDATE instances SET status='running',dsh_cookie=? WHERE user_id=?")
        .run(RECONCILE_COOKIE, START_USER);
    },
    cookie: (id = START_USER) => `platform_session=${createSession(f.database, id, Date.now())}`,
    seedRunning(id = START_USER, containerId = START_CONTAINER) {
      f.database
        .prepare(
          `INSERT INTO instances(user_id,status,container_id,image_id,image_tag,
        upstream_host,upstream_port,dsh_cookie,last_started_at)
        VALUES (?,'running',?,?,'image:test','127.0.0.1',49173,'private-dsh-cookie',1)`,
        )
        .run(id, containerId, START_IMAGE);
      f.daemon.containers.set(containerId, {
        Id: containerId,
        Name: `/dsh-team-u-${id}`,
        Image: START_IMAGE,
        Config: { Labels: { 'dsh-team.user': id } },
        State: { Running: true },
        NetworkSettings: { Ports: {} },
      });
    },
    restart(id = START_USER, payload = '{}', cookie = admin.cookie) {
      return app.inject({
        method: 'POST',
        url: `/_platform/api/admin/instances/${id}/restart`,
        remoteAddress: SOURCE,
        headers: jsonRequestHeaders({ cookie }),
        payload,
      });
    },
    restartRunning(cookie = admin.cookie) {
      return app.inject({
        method: 'POST',
        url: '/_platform/api/admin/instances/restart-running',
        remoteAddress: SOURCE,
        headers: jsonRequestHeaders({ cookie }),
        payload: '{}',
      });
    },
    put(id: string, status: unknown, cookie = admin.cookie) {
      return app.inject({
        method: 'PUT',
        url: `/_platform/api/admin/users/${id}/status`,
        remoteAddress: SOURCE,
        headers: jsonRequestHeaders({ cookie }),
        payload: JSON.stringify({ status }),
      });
    },
    async close() {
      await app.close();
      await rm(f.root, { recursive: true, force: true });
    },
  };
}

export async function postRestart(base: string, cookie: string, id = START_USER) {
  const response = await fetch(`${base}/_platform/api/admin/instances/${id}/restart`, {
    method: 'POST',
    headers: jsonRequestHeaders({ cookie }),
    body: '{}',
  });
  const body: unknown = await response.json();
  return { status: response.status, body };
}
export async function postRunning(base: string, cookie: string) {
  const response = await fetch(`${base}/_platform/api/admin/instances/restart-running`, {
    method: 'POST',
    headers: jsonRequestHeaders({ cookie }),
    body: '{}',
  });
  const body: unknown = await response.json();
  return { status: response.status, body };
}

/** Own an actual registry and an external stream, optionally controlling its destroy boundary. */
export function capturedAdminConnection(
  userId = START_USER,
  beforeDestroy?: () => void | Promise<void>,
) {
  const resource = new PassThrough();
  const destroy = resource.destroy.bind(resource);
  resource.destroy = (error) => {
    const pending = beforeDestroy?.();
    if (pending instanceof Promise) {
      void pending.then(() => destroy(error));
      return resource;
    }
    return destroy(error);
  };
  const connections = createGatewayConnections();
  connections.track({ userId, token: 'owned-admin-transport' }, resource);
  return {
    resource,
    install: (app: FastifyInstance) => {
      app.disconnectUserConnections = connections.disconnectUser;
    },
    async close() {
      destroy();
      await connections.close();
    },
  };
}

export function restartAuditEntries(database: DatabaseHandle) {
  return database
    .prepare<[], { target: string | null; details: string }>(
      "SELECT target,details FROM audit_events WHERE event_type='instance.restarted'",
    )
    .all();
}

export function expectNoRestartAudit(database: DatabaseHandle): void {
  expect(restartAuditEntries(database)).toEqual([]);
}

/** Hold a real employee request before its owner changes the indexed state. */
export async function heldEmployeeStartup(initial: 'running' | 'stopped' | 'error') {
  const connection = capturedAdminConnection();
  const f = await accountStatusFixture(connection.install);
  let starting: Promise<Response> | undefined;
  let release: (() => void) | undefined;
  try {
    configureInstanceModel(f.database);
    if (initial === 'running') {
      // Preparation only; the held request always runs on the service's own original owner.
      await f.seedOwnedRunning();
    } else {
      f.database
        .prepare('INSERT INTO instances(user_id,status) VALUES (?,?)')
        .run(START_USER, initial);
    }
    const gate = f.holdEngine(
      (method, path) =>
        method === 'GET' &&
        (initial === 'running'
          ? path === `/containers/${START_CONTAINER}/json`
          : path.startsWith('/images/')),
    );
    release = gate.release;
    const base = await f.app.listen({ host: '127.0.0.1', port: 0 });
    starting = fetch(`${base}/_platform/api/instance/start`, {
      method: 'POST',
      headers: jsonRequestHeaders({ cookie: f.cookie() }),
      body: '{}',
    });
    const employee = starting;
    await gate.reached;
    const row = f.database.prepare('SELECT * FROM instances WHERE user_id=?').get(START_USER);
    const engine = [...f.daemon.requests];
    const audits = f.database.prepare('SELECT * FROM audit_events').all();
    return {
      ...f,
      base,
      row,
      resource: connection.resource,
      expectNoRestartEffects() {
        expect(f.daemon.requests).toEqual(engine);
        expect(
          f.database.prepare('SELECT * FROM instances WHERE user_id=?').get(START_USER),
        ).toEqual(row);
        expect(f.database.prepare('SELECT * FROM audit_events').all()).toEqual(audits);
        expect(connection.resource.closed).toBe(false);
      },
      async releaseEmployee() {
        gate.release();
        const response = await employee;
        const body: unknown = await response.json();
        return { status: response.status, body };
      },
      async close() {
        gate.release();
        await Promise.allSettled([employee]);
        await connection.close();
        await f.close();
      },
    };
  } catch (error) {
    release?.();
    if (starting !== undefined) await Promise.allSettled([starting]);
    await connection.close();
    await f.close();
    throw error;
  }
}
