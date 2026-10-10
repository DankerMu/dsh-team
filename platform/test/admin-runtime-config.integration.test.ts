import { randomBytes } from 'node:crypto';
import { rm, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { createSession, deleteUserSessions } from '../src/auth/index.ts';
import { readSettings, writeSettings } from '../src/db/index.ts';
import { jsonRequestHeaders, PUBLIC_ORIGIN, withApp } from './auth-fixture.ts';
import {
  startupCapacityEvidence,
  startupEvidence,
  startupOwnerFixture,
  START_CONTAINER,
  START_USER,
} from './container-start-fixture.ts';
import { registerAccount, successfulLogin, withListeningApp } from './auth-tcp-fixture.ts';
import { administrator, delayedConfigBody, MODEL_CONFIG } from './admin-config-fixture.ts';

const PATH = '/_platform/api/admin/runtime-config';
const CONFIG = {
  idleMinutes: 15,
  cpuCores: 0.25,
  memoryMiB: 2048,
  maxRunningInstances: 2,
  defaultPermissionTier: 'auto',
};
it('reads canonical runtime settings through the administrator API', async () => {
  await withListeningApp(async (base, app, database) => {
    const user = await registerAccount(app, 'runtime-admin@example.com');
    database.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
    const login = await successfulLogin(base, user.email);

    const response = await fetch(`${base}/_platform/api/admin/runtime-config`, {
      headers: { cookie: login.header },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      idleMinutes: 30,
      cpuCores: 2,
      memoryMiB: 4096,
      maxRunningInstances: 60,
      defaultPermissionTier: 'yolo',
    });
  });
});

it('roundtrips all runtime fields over TCP and rejects raw invalid bodies without mutation or input echoes', async () => {
  await withListeningApp(async (base, app, database, lines) => {
    const user = await registerAccount(app, 'runtime-admin@example.com');
    database.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
    const login = await successfulLogin(base, user.email);
    const headers = jsonRequestHeaders({ cookie: login.header });
    const saved = await fetch(`${base}${PATH}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(CONFIG),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual(CONFIG);
    const read = await fetch(`${base}${PATH}`, { headers: { cookie: login.header } });
    expect(await read.json()).toEqual(CONFIG);
    const before = database.prepare('SELECT * FROM settings ORDER BY key').all();
    const audits = database.prepare('SELECT * FROM audit_events ORDER BY id').all();
    const secret = randomBytes(32).toString('hex');
    for (const body of [
      JSON.stringify({ ...CONFIG, maxRunningInstances: 0 }),
      JSON.stringify({ ...CONFIG, maxRunningInstances: secret }),
      JSON.stringify({ ...CONFIG, cpuCores: '0.25' }),
      JSON.stringify({ ...CONFIG, modelApiKey: secret }),
      `{"modelApiKey":"${secret}",broken`,
      '[]',
      'null',
      '{}',
    ]) {
      const response = await fetch(`${base}${PATH}`, { method: 'PUT', headers, body });
      expect(response.status).toBe(400);
      const error = await response.text();
      if (body.includes('maxRunningInstances')) expect(error).toContain('1..9007199254740991');
      expect((error + lines.join('')).includes(secret)).toBe(false);
    }
    expect(database.prepare('SELECT * FROM settings ORDER BY key').all()).toEqual(before);
    expect(database.prepare('SELECT * FROM audit_events ORDER BY id').all()).toEqual(audits);
  });
});

it.each([
  ['172.30.0.0/16', 4096],
  ['192.0.2.0/28', 1],
] as const)(
  'accepts the capacity of %s and rejects a larger runtime limit without changing settings, audits or model credentials',
  async (subnetPool, maximum) => {
    await withListeningApp(
      async (base, app, database, lines) => {
        const { cookie } = await administrator(app, database);
        const secret = randomBytes(32).toString('hex');
        const models = {
          modelBaseUrl: MODEL_CONFIG.baseURL,
          models: MODEL_CONFIG.models,
          defaultModel: MODEL_CONFIG.defaultModel,
          modelApiKey: secret,
        };
        writeSettings(database, models);
        database.prepare('INSERT INTO settings VALUES (?, ?)').run('unowned', 'unchanged');
        const headers = jsonRequestHeaders({ cookie });
        const accepted = { ...CONFIG, maxRunningInstances: maximum };

        const saved = await fetch(`${base}${PATH}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify(accepted),
        });
        expect(saved.status).toBe(200);
        expect(await saved.json()).toEqual(accepted);
        const before = database.prepare('SELECT * FROM settings ORDER BY key').all();
        const audits = database.prepare('SELECT * FROM audit_events ORDER BY id').all();
        const response = await fetch(`${base}${PATH}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            idleMinutes: 45,
            cpuCores: 0.5,
            memoryMiB: 1024,
            maxRunningInstances: maximum + 1,
            defaultPermissionTier: 'approval',
          }),
        });
        const body = await response.text();
        const read = await fetch(`${base}${PATH}`, { headers: { cookie } });

        expect(response.status).toBe(400);
        expect(JSON.parse(body)).toMatchObject({ statusCode: 400, error: 'Bad Request' });
        expect(body).toContain(`PLATFORM_SUBNET_POOL provides ${String(maximum)} /28 subnets`);
        expect(body).toContain(`maxRunningInstances=${String(maximum + 1)}`);
        expect(await read.json()).toEqual(accepted);
        expect(database.prepare('SELECT * FROM settings ORDER BY key').all()).toEqual(before);
        expect(database.prepare('SELECT * FROM audit_events ORDER BY id').all()).toEqual(audits);
        expect(readSettings(database)).toMatchObject(models);
        expect((body + lines.join('')).includes(secret)).toBe(false);
      },
      false,
      [],
      { subnetPool, initialSettings: { maxRunningInstances: 1 } },
    );
  },
);

it('requires an administrator before parsing and preserves Origin, size and JSON admission', async () => {
  await withListeningApp(async (base, app, database, lines) => {
    const user = await registerAccount(app, 'employee@example.com');
    const cookie = `platform_session=${createSession(database, user.id, Date.now())}`;
    expect((await fetch(`${base}${PATH}`)).status).toBe(401);
    expect((await fetch(`${base}${PATH}`, { headers: { cookie } })).status).toBe(403);
    const employee = await fetch(`${base}${PATH}`, {
      method: 'PUT',
      headers: jsonRequestHeaders({ cookie }),
      body: '{broken',
    });
    expect(employee.status).toBe(403);
    database.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
    const audits = database.prepare('SELECT * FROM audit_events ORDER BY id').all();
    const secret = randomBytes(32).toString('hex');
    for (const [headers, body, status] of [
      [jsonRequestHeaders({ cookie, origin: undefined }), '{}', 403],
      [jsonRequestHeaders({ cookie, origin: 'http://foreign.invalid' }), '{}', 403],
      [jsonRequestHeaders({ cookie, 'content-type': 'text/plain' }), secret, 415],
    ] as const) {
      const response = await fetch(`${base}${PATH}`, { method: 'PUT', headers, body });
      expect(response.status).toBe(status);
      expect(((await response.text()) + lines.join('')).includes(secret)).toBe(false);
    }
    // Observe the size rejection before uploading the rest of a declared oversized body.
    // fetch may otherwise report a write reset while the server is already sending413.
    const oversized = Promise.withResolvers<{ status: number; body: string }>();
    const request = httpRequest(
      `${base}${PATH}`,
      {
        method: 'PUT',
        headers: { ...jsonRequestHeaders({ cookie }), 'content-length': '1048577' },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('error', oversized.reject);
        response.on('end', () => {
          oversized.resolve({ status: response.statusCode ?? 0, body });
        });
      },
    );
    request.on('error', oversized.reject);
    try {
      request.end(JSON.stringify({ ...CONFIG, modelApiKey: secret }));
      const response = await oversized.promise;
      expect(response.status).toBe(413);
      expect((response.body + lines.join('')).includes(secret)).toBe(false);
    } finally {
      request.destroy();
    }
    expect(database.prepare('SELECT * FROM settings').all()).toEqual([]);
    expect(database.prepare('SELECT * FROM audit_events ORDER BY id').all()).toEqual(audits);
  });
});

it.each(['revoked', 'demoted'] as const)(
  'rechecks the current administrator after a delayed body is admitted and %s',
  async (state) => {
    await withApp(async (app, database) => {
      const send = delayedConfigBody(app, PATH);
      const { user, cookie } = await administrator(app, database);
      const base = await app.listen({ host: '127.0.0.1', port: 0 });
      const body = JSON.stringify(CONFIG);
      const audits = database.prepare('SELECT * FROM audit_events ORDER BY id').all();
      const response = await send(base, cookie, body, () => {
        if (state === 'revoked') deleteUserSessions(database, user.id);
        else database.prepare("UPDATE users SET role = 'employee' WHERE id = ?").run(user.id);
      });
      expect(response.status).toBe(state === 'revoked' ? 401 : 403);
      expect(database.prepare('SELECT * FROM settings').all()).toEqual([]);
      expect(database.prepare('SELECT * FROM audit_events ORDER BY id').all()).toEqual(audits);
    });
  },
);

it.each(['audit', 'corruption'] as const)(
  'keeps settings and audit unchanged on a safe %s failure over TCP',
  async (boundary) => {
    await withListeningApp(async (base, app, database, lines) => {
      const user = await registerAccount(app, 'runtime-admin@example.com');
      database.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
      const cookie = `platform_session=${createSession(database, user.id, Date.now())}`;
      const headers = jsonRequestHeaders({ cookie });
      const saved = await fetch(`${base}${PATH}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(CONFIG),
      });
      expect(saved.status).toBe(200);
      await saved.text();
      const secret = randomBytes(32).toString('hex');
      if (boundary === 'audit')
        database.exec(
          `CREATE TRIGGER reject_runtime_audit BEFORE INSERT ON audit_events WHEN NEW.event_type = 'runtime-config.updated' BEGIN SELECT RAISE(ABORT, '${secret}'); END;`,
        );
      else
        database.prepare("UPDATE settings SET value = ? WHERE key = 'cpuCores'").run(`"${secret}"`);
      const before = database.prepare('SELECT * FROM settings ORDER BY key').all();
      const audits = database.prepare('SELECT * FROM audit_events ORDER BY id').all();
      const response = await fetch(`${base}${PATH}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ ...CONFIG, maxRunningInstances: 3 }),
      });
      const body = await response.text();
      expect(response.status).toBe(500);
      expect(JSON.parse(body)).toEqual({
        statusCode: 500,
        error: 'Internal Server Error',
        message: 'Internal Server Error',
      });
      expect(database.prepare('SELECT * FROM settings ORDER BY key').all()).toEqual(before);
      expect(database.prepare('SELECT * FROM audit_events ORDER BY id').all()).toEqual(audits);
      expect((body + lines.join('')).includes(secret)).toBe(false);
    });
  },
);

it('the same owner admits two users at 60 then denies a third after an HTTP limit of 2 without touching existing instances', async () => {
  const fixture = await startupOwnerFixture();
  const { database, owner, input, daemon, root } = fixture;
  let app: FastifyInstance | undefined;
  try {
    app = await buildApp(
      {
        host: '127.0.0.1',
        port: 8080,
        logLevel: 'silent',
        dataDir: root,
        managedConfigDir: input.config.managedConfigDir,
        dockerSocketPath: '/fixture/docker.sock',
        userImage: input.config.userImage,
        seccompProfilePath: input.config.seccompProfilePath,
        subnetPool: input.config.subnetPool,
        upstreamMode: 'published-loopback',
        platformContainerName: 'dsh-team-platform',
        publicUrl: PUBLIC_ORIGIN,
        authority: '127.0.0.1:8080',
        cookieSecure: false,
        trustedProxies: [],
      },
      database,
    );
    database.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(START_USER);
    const cookie = `platform_session=${createSession(database, START_USER, Date.now())}`;
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const initial = await fetch(`${base}${PATH}`, { headers: { cookie } });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({
      idleMinutes: 30,
      cpuCores: 2,
      memoryMiB: 4096,
      maxRunningInstances: 60,
      defaultPermissionTier: 'yolo',
    });
    // Actual SQLite and canonical owner; only Docker dependencies use the owned daemon fixture.
    expect(await owner.startUserContainer(input)).toEqual({
      outcome: 'starting',
      containerId: START_CONTAINER,
      upstreamHost: '127.0.0.1',
      upstreamPort: 49173,
    });
    const secondInput = { ...input, userId: 'mnopqrstuvwx' };
    const secondId = 'd'.repeat(64);
    daemon.setContainerId(secondId);
    expect(await owner.startUserContainer(secondInput)).toEqual({
      outcome: 'starting',
      containerId: secondId,
      upstreamHost: '127.0.0.1',
      upstreamPort: 49173,
    });
    database
      .prepare("UPDATE instances SET status = 'running' WHERE user_id IN (?, ?)")
      .run(START_USER, secondInput.userId);
    const firstBefore = await startupEvidence(database, input);
    const secondBefore = await startupEvidence(database, secondInput);
    const instanceAudits = database
      .prepare("SELECT * FROM audit_events WHERE event_type LIKE 'instance.%' ORDER BY id")
      .all();
    const containers = structuredClone([...daemon.containers]);
    const requests = structuredClone(daemon.requests);
    const saved = await fetch(`${base}${PATH}`, {
      method: 'PUT',
      headers: jsonRequestHeaders({ cookie }),
      body: JSON.stringify({
        idleMinutes: 30,
        cpuCores: 2,
        memoryMiB: 4096,
        maxRunningInstances: 2,
        defaultPermissionTier: 'yolo',
      }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({
      idleMinutes: 30,
      cpuCores: 2,
      memoryMiB: 4096,
      maxRunningInstances: 2,
      defaultPermissionTier: 'yolo',
    });
    expect(await startupEvidence(database, input)).toMatchObject({
      row: firstBefore.row,
      bytes: firstBefore.bytes,
      inode: firstBefore.inode,
    });
    expect(await startupEvidence(database, secondInput)).toMatchObject({
      row: secondBefore.row,
      bytes: secondBefore.bytes,
      inode: secondBefore.inode,
    });
    expect(
      database
        .prepare("SELECT * FROM audit_events WHERE event_type LIKE 'instance.%' ORDER BY id")
        .all(),
    ).toEqual(instanceAudits);
    expect([...daemon.containers]).toEqual(containers);
    expect(daemon.requests).toEqual(requests);
    const thirdUser = 'yzabcdefghij';
    database
      .prepare("INSERT INTO users VALUES (?, ?, 'unused', 'employee', 'active', 1)")
      .run(thirdUser, 'third@example.test');
    const before = await startupCapacityEvidence(database, input, daemon);
    const second = await startupEvidence(database, secondInput);
    expect(await owner.startUserContainer({ ...input, userId: thirdUser })).toEqual({
      outcome: 'full',
    });
    expect(await startupCapacityEvidence(database, input, daemon)).toEqual(before);
    expect(await startupEvidence(database, secondInput)).toEqual(second);
    expect(
      database.prepare('SELECT * FROM instances WHERE user_id = ?').get(thirdUser),
    ).toBeUndefined();
    await expect(
      stat(join(input.config.managedConfigDir, `${thirdUser}.patch.yml`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    if (app === undefined) database.close();
    else await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
