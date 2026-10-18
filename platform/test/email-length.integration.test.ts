import { expect, it } from 'vitest';
import { recordAuditEvent } from '../src/audit/index.ts';
import { snapshotAuthState, tableCounts } from './auth-fixture.ts';
import { PASSWORD, postJson, withListeningApp } from './auth-tcp-fixture.ts';

it.each([
  `${'a'.repeat(253)}@b`,
  `${'\u{10000}'.repeat(253)}@b`,
  `${'\u0130'.repeat(126)}a@b`,
  `${'a'.repeat(65536)}@b`,
])('rejects over-limit registration and login without persistence (case %#)', async (email) => {
  await withListeningApp(async (baseUrl, _app, database, lines) => {
    const before = snapshotAuthState(database);

    for (const operation of ['register', 'login']) {
      const response = await postJson(`${baseUrl}/_platform/api/${operation}`, {
        email,
        password: PASSWORD,
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Invalid email',
      });
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(tableCounts(database)).toEqual({ users: 0, sessions: 0, audits: 0 });
      expect(snapshotAuthState(database)).toEqual(before);
      expect(lines.join('')).not.toContain(email);
    }
  });
});

it('registers and logs in a normalized boundary identity and filters its exact audit identity', async () => {
  await withListeningApp(async (baseUrl, _app, database) => {
    const email = `${'\u{10000}'.repeat(252)}@b`;
    const unknown = await postJson(`${baseUrl}/_platform/api/login`, { email, password: PASSWORD });
    expect(unknown.status).toBe(401);
    await unknown.json();
    expect(database.prepare('SELECT actor_email, target_email FROM audit_events').all()).toEqual([
      { actor_email: email, target_email: null },
    ]);
    const registration = await postJson(`${baseUrl}/_platform/api/register`, {
      email: `  ${email.toUpperCase()}  `,
      password: PASSWORD,
    });
    expect(registration.status).toBe(201);
    expect(await registration.json()).toMatchObject({ email, role: 'employee' });
    expect(database.prepare('SELECT email FROM users').all()).toEqual([{ email }]);
    expect(
      database
        .prepare(
          "SELECT actor_email, target_email FROM audit_events WHERE event_type = 'account.registered'",
        )
        .all(),
    ).toEqual([{ actor_email: email, target_email: email }]);

    const login = await postJson(`${baseUrl}/_platform/api/login`, { email, password: PASSWORD });
    expect(login.status).toBe(200);
    expect(await login.json()).toMatchObject({ email });
    const cookie = login.headers.getSetCookie()[0];
    if (cookie === undefined) throw new Error('Missing authenticated cookie');
    database.exec("UPDATE users SET role = 'admin'");
    const historical = 'z'.repeat(255);
    database
      .prepare(
        "INSERT INTO audit_events (created_at, event_type, details, actor_email) VALUES (1, 'login.failed', '{}', ?)",
      )
      .run(historical);
    recordAuditEvent(database, { type: 'login.failed', createdAt: 2, targetEmail: email });
    const before = snapshotAuthState(database).audits;
    const query = async (parameters: string) => {
      const response = await fetch(`${baseUrl}/_platform/api/admin/audit-events?${parameters}`, {
        headers: { cookie },
      });
      return { status: response.status, body: await response.json() };
    };

    expect(await query('eventType=login.failed&from=1&to=1')).toMatchObject({
      status: 200,
      body: { items: [{ actorEmail: historical, targetEmail: null }] },
    });
    expect(
      await query(`eventType=login.failed&from=2&to=2&email=${encodeURIComponent(email)}`),
    ).toMatchObject({
      status: 200,
      body: { items: [{ actorEmail: null, targetEmail: email }] },
    });
    expect(await query(`email=${historical}`)).toMatchObject({ status: 400 });
    expect(await query(`email=${historical.slice(0, 254)}`)).toMatchObject({
      status: 200,
      body: { items: [] },
    });
    expect(snapshotAuthState(database).audits).toEqual(before);
  });
});
