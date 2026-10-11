import { rm } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { DatabaseHandle } from '../src/db/index.ts';
import { buildApp } from '../src/app.ts';
import { createSession } from '../src/auth/index.ts';
import { createInstanceService } from '../src/orchestrator/index.ts';
import { administrator } from './admin-config-fixture.ts';
import { PUBLIC_ORIGIN, SOURCE, jsonRequestHeaders } from './auth-fixture.ts';
import {
  startupOwnerFixture,
  START_CONTAINER,
  START_IMAGE,
  START_USER,
} from './container-start-fixture.ts';
import { instanceConfig } from './instance-fixture.ts';

export async function accountStatusFixture(
  beforeReady?: (app: FastifyInstance, database: DatabaseHandle) => void,
) {
  const f = await startupOwnerFixture();
  const config = instanceConfig(f.root, {
    ...f.input.config,
    publicUrl: PUBLIC_ORIGIN,
    logLevel: 'info',
  });
  const service = createInstanceService({ ...f, config });
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
