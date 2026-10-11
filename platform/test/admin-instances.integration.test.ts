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
      '49173',
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
