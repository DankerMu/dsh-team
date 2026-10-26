import { expect, it } from 'vitest';
import {
  expectUnauthorizedResponse,
  postJson,
  registerAccount,
  successfulLogin,
  withListeningApp,
} from './auth-tcp-fixture.ts';

function readSession(baseUrl: string, token?: string): Promise<Response> {
  return fetch(`${baseUrl}/_platform/api/session`, {
    headers: token === undefined ? {} : { cookie: `theme=dark; platform_session=${token}` },
  });
}

it('answers exactly {email, role} for both roles over real TCP and 401 after logout or disable', async () => {
  await withListeningApp(async (baseUrl, app, database, lines) => {
    await registerAccount(app, 'Employee@Example.com');
    const admin = await registerAccount(app, 'admin@example.com');
    database.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.id);
    const employeeLogin = await successfulLogin(baseUrl, ' employee@example.com ');
    const adminLogin = await successfulLogin(baseUrl, 'admin@example.com');

    await expectUnauthorizedResponse(await readSession(baseUrl));
    const employee = await readSession(baseUrl, employeeLogin.token);
    expect(employee.status).toBe(200);
    expect(employee.headers.get('content-type')).toContain('application/json');
    expect(await employee.text()).toBe('{"email":"employee@example.com","role":"employee"}');
    const administrator = await readSession(baseUrl, adminLogin.token);
    expect(await administrator.json()).toStrictEqual({
      email: 'admin@example.com',
      role: 'admin',
    });

    const logout = await postJson(
      `${baseUrl}/_platform/api/logout`,
      {},
      { cookie: `platform_session=${employeeLogin.token}` },
    );
    expect(logout.status).toBe(204);
    await expectUnauthorizedResponse(await readSession(baseUrl, employeeLogin.token));
    database.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(admin.id);
    await expectUnauthorizedResponse(await readSession(baseUrl, adminLogin.token));

    const written = lines.join('');
    expect(written).not.toContain(employeeLogin.token);
    expect(written).not.toContain(adminLogin.token);
  });
});
