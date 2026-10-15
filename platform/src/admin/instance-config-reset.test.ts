import type { FastifyInstance } from 'fastify';
import { setImmediate } from 'node:timers/promises';
import { expect, it } from 'vitest';
import {
  accountStatusFixture,
  capturedAdminConnection,
} from '../../test/account-status-fixture.ts';
import { jsonRequestHeaders, SOURCE, withApp } from '../../test/auth-fixture.ts';
import { START_CONTAINER, START_HELPER, START_USER } from '../../test/container-start-fixture.ts';
import { administrator } from '../../test/admin-config-fixture.ts';

function reset(app: FastifyInstance, cookie: string, userId = START_USER) {
  return app.inject({
    method: 'POST',
    url: `/_platform/api/admin/instances/${userId}/reset-config`,
    remoteAddress: SOURCE,
    headers: jsonRequestHeaders({ cookie }),
    payload: '{}',
  });
}

it('administrator reset retires the instance, restores profiles and audits without restarting or revoking sessions', async () => {
  const f = await accountStatusFixture();
  try {
    await f.seedOwnedRunning();
    f.cookie();
    const sessions = f.database
      .prepare('SELECT * FROM platform_sessions ORDER BY token_hash')
      .all();
    f.daemon.overrides.set(`GET /volumes/dsh-team-home-${START_USER}`, {
      status: 200,
      document: { Name: `dsh-team-home-${START_USER}`, Labels: { 'dsh-team.user': START_USER } },
    });

    const response = await reset(f.app, f.admin.cookie);

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(
      f.database
        .prepare('SELECT status,container_id FROM instances WHERE user_id=?')
        .get(START_USER),
    ).toEqual({ status: 'stopped', container_id: null });
    expect(f.daemon.containers.size).toBe(0);
    expect(f.database.prepare('SELECT * FROM platform_sessions ORDER BY token_hash').all()).toEqual(
      sessions,
    );
    expect(
      f.database
        .prepare(
          "SELECT actor_email,target_email,target,source_address,details FROM audit_events WHERE event_type='instance.config-reset'",
        )
        .all(),
    ).toEqual([
      {
        actor_email: f.admin.user.email,
        target_email: `${START_USER}@example.test`,
        target: START_USER,
        source_address: SOURCE,
        details: '{}',
      },
    ]);
  } finally {
    await f.close();
  }
});

it('rejects anonymous, employee, malformed, unknown, uncreated, starting and disabled reset targets', async () => {
  const f = await accountStatusFixture();
  try {
    expect((await reset(f.app, '')).statusCode).toBe(401);
    expect((await reset(f.app, f.cookie())).statusCode).toBe(403);
    expect((await reset(f.app, f.admin.cookie, 'invalid')).statusCode).toBe(400);
    expect((await reset(f.app, f.admin.cookie, 'zzzzzzzzzzzz')).statusCode).toBe(404);
    expect((await reset(f.app, f.admin.cookie)).statusCode).toBe(404);
    f.database
      .prepare("INSERT INTO instances(user_id,status) VALUES (?,'starting')")
      .run(START_USER);
    expect((await reset(f.app, f.admin.cookie)).statusCode).toBe(409);
    f.database.prepare("UPDATE instances SET status='stopped'").run();
    f.database.prepare("UPDATE users SET status='disabled' WHERE id=?").run(START_USER);
    expect((await reset(f.app, f.admin.cookie)).statusCode).toBe(409);
    expect(f.daemon.requests).toEqual([]);
    expect(
      f.database
        .prepare("SELECT id FROM audit_events WHERE event_type='instance.config-reset'")
        .all(),
    ).toEqual([]);
  } finally {
    await f.close();
  }
});

it.each(['disconnect', 'stop'])(
  'rechecks administrator authority after %s before profile restoration',
  async (phase) => {
    let closeConnection: (() => Promise<void>) | undefined;
    const f = await accountStatusFixture((app, database) => {
      if (phase !== 'disconnect') return;
      const connection = capturedAdminConnection(START_USER, () => {
        database.prepare("UPDATE users SET role='employee' WHERE role='admin'").run();
      });
      connection.install(app);
      closeConnection = () => connection.close();
    });
    try {
      await f.seedOwnedRunning();
      if (phase === 'stop')
        f.daemon.beforeRequest(({ method, path }) => {
          if (method === 'DELETE' && path.startsWith(`/containers/${START_CONTAINER}`))
            f.database.prepare("UPDATE users SET role='employee' WHERE role='admin'").run();
        });
      const count = f.daemon.requests.length;

      expect((await reset(f.app, f.admin.cookie)).statusCode).toBe(403);

      expect(
        f.daemon.requests
          .slice(count)
          .some(({ path }) => path.startsWith('/containers/create?name=dsh-team-restore-')),
      ).toBe(false);
      expect(
        f.database
          .prepare("SELECT id FROM audit_events WHERE event_type='instance.config-reset'")
          .all(),
      ).toEqual([]);
    } finally {
      await closeConnection?.();
      await f.close();
    }
  },
);

it('does not report or audit a successful reset when restore or audit storage fails', async () => {
  const f = await accountStatusFixture();
  try {
    await f.seedOwnedRunning();
    expect((await reset(f.app, f.admin.cookie)).statusCode).toBe(500);
    expect(
      f.database
        .prepare("SELECT id FROM audit_events WHERE event_type='instance.config-reset'")
        .all(),
    ).toEqual([]);
    f.daemon.overrides.set(`GET /volumes/dsh-team-home-${START_USER}`, {
      status: 200,
      document: { Name: `dsh-team-home-${START_USER}`, Labels: { 'dsh-team.user': START_USER } },
    });
    f.database.exec(
      "CREATE TRIGGER fail_reset BEFORE INSERT ON audit_events WHEN NEW.event_type='instance.config-reset' BEGIN SELECT RAISE(FAIL,'private-reset-storage-detail'); END",
    );

    const response = await reset(f.app, f.admin.cookie);

    expect(response.statusCode).toBe(500);
    expect(response.body + f.lines.join('')).not.toContain('private-reset-storage-detail');
    expect(
      f.database
        .prepare("SELECT id FROM audit_events WHERE event_type='instance.config-reset'")
        .all(),
    ).toEqual([]);
    expect(f.daemon.containers.size).toBe(0);
  } finally {
    await f.close();
  }
});

it('holds reset ownership across cleanup, rejects conflicting actions and employee starts, and drains before close', async () => {
  const f = await accountStatusFixture();
  try {
    await f.seedOwnedRunning();
    const cookie = f.cookie();
    f.daemon.overrides.set(`GET /volumes/dsh-team-home-${START_USER}`, {
      status: 200,
      document: { Name: `dsh-team-home-${START_USER}`, Labels: { 'dsh-team.user': START_USER } },
    });
    const gate = f.holdEngine(
      (method, path) => method === 'DELETE' && path === `/containers/${START_HELPER}?force=true`,
    );
    const result = reset(f.app, f.admin.cookie).then((response) => response);
    await gate.reached;
    let closing: Promise<void> | undefined;
    try {
      expect((await reset(f.app, f.admin.cookie)).statusCode).toBe(409);
      expect((await f.restart()).statusCode).toBe(409);
      expect((await f.put(START_USER, 'disabled')).statusCode).toBe(409);
      const start = await f.app.inject({
        method: 'POST',
        url: '/_platform/api/instance/start',
        headers: jsonRequestHeaders({ cookie }),
        payload: '{}',
      });
      expect(start.statusCode).toBe(500);
      await expect(
        f.service.resetConfig(START_USER, () => {
          throw new Error('Unexpected admission');
        }),
      ).rejects.toThrow('Instance service unavailable');
      let closed = false;
      closing = f.service.close().then(() => {
        closed = true;
      });
      await setImmediate();
      expect(closed).toBe(false);
    } finally {
      gate.release();
      await result;
      await closing;
    }
    expect((await result).statusCode).toBe(204);
    expect(
      f.database
        .prepare("SELECT target FROM audit_events WHERE event_type='instance.config-reset'")
        .all(),
    ).toEqual([{ target: START_USER }]);
    expect(f.daemon.containers.size).toBe(0);
  } finally {
    await f.close();
  }
});

it('declares reset offline but refuses indexed work without a lifecycle service', async () => {
  await withApp(async (app, database) => {
    const admin = await administrator(app, database);
    database
      .prepare("INSERT INTO instances(user_id,status) VALUES (?,'stopped')")
      .run(admin.user.id);
    const before = database.prepare('SELECT * FROM instances').all();
    const audits = database.prepare('SELECT * FROM audit_events').all();

    expect((await reset(app, admin.cookie, admin.user.id)).statusCode).toBe(503);

    expect(database.prepare('SELECT * FROM instances').all()).toEqual(before);
    expect(database.prepare('SELECT * FROM audit_events').all()).toEqual(audits);
  });
});
