import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { applyMigrations, openDatabase } from '../src/db/index.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import { createDockerClient, startUserContainer } from '../src/orchestrator/index.ts';
import type { StartUserContainerInput } from '../src/orchestrator/index.ts';
import {
  startupDaemon,
  START_CONTAINER,
  START_HELPER,
  START_MODEL,
  START_PERMISSION,
  START_USER,
} from './container-start-fixture.ts';

let root: string;
let database: DatabaseHandle;
let input: StartUserContainerInput;
let daemon = startupDaemon();
const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    try {
      // This local Engine fixture accepts only bodies serialized by the public Docker client.
      const body =
        chunks.length === 0
          ? {}
          : (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
      const reply = daemon.reply({ method: request.method ?? '', path: request.url ?? '', body });
      response
        .writeHead(reply.status)
        .end(reply.bytes ?? (reply.document === undefined ? '' : JSON.stringify(reply.document)));
    } catch {
      response.writeHead(500).end();
    }
  });
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-start-wire-'));
  database = openDatabase(join(root, 'platform.db'));
  applyMigrations(database);
  database
    .prepare(
      "INSERT INTO users VALUES (?, 'employee@example.test', 'unused-hash', 'employee', 'active', 1)",
    )
    .run(START_USER);
  daemon = startupDaemon();
  const seccomp = join(root, 'seccomp.json');
  await writeFile(seccomp, '{"defaultAction":"SCMP_ACT_ERRNO","syscalls":[]}');
  const socket = join(root, 'engine.sock');
  server.listen(socket);
  await once(server, 'listening');
  input = {
    client: createDockerClient(socket),
    database,
    userId: START_USER,
    config: {
      userImage: 'dsh-team-user:local',
      seccompProfilePath: seccomp,
      managedConfigDir: join(root, 'managed'),
      authority: 'team.example:8443',
    },
    modelSettings: START_MODEL,
    modelKey: 'fixture-private-key',
    permission: START_PERMISSION,
  };
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  database.close();
  await rm(root, { recursive: true, force: true });
});

function rows() {
  return database.prepare('SELECT * FROM instances').all();
}
function audits() {
  return database
    .prepare('SELECT event_type, target, target_email, details FROM audit_events ORDER BY id')
    .all();
}

it('commits completed creation and start separately, persists inspected endpoint, and never marks DSH ready', async () => {
  const observations: unknown[] = [];
  daemon.beforeRequest((request) => {
    if (
      request.path === '/containers/create?name=dsh-team-u-abcdefghijkl' ||
      request.path === `/containers/${START_CONTAINER}/start` ||
      (request.path === `/containers/${START_CONTAINER}/json` &&
        daemon.containers.get(START_CONTAINER)?.State.Running === true)
    ) {
      observations.push({ path: request.path, rows: rows(), audits: audits() });
    }
  });

  const result = await startUserContainer(input);

  expect(result).toEqual({
    outcome: 'starting',
    containerId: START_CONTAINER,
    upstreamHost: '127.0.0.1',
    upstreamPort: 49173,
  });
  expect(observations[0]).toEqual({
    path: '/containers/create?name=dsh-team-u-abcdefghijkl',
    rows: [],
    audits: [],
  });
  for (const observation of observations.slice(1)) {
    expect(observation).toMatchObject({
      rows: [
        {
          container_id: START_CONTAINER,
          status: 'starting',
          upstream_host: null,
          upstream_port: null,
          last_started_at: null,
        },
      ],
      audits: [{ event_type: 'instance.created' }],
    });
  }
  expect(rows()).toEqual([
    {
      user_id: START_USER,
      status: 'starting',
      container_id: START_CONTAINER,
      upstream_host: '127.0.0.1',
      upstream_port: 49173,
      dsh_cookie: null,
      image_tag: 'dsh-team-user:local',
      // Vitest's matcher is untyped; it is an expected-value sentinel, not database data.
      last_started_at: expect.any(Number) as unknown,
      last_activity_at: null,
      last_error: null,
    },
  ]);
  expect(audits()).toEqual([
    {
      event_type: 'instance.created',
      target: START_USER,
      target_email: 'employee@example.test',
      details: '{}',
    },
    {
      event_type: 'instance.started',
      target: START_USER,
      target_email: 'employee@example.test',
      details: '{}',
    },
  ]);
  expect(
    JSON.stringify(rows()) +
      JSON.stringify(audits()) +
      (await readFile(join(root, 'managed', 'abcdefghijkl.patch.yml'), 'utf8')),
  ).not.toContain('fixture-private-key');
  database.close();
  database = openDatabase(join(root, 'platform.db'));
  expect(rows()).toMatchObject([{ status: 'starting', upstream_port: 49173 }]);
  expect(audits()).toEqual([
    {
      event_type: 'instance.created',
      target: START_USER,
      target_email: 'employee@example.test',
      details: '{}',
    },
    {
      event_type: 'instance.started',
      target: START_USER,
      target_email: 'employee@example.test',
      details: '{}',
    },
  ]);
});

it.each([undefined, ''])(
  'does not start or index an instance when its actual model credential is %j',
  async (modelKey) => {
    expect(await startUserContainer({ ...input, modelKey })).toEqual({ outcome: 'unconfigured' });
    expect(rows()).toEqual([]);
    expect(audits()).toEqual([]);
    expect(daemon.requests).toEqual([]);
  },
);

it.each(['instance.created', 'instance.started'])(
  'rolls back the matching index transition if %s audit persistence fails',
  async (event) => {
    database.exec(`CREATE TRIGGER reject_start_audit BEFORE INSERT ON audit_events
    WHEN NEW.event_type = '${event}' BEGIN SELECT RAISE(ABORT, 'fixture-private-key'); END`);

    const error: unknown = await startUserContainer(input).catch((failure: unknown) => failure);

    expect(String(error)).toContain(
      event === 'instance.created' ? 'creation persistence' : 'start persistence',
    );
    expect(String(error) + JSON.stringify(error)).not.toContain('fixture-private-key');
    if (event === 'instance.created') {
      expect(rows()).toEqual([]);
      expect(audits()).toEqual([]);
      expect(daemon.containers.get(START_CONTAINER)?.State.Running).toBe(false);
    } else {
      expect(rows()).toMatchObject([
        {
          container_id: START_CONTAINER,
          status: 'starting',
          upstream_host: null,
          upstream_port: null,
          last_started_at: null,
        },
      ]);
      expect(audits()).toEqual([
        {
          event_type: 'instance.created',
          target: START_USER,
          target_email: 'employee@example.test',
          details: '{}',
        },
      ]);
    }
    expect(daemon.containers.has(START_CONTAINER)).toBe(true);
    expect(
      daemon.requests.some(
        (request) => request.method === 'DELETE' && request.path.startsWith('/volumes'),
      ),
    ).toBe(false);
  },
);

it.each(['start failure', 'foreign owner', 'wrong identity', 'not running', 'wildcard endpoint'])(
  'preserves created identity but no usable endpoint or started audit after %s',
  async (failure) => {
    if (failure === 'start failure')
      daemon.overrides.set(`POST /containers/${START_CONTAINER}/start`, { status: 500 });
    daemon.beforeRequest((request) => {
      if (request.path !== `/containers/${START_CONTAINER}/json`) return;
      const container = daemon.containers.get(START_CONTAINER);
      if (!container) throw new Error('Missing fixture container');
      if (!container.State.Running) return;
      if (failure === 'foreign owner')
        container.Config.Labels = { 'dsh-team.user': 'mnopqrstuvwx' };
      if (failure === 'wrong identity') container.Id = 'd'.repeat(64);
      if (failure === 'not running') container.State.Running = false;
      if (failure === 'wildcard endpoint')
        container.NetworkSettings.Ports = {
          '3080/tcp': [{ HostIp: '0.0.0.0', HostPort: '49173' }],
        };
    });

    await expect(startUserContainer(input)).rejects.toThrow(
      /container start|started container inspection/,
    );

    expect(rows()).toMatchObject([
      {
        container_id: START_CONTAINER,
        status: 'starting',
        upstream_host: null,
        upstream_port: null,
        last_started_at: null,
        dsh_cookie: null,
      },
    ]);
    expect(audits()).toEqual([
      {
        event_type: 'instance.created',
        target: START_USER,
        target_email: 'employee@example.test',
        details: '{}',
      },
    ]);
  },
);

it('cancels a pending composition wait and still removes only its helper with a fresh cleanup deadline', async () => {
  const controller = new AbortController();
  daemon.beforeRequest((request) => {
    if (request.path === `/containers/${START_HELPER}/wait?condition=not-running`)
      controller.abort();
  });

  await expect(startUserContainer({ ...input, signal: controller.signal })).rejects.toThrow(
    /managed composition/,
  );

  expect(daemon.containers.size).toBe(0);
  expect(
    daemon.requests.filter((request) => request.method === 'DELETE').map((request) => request.path),
  ).toEqual([`/containers/${START_HELPER}?force=true`]);
  expect(rows()).toEqual([]);
  expect(audits()).toEqual([]);
});
