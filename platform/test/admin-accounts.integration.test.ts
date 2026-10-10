import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { registerAccount, successfulLogin, withListeningApp } from './auth-tcp-fixture.ts';

it('rejects unauthenticated account listing before query validation', async () => {
  await withListeningApp(async (base) => {
    const response = await fetch(`${base}/_platform/api/admin/users?page=invalid`);

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ statusCode: 401 });
  });
});

it('authorizes the current administrator and returns only public account fields with stable filtered pages', async () => {
  await withListeningApp(async (base, app, database, lines) => {
    const administrator = await registerAccount(app, 'operator@example.com');
    const first = await registerAccount(app, 'needle_one@example.com');
    const second = await registerAccount(app, 'needle%two@example.com');
    const login = await successfulLogin(base, administrator.email);
    const employee = await successfulLogin(base, first.email);
    const headers = { cookie: `platform_session=${login.token}` };
    const endpoint = `${base}/_platform/api/admin/users`;
    expect((await fetch(endpoint, { headers })).status).toBe(403);
    database.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(administrator.id);
    database.prepare('UPDATE users SET created_at = ?').run(123456);
    const dshCookie = `dsh-auth=${randomBytes(32).toString('hex')}`;
    database
      .prepare("INSERT INTO instances(user_id,status,dsh_cookie) VALUES (?,'stopped',?)")
      .run(first.id, dshCookie);
    const auditCount: unknown = database.prepare('SELECT COUNT(*) FROM audit_events').pluck().get();
    const expected = [first, second]
      .sort((a, b) => b.id.localeCompare(a.id))
      .map((user) => ({ ...user, status: 'active', createdAt: 123456 }));

    const denied = await fetch(`${endpoint}?role=admin`, {
      headers: {
        cookie: `platform_session=${employee.token}`,
        'x-user-id': administrator.id,
        'x-user-role': 'admin',
      },
    });
    expect(denied.status).toBe(403);
    const all = await fetch(endpoint, { headers });
    expect(all.status).toBe(200);
    expect(await all.json()).toEqual({
      items: [
        ...expected,
        { ...administrator, role: 'admin', status: 'active', createdAt: 123456 },
      ].sort((a, b) => b.id.localeCompare(a.id)),
      page: 1,
      pageSize: 50,
      total: 3,
    });
    for (const page of [1, 2, 3]) {
      const response = await fetch(
        `${endpoint}?search=%20NEEDLE%20&page=${String(page)}&pageSize=1`,
        { headers },
      );
      const text = await response.text();
      expect(response.status).toBe(200);
      // JSON.parse returns any; compare the complete untrusted public response as unknown.
      expect(JSON.parse(text) as unknown).toEqual({
        items: expected.slice(page - 1, page),
        page,
        pageSize: 1,
        total: 2,
      });
      for (const secret of [
        login.token,
        employee.token,
        dshCookie,
        'password_hash',
        'token_hash',
        'dsh_cookie',
      ])
        expect((text + lines.join('')).includes(secret)).toBe(false);
    }
    for (const [search, items] of [
      ['%', [expected.find((user) => user.id === second.id)]],
      ['_', [expected.find((user) => user.id === first.id)]],
      ["' OR 1=1 --", []],
      ['absent', []],
    ] as const) {
      const response = await fetch(`${endpoint}?search=${encodeURIComponent(search)}`, { headers });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ items, page: 1, pageSize: 50, total: items.length });
    }
    expect(database.prepare('SELECT COUNT(*) FROM audit_events').pluck().get()).toEqual(auditCount);
  });
});
