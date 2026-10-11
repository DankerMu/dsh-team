import type * as NodeCrypto from 'node:crypto';
import { afterAll, expect, it, vi } from 'vitest';
import {
  expectNoSecrets,
  expectUnauthorizedResponse,
  getIdentity,
  PASSWORD,
  postJson,
  registerAccount,
  successfulLogin,
  withListeningApp,
} from './auth-tcp-fixture.ts';
import { jsonRequestHeaders } from './auth-fixture.ts';
import { administrator } from './admin-config-fixture.ts';
import { snapshotPasswordState } from './password-change-fixture.ts';
import {
  createBarrier,
  cryptoBarrier,
  discardBarrier,
  waitForDerivation,
} from './auth-crypto-fixture.ts';
import { createSession, deleteUserSessions } from '../src/auth/index.ts';
import { observeHttp, withForwardingApp, withUpstream } from './gateway-http-fixture.ts';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>();
  const { controlledScrypt } = await import('./auth-crypto-fixture.ts');
  return { ...actual, scrypt: controlledScrypt(actual.scrypt) };
});
afterAll(() => {
  vi.doUnmock('node:crypto');
});

const reset = (base: string, userId: string, cookie: string, newPassword: string) =>
  fetch(`${base}/_platform/api/admin/users/${userId}/password`, {
    method: 'PUT',
    headers: jsonRequestHeaders({ cookie }),
    body: JSON.stringify({ newPassword }),
  });

it('rejects an unauthenticated administrator password reset before changing credentials', async () => {
  await withListeningApp(async (base) => {
    const response = await reset(base, 'abcdefghijkl', '', 'reset-password');
    await expectUnauthorizedResponse(response);
  });
});

it('replaces only the target password, revokes every old session and preserves five-character rejection', async () => {
  await withListeningApp(async (base, app, database, lines) => {
    const admin = await administrator(app, database);
    const target = await registerAccount(app, 'reset-target@example.test');
    const first = await successfulLogin(base, target.email);
    const second = await successfulLogin(base, target.email);
    const before = snapshotPasswordState(database);
    const short = await reset(base, target.id, admin.cookie, '12345');
    expect(short.status).toBe(400);
    expect(await short.json()).toMatchObject({
      message: 'Password must be 6 to 256 Unicode code points',
    });
    expect(snapshotPasswordState(database)).toEqual(before);
    const replacement = ' new password 中文 ';
    const changed = await reset(base, target.id, admin.cookie, replacement);
    expect(changed.status).toBe(204);
    expect(await changed.text()).toBe('');
    expect(changed.headers.get('set-cookie')).toBeNull();
    for (const cookie of [first.header, second.header]) {
      const denied = await getIdentity(base, cookie);
      expect(denied.status).toBe(401);
      await denied.arrayBuffer();
    }
    const oldLogin = await postJson(`${base}/_platform/api/login`, {
      email: target.email,
      password: PASSWORD,
    });
    expect(oldLogin.status).toBe(401);
    await oldLogin.arrayBuffer();
    const newLogin = await postJson(`${base}/_platform/api/login`, {
      email: target.email,
      password: replacement,
    });
    expect(newLogin.status).toBe(200);
    expect(await newLogin.json()).toEqual(target);
    const sibling = await getIdentity(base, admin.cookie);
    expect(sibling.status).toBe(200);
    await sibling.arrayBuffer();
    const audit = database
      .prepare(
        "SELECT actor_email,target_email,target,details FROM audit_events WHERE event_type='password.reset'",
      )
      .all();
    expect(audit).toEqual([
      {
        actor_email: admin.user.email,
        target_email: target.email,
        target: target.id,
        details: '{}',
      },
    ]);
    expectNoSecrets(lines, audit, [PASSWORD, replacement, first.token, second.token]);
  });
});

it.each(['revoke', 'demote', 'missing', 'audit-failure'] as const)(
  'contains %s while real password hashing is held',
  async (change) => {
    await withListeningApp(async (base, app, database, lines) => {
      const admin = await administrator(app, database);
      const target = await registerAccount(app, 'hash-target@example.test');
      const barrier = createBarrier();
      cryptoBarrier.queue.push(barrier);
      const pending = reset(base, target.id, admin.cookie, 'hash-window-password');
      try {
        await waitForDerivation(barrier, pending, 'administrator reset');
        if (change === 'revoke')
          database.prepare('DELETE FROM platform_sessions WHERE user_id=?').run(admin.user.id);
        if (change === 'demote')
          database.prepare("UPDATE users SET role='employee' WHERE id=?").run(admin.user.id);
        if (change === 'missing') {
          deleteUserSessions(database, target.id);
          database.prepare('DELETE FROM users WHERE id=?').run(target.id);
        }
        if (change === 'audit-failure')
          database.exec(
            "CREATE TRIGGER reject_password_reset BEFORE INSERT ON audit_events WHEN NEW.event_type='password.reset' BEGIN SELECT RAISE(ABORT,'private-reset-storage'); END",
          );
        const before = snapshotPasswordState(database);
        barrier.release();
        const response = await pending;
        expect(response.status).toBe(
          change === 'revoke' ? 401 : change === 'demote' ? 403 : change === 'missing' ? 404 : 500,
        );
        const body: unknown = await response.json();
        expect(snapshotPasswordState(database)).toEqual(before);
        expectNoSecrets(lines, body, ['hash-window-password', 'private-reset-storage']);
      } finally {
        discardBarrier(barrier);
        await Promise.allSettled([pending]);
      }
    });
  },
);

it('closes captured streams from every old target session while another user stream survives', async () => {
  const finish = new Map<string, () => void>();
  await withUpstream(
    (request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '14' });
      response.write('prefix');
      finish.set(request.url ?? '/', () => {
        response.end('complete');
      });
    },
    async (target) => {
      await withForwardingApp(
        () => target,
        async ({ base, app, database, cookie, userId }) => {
          const admin = await administrator(app, database);
          const second = `platform_session=${createSession(database, userId, Date.now())}`;
          const open = async (path: string, token: string) => {
            const response = await fetch(base + path, { headers: { cookie: token } });
            expect(response.status).toBe(200);
            return {
              settled: response.text().then(
                (body) => ({ closed: false, body }),
                () => ({ closed: true, body: '' }),
              ),
            };
          };
          const one = await open('/old-one', cookie);
          const two = await open('/old-two', second);
          const sibling = await open('/sibling', admin.cookie);
          const response = await reset(base, userId, admin.cookie, 'reset-live-streams');
          expect(response.status).toBe(204);
          await response.arrayBuffer();
          expect(await observeHttp(one.settled)).toEqual({ closed: true, body: '' });
          expect(await observeHttp(two.settled)).toEqual({ closed: true, body: '' });
          const finishSibling = finish.get('/sibling');
          if (finishSibling === undefined) throw new Error('Missing sibling stream');
          finishSibling();
          expect(await observeHttp(sibling.settled)).toEqual({
            closed: false,
            body: 'prefixcomplete',
          });
        },
      );
    },
  );
});

it('serializes concurrent resets by commit order and revokes sessions created between commits', async () => {
  await withListeningApp(async (base, app, database) => {
    const admin = await administrator(app, database);
    const target = await registerAccount(app, 'concurrent-reset@example.test');
    const barrier = createBarrier();
    cryptoBarrier.queue.push(barrier);
    const earlier = reset(base, target.id, admin.cookie, 'earlier-request-later-commit');
    try {
      await waitForDerivation(barrier, earlier, 'first reset');
      const later = await reset(base, target.id, admin.cookie, 'later-request-first-commit');
      expect(later.status).toBe(204);
      await later.arrayBuffer();
      const intermediate = await postJson(`${base}/_platform/api/login`, {
        email: target.email,
        password: 'later-request-first-commit',
      });
      expect(intermediate.status).toBe(200);
      await intermediate.arrayBuffer();
      const cookie = intermediate.headers.get('set-cookie')?.split(';')[0];
      if (cookie === undefined) throw new Error('Missing intermediate session');
      barrier.release();
      const final = await earlier;
      expect(final.status).toBe(204);
      await final.arrayBuffer();
      const denied = await getIdentity(base, cookie);
      expect(denied.status).toBe(401);
      await denied.arrayBuffer();
      for (const [password, status] of [
        ['later-request-first-commit', 401],
        ['earlier-request-later-commit', 200],
      ] as const) {
        const login = await postJson(`${base}/_platform/api/login`, {
          email: target.email,
          password,
        });
        expect(login.status).toBe(status);
        await login.arrayBuffer();
      }
      expect(
        database
          .prepare(
            "SELECT event_type,target FROM audit_events WHERE event_type='password.reset' ORDER BY id",
          )
          .all(),
      ).toEqual([
        { event_type: 'password.reset', target: target.id },
        { event_type: 'password.reset', target: target.id },
      ]);
    } finally {
      discardBarrier(barrier);
      await Promise.allSettled([earlier]);
    }
  });
});
