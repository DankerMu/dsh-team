import { createHash, randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { writeSettings } from '../src/db/index.ts';
import {
  expectUnauthorizedResponse,
  registerAccount,
  successfulLogin,
  withListeningApp,
} from './auth-tcp-fixture.ts';

const PATH = '/_platform/api/admin/instances';
const SEEDED_PORT = '49173';

/**
 * Pino's time/pid/hostname, Fastify's responseTime and listen message, and the request
 * serializer's host/remotePort come from the clock, the process and ephemeral sockets, never
 * from an instance row, so their digits may contain the seeded port by chance (#568).
 */
function withoutGeneratedFields(line: string, base: string): string {
  const entry: unknown = JSON.parse(line);
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
    throw new Error(`expected a JSON object log line: ${line}`);
  const fields = entry as Record<string, unknown>;
  delete fields.time;
  delete fields.pid;
  delete fields.hostname;
  delete fields.responseTime;
  if (fields.msg === `Server listening at ${base}`) delete fields.msg;
  const request = fields.req;
  if (typeof request === 'object' && request !== null) {
    const requestFields = request as Record<string, unknown>;
    delete requestFields.host;
    delete requestFields.remotePort;
  }
  return JSON.stringify(fields);
}

function expectSeededPortAbsentFromLogs(lines: readonly string[], base: string): void {
  for (const line of lines) expect(withoutGeneratedFields(line, base)).not.toContain(SEEDED_PORT);
}

it('checks the seeded port in log lines outside logger- and socket-generated fields', () => {
  const base = `http://127.0.0.1:${SEEDED_PORT}`;
  const generated = [
    { level: 30, time: 1794129491735, msg: 'incoming request' },
    { level: 30, responseTime: 34.491730001, msg: 'request completed' },
    { level: 30, pid: 49173, hostname: 'host-49173', msg: 'request completed' },
    {
      level: 30,
      req: {
        method: 'GET',
        url: PATH,
        host: `127.0.0.1:${SEEDED_PORT}`,
        remoteAddress: '127.0.0.1',
        remotePort: 49173,
      },
      msg: 'incoming request',
    },
    { level: 30, msg: `Server listening at ${base}` },
  ].map((entry) => JSON.stringify(entry));
  expect(() => {
    expectSeededPortAbsentFromLogs(generated, base);
  }).not.toThrow();
  for (const leaked of [
    JSON.stringify({ level: 30, msg: `Server listening at ${base}/` }),
    JSON.stringify({ level: 30, msg: `Server listening at ${base} and upstream` }),
    JSON.stringify({ level: 30, msg: `upstream 127.0.0.1:${SEEDED_PORT} refused` }),
    JSON.stringify({
      level: 50,
      err: { message: `connect ECONNREFUSED 127.0.0.1:${SEEDED_PORT}` },
    }),
    JSON.stringify({ level: 30, upstreamPort: 49173 }),
    JSON.stringify({ level: 30, req: { method: 'GET', url: `${PATH}?port=${SEEDED_PORT}` } }),
    'not json',
    '[]',
  ])
    expect(() => {
      expectSeededPortAbsentFromLogs([leaked], base);
    }, leaked).toThrow();
});

it('rejects unauthenticated instance listing', async () => {
  await withListeningApp(async (base) => {
    const response = await fetch(`${base}/_platform/api/admin/instances`);

    await expectUnauthorizedResponse(response);
  });
});

it('lists all five persisted instance states without private metadata or mutations using current administrator authority', async () => {
  await withListeningApp(async (base, app, database, lines) => {
    const operator = await registerAccount(app, 'operator@example.com');
    database.prepare('UPDATE users SET created_at = 5000 WHERE id = ?').run(operator.id);
    const suffix = randomBytes(24).toString('hex');
    const privateValues = {
      container: `container-${suffix}`,
      host: `upstream-${suffix}.invalid`,
      cookie: `dsh-auth=${suffix}`,
      imageTag: `private-image:${suffix}`,
      imageId: `private-image-id-${suffix}`,
      passwordHash: `private-password-hash-${suffix}`,
      modelKey: `private-model-key-${suffix}`,
    };
    const safeError = 'DSH exited before readiness; log tail:\nsafe diagnostic';
    for (const [id, email, createdAt, status, started, activity, error] of [
      [
        'stopped-user',
        'stopped@example.com',
        4000,
        'stopped',
        1700000000111,
        null,
        'Previous readiness timeout',
      ],
      ['starting-user', 'starting@example.com', 3000, 'starting', null, 1700000000222, null],
      ['running-user', 'running@example.com', 3000, 'running', 1700000000333, 1700000000444, null],
      ['error-user', 'error@example.com', 1000, 'error', 1700000000555, 1700000000666, safeError],
    ] as const) {
      database
        .prepare(
          "INSERT INTO users(id,email,password_hash,role,status,created_at) SELECT ?,?,password_hash,'employee','active',? FROM users WHERE id = ?",
        )
        .run(id, email, createdAt, operator.id);
      database
        .prepare(
          `INSERT INTO instances(user_id,status,last_started_at,last_activity_at,last_error,
            container_id,upstream_host,upstream_port,dsh_cookie,image_tag,image_id)
          VALUES (?,?,?,?,?,?,?,49173,?,?,?)`,
        )
        .run(
          id,
          status,
          started,
          activity,
          error,
          privateValues.container,
          privateValues.host,
          privateValues.cookie,
          privateValues.imageTag,
          privateValues.imageId,
        );
    }
    const login = await successfulLogin(base, operator.email);
    const employee = await successfulLogin(base, 'stopped@example.com');
    const endpoint = `${base}${PATH}`;
    const headers = { cookie: `platform_session=${login.token}` };
    expect((await fetch(endpoint, { headers })).status).toBe(403);
    database.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(operator.id);
    database.prepare("UPDATE users SET status = 'disabled' WHERE id = 'error-user'").run();
    database.prepare('UPDATE users SET password_hash = ?').run(privateValues.passwordHash);
    writeSettings(database, { modelApiKey: privateValues.modelKey });
    const before = {
      users: database.prepare('SELECT * FROM users ORDER BY id').all(),
      instances: database.prepare('SELECT * FROM instances ORDER BY user_id').all(),
      audits: database.prepare('SELECT * FROM audit_events ORDER BY id').all(),
    };

    const anonymousForgery = await fetch(`${endpoint}?role=admin&userId=${operator.id}`, {
      headers: { 'x-user-id': operator.id, 'x-user-role': 'admin' },
    });
    expect(anonymousForgery.status).toBe(401);
    const employeeForgery = await fetch(`${endpoint}?role=admin&userId=${operator.id}`, {
      headers: {
        cookie: `platform_session=${employee.token}`,
        'x-user-id': operator.id,
        'x-user-role': 'admin',
      },
    });
    expect(employeeForgery.status).toBe(403);
    const response = await fetch(endpoint, { headers });
    const text = await response.text();

    expect(response.status).toBe(200);
    const responseBody: unknown = JSON.parse(text);
    expect(responseBody).toEqual({
      items: [
        {
          userId: operator.id,
          email: 'operator@example.com',
          status: 'not-created',
          lastStartedAt: null,
          lastActivityAt: null,
          lastError: null,
        },
        {
          userId: 'stopped-user',
          email: 'stopped@example.com',
          status: 'stopped',
          lastStartedAt: 1700000000111,
          lastActivityAt: null,
          lastError: 'Previous readiness timeout',
        },
        {
          userId: 'starting-user',
          email: 'starting@example.com',
          status: 'starting',
          lastStartedAt: null,
          lastActivityAt: 1700000000222,
          lastError: null,
        },
        {
          userId: 'running-user',
          email: 'running@example.com',
          status: 'running',
          lastStartedAt: 1700000000333,
          lastActivityAt: 1700000000444,
          lastError: null,
        },
        {
          userId: 'error-user',
          email: 'error@example.com',
          status: 'error',
          lastStartedAt: 1700000000555,
          lastActivityAt: 1700000000666,
          lastError: safeError,
        },
      ],
    });
    for (const secret of [
      ...Object.values(privateValues),
      login.token,
      employee.token,
      createHash('sha256').update(login.token).digest('hex'),
      createHash('sha256').update(employee.token).digest('hex'),
      'password_hash',
      'token_hash',
      'dsh_cookie',
      'container_id',
      'upstream_host',
      'upstream_port',
      'image_tag',
      'image_id',
    ])
      expect(text + lines.join('')).not.toContain(secret);
    expect(text).not.toContain(SEEDED_PORT);
    expectSeededPortAbsentFromLogs(lines, base);
    database.prepare("UPDATE users SET role = 'employee' WHERE id = ?").run(operator.id);
    expect((await fetch(endpoint, { headers })).status).toBe(403);
    database.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(operator.id);
    const restored = await fetch(endpoint, { headers });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toEqual(responseBody);
    expect({
      users: database.prepare('SELECT * FROM users ORDER BY id').all(),
      instances: database.prepare('SELECT * FROM instances ORDER BY user_id').all(),
      audits: database.prepare('SELECT * FROM audit_events ORDER BY id').all(),
    }).toEqual(before);
  });
});
