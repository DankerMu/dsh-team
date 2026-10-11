import { expect, it } from 'vitest';
import {
  accountStatusFixture,
  expectNoRestartAudit,
  restartAuditEntries,
} from '../../test/account-status-fixture.ts';
import { administrator } from '../../test/admin-config-fixture.ts';
import { jsonRequestHeaders, SOURCE, withApp } from '../../test/auth-fixture.ts';
import { registerAccount, expectNoSecrets } from '../../test/auth-tcp-fixture.ts';
import { START_CONTAINER, START_USER } from '../../test/container-start-fixture.ts';
import { configureInstanceModel } from '../../test/instance-fixture.ts';
import { writeSettings } from '../db/index.ts';

it.each([
  ...[null, [], { userId: START_USER }, { role: 'admin' }, 'empty', 0, true].map((body) => ({
    payload: JSON.stringify(body),
    status: 400,
    contentType: 'application/json',
  })),
  { payload: '{', status: 400, contentType: 'application/json' },
  {
    payload: '{"padding":"' + 'x'.repeat(1048576) + '"}',
    status: 413,
    contentType: 'application/json',
  },
  { payload: '{}', status: 415, contentType: 'text/plain' },
])(
  'rejects raw invalid restart input %# with $status and no effects',
  async ({ payload, status, contentType }) => {
    const f = await accountStatusFixture();
    try {
      f.seedRunning();
      const before = f.database.prepare('SELECT * FROM instances').all();
      const audits = f.database.prepare('SELECT * FROM audit_events').all();
      for (const path of [`${START_USER}/restart`, 'restart-running']) {
        const response = await f.app.inject({
          method: 'POST',
          url: `/_platform/api/admin/instances/${path}`,
          headers: {
            ...jsonRequestHeaders({ cookie: f.admin.cookie }),
            'content-type': contentType,
          },
          payload,
        });
        expect(response.statusCode).toBe(status);
        expect(f.database.prepare('SELECT * FROM instances').all()).toEqual(before);
        expect(f.database.prepare('SELECT * FROM audit_events').all()).toEqual(audits);
        expect(f.daemon.requests).toEqual([]);
      }
    } finally {
      await f.close();
    }
  },
);

it('rejects anonymous, employee, malformed, unknown, uncreated, disabled and starting targets without lifecycle effects', async () => {
  const f = await accountStatusFixture();
  try {
    expect((await f.restart(START_USER, '{}', '')).statusCode).toBe(401);
    expect((await f.restart(START_USER, '{}', f.cookie())).statusCode).toBe(403);
    expect((await f.restart('BAD-user')).statusCode).toBe(400);
    expect((await f.restart('zzzzzzzzzzzz')).statusCode).toBe(404);
    expect((await f.restart()).statusCode).toBe(404);
    f.database
      .prepare("INSERT INTO instances(user_id,status) VALUES (?,'starting')")
      .run(START_USER);
    expect((await f.restart()).statusCode).toBe(409);
    f.database.prepare("UPDATE instances SET status='stopped'").run();
    f.database.prepare("UPDATE users SET status='disabled' WHERE id=?").run(START_USER);
    expect((await f.restart()).statusCode).toBe(409);
    expect(f.daemon.requests).toEqual([]);
    expectNoRestartAudit(f.database);
  } finally {
    await f.close();
  }
});

it('offline restart rejects indexed work while an empty running set has no lifecycle dependency', async () => {
  await withApp(async (app, database) => {
    const admin = await administrator(app, database);
    const target = await registerAccount(app, 'offline-restart@example.test');
    for (const userId of [target.id, 'zzzzzzzzzzzz']) {
      const missing = await app.inject({
        method: 'POST',
        url: `/_platform/api/admin/instances/${userId}/restart`,
        headers: jsonRequestHeaders({ cookie: admin.cookie }),
        payload: '{}',
      });
      expect(missing.statusCode).toBe(404);
    }
    database.prepare("INSERT INTO instances(user_id,status) VALUES (?,'stopped')").run(target.id);
    const before = database.prepare('SELECT * FROM instances').all();
    const response = await app.inject({
      method: 'POST',
      url: `/_platform/api/admin/instances/${target.id}/restart`,
      headers: jsonRequestHeaders({ cookie: admin.cookie }),
      payload: '{}',
    });
    expect(response.statusCode).toBe(503);
    expect(database.prepare('SELECT * FROM instances').all()).toEqual(before);
    const empty = await app.inject({
      method: 'POST',
      url: '/_platform/api/admin/instances/restart-running',
      headers: jsonRequestHeaders({ cookie: admin.cookie }),
      payload: '{}',
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ items: [] });
    database.prepare("UPDATE instances SET status='running'").run();
    const unavailable = await app.inject({
      method: 'POST',
      url: '/_platform/api/admin/instances/restart-running',
      headers: jsonRequestHeaders({ cookie: admin.cookie }),
      payload: '{}',
    });
    expect(unavailable.statusCode).toBe(503);
    database.prepare("UPDATE instances SET status='starting'").run();
    const starting = await app.inject({
      method: 'POST',
      url: `/_platform/api/admin/instances/${target.id}/restart`,
      headers: jsonRequestHeaders({ cookie: admin.cookie }),
      payload: '{}',
    });
    expect(starting.statusCode).toBe(409);
    database.prepare("UPDATE instances SET status='stopped'").run();
    database.prepare("UPDATE users SET status='disabled' WHERE id=?").run(target.id);
    const disabled = await app.inject({
      method: 'POST',
      url: `/_platform/api/admin/instances/${target.id}/restart`,
      headers: jsonRequestHeaders({ cookie: admin.cookie }),
      payload: '{}',
    });
    expect(disabled.statusCode).toBe(409);
  });
});

it.each(['running', 'stopped', 'error'] as const)(
  'restarts a %s instance through real lifecycle admission while preserving account and platform sessions',
  async (status) => {
    const f = await accountStatusFixture();
    try {
      configureInstanceModel(f.database);
      if (status === 'running') f.seedRunning();
      else
        f.database
          .prepare('INSERT INTO instances(user_id,status) VALUES (?,?)')
          .run(START_USER, status);
      f.cookie();
      const sessions = f.database
        .prepare('SELECT * FROM platform_sessions ORDER BY token_hash')
        .all();
      const users = f.database.prepare('SELECT * FROM users ORDER BY id').all();

      const response = await f.restart();

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        userId: START_USER,
        status: 'starting',
        reason: 'starting',
      });
      expect(
        f.database.prepare('SELECT * FROM platform_sessions ORDER BY token_hash').all(),
      ).toEqual(sessions);
      expect(f.database.prepare('SELECT * FROM users ORDER BY id').all()).toEqual(users);
      expect(
        f.database
          .prepare(
            "SELECT actor_email,target_email,target,source_address,details FROM audit_events WHERE event_type='instance.restarted'",
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
      expect(
        f.database
          .prepare("SELECT details FROM audit_events WHERE event_type='instance.stopped'")
          .all(),
      ).toEqual(status === 'running' ? [{ details: '{"reason":"admin"}' }] : []);
      expectNoSecrets(f.lines, response.json(), ['private-dsh-cookie', 'service-key']);
    } finally {
      await f.close();
    }
  },
);

it.each(['unconfigured', 'full'] as const)(
  'returns the actual %s admission without a restart audit or provisioning',
  async (outcome) => {
    const f = await accountStatusFixture();
    try {
      f.seedRunning();
      if (outcome === 'full') {
        configureInstanceModel(f.database);
        writeSettings(f.database, { maxRunningInstances: 1 });
        f.database
          .prepare("INSERT INTO instances(user_id,status) VALUES ('mnopqrstuvwx','running')")
          .run();
      }
      const response = await f.restart();
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ userId: START_USER, status: outcome, reason: outcome });
      expect(f.daemon.containers.has(START_CONTAINER)).toBe(false);
      expect(
        f.daemon.requests.filter(
          ({ method, path }) => method === 'POST' && path.startsWith('/containers/create'),
        ),
      ).toEqual([]);
      expectNoRestartAudit(f.database);
      expect(
        f.database
          .prepare("SELECT details FROM audit_events WHERE event_type='instance.stopped'")
          .all(),
      ).toEqual([{ details: '{"reason":"admin"}' }]);
    } finally {
      await f.close();
    }
  },
);

it.each(['stop', 'start'] as const)(
  'reports safe %s Engine failure, preserves physical history and releases administrator exclusion',
  async (phase) => {
    const f = await accountStatusFixture();
    try {
      f.seedRunning();
      configureInstanceModel(f.database);
      const path =
        phase === 'stop'
          ? `POST /containers/${START_CONTAINER}/stop?t=1`
          : 'GET /images/dsh-team-user%3Alocal/json';
      f.daemon.overrides.set(path, { status: 500, document: { message: 'private-engine-token' } });
      const response = await f.restart();
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        statusCode: 500,
        error: 'Internal Server Error',
        message: 'Internal Server Error',
      });
      expectNoRestartAudit(f.database);
      expect(f.daemon.containers.has(START_CONTAINER)).toBe(phase === 'stop');
      expect(
        f.database
          .prepare("SELECT details FROM audit_events WHERE event_type='instance.stopped'")
          .all(),
      ).toEqual(phase === 'stop' ? [] : [{ details: '{"reason":"admin"}' }]);
      f.daemon.overrides.delete(path);
      writeSettings(f.database, { modelApiKey: '' });
      const retry = await f.restart();
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toEqual({
        userId: START_USER,
        status: 'unconfigured',
        reason: 'unconfigured',
      });
      expectNoRestartAudit(f.database);
      expectNoSecrets(f.lines, response.json(), ['private-engine-token', 'private-dsh-cookie']);
    } finally {
      await f.close();
    }
  },
);

it('prevalidates every captured running target before stopping any and ignores terminal rows', async () => {
  const f = await accountStatusFixture();
  try {
    f.seedRunning();
    f.database
      .prepare("INSERT INTO instances(user_id,status) VALUES ('mnopqrstuvwx','running')")
      .run();
    f.database.prepare("UPDATE users SET status='disabled' WHERE id='mnopqrstuvwx'").run();
    const response = await f.restartRunning();
    expect(response.statusCode).toBe(409);
    expect(f.daemon.requests).toEqual([]);
    expect(f.daemon.containers.get(START_CONTAINER)?.State.Running).toBe(true);
    f.database.prepare("UPDATE instances SET status='error' WHERE user_id='mnopqrstuvwx'").run();
    const accepted = await f.restartRunning();
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({
      items: [{ userId: START_USER, status: 'unconfigured', reason: 'unconfigured' }],
    });
    expect(
      f.database.prepare("SELECT status FROM instances WHERE user_id='mnopqrstuvwx'").get(),
    ).toEqual({ status: 'error' });
  } finally {
    await f.close();
  }
});

it('sanitizes bulk selection storage failure without destructive effects', async () => {
  const f = await accountStatusFixture();
  try {
    f.seedRunning();
    f.database.exec('DROP TABLE instances');
    const response = await f.restartRunning();
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Internal Server Error',
    });
    expect(f.daemon.requests).toEqual([]);
  } finally {
    await f.close();
  }
});

it('returns an authoritative persisted error receipt without a false restart-success event', async () => {
  const f = await accountStatusFixture();
  try {
    configureInstanceModel(f.database);
    f.database
      .prepare(
        "INSERT INTO instances(user_id,status,last_error) VALUES (?,'error','original safe diagnostic')",
      )
      .run(START_USER);
    f.daemon.overrides.set('GET /images/dsh-team-user%3Alocal/json', {
      status: 500,
      document: { message: 'private-engine-token' },
    });
    const response = await f.restart();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ userId: START_USER, status: 'error', reason: 'error' });
    expectNoRestartAudit(f.database);
    expect(
      f.database.prepare('SELECT status,last_error FROM instances WHERE user_id=?').get(START_USER),
    ).toEqual({ status: 'error', last_error: 'original safe diagnostic' });
    expectNoSecrets(f.lines, response.json(), ['private-engine-token']);
  } finally {
    await f.close();
  }
});

it('bulk capacity rejection is an explicit item and does not prevent a later selected target from starting', async () => {
  const f = await accountStatusFixture();
  try {
    configureInstanceModel(f.database);
    writeSettings(f.database, { maxRunningInstances: 1 });
    f.seedRunning();
    f.seedRunning('mnopqrstuvwx', 'd'.repeat(64));
    const response = await f.restartRunning();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        { userId: START_USER, status: 'full', reason: 'full' },
        { userId: 'mnopqrstuvwx', status: 'starting', reason: 'starting' },
      ],
    });
    expect(restartAuditEntries(f.database)).toEqual([{ target: 'mnopqrstuvwx', details: '{}' }]);
    expect(
      f.database
        .prepare(
          "SELECT target,details FROM audit_events WHERE event_type='instance.stopped' ORDER BY id",
        )
        .all(),
    ).toEqual([
      { target: START_USER, details: '{"reason":"admin"}' },
      { target: 'mnopqrstuvwx', details: '{"reason":"admin"}' },
    ]);
  } finally {
    await f.close();
  }
});

it('bulk retains an authoritative error item and continues to the next selected target without a false success audit', async () => {
  const f = await accountStatusFixture();
  try {
    configureInstanceModel(f.database);
    f.seedRunning();
    f.seedRunning('mnopqrstuvwx', 'd'.repeat(64));
    f.daemon.beforeRequest(({ method, path }) => {
      if (method === 'POST' && path === `/containers/create?name=dsh-team-u-${START_USER}`)
        f.daemon.setContainerId('e'.repeat(64));
      if (method === 'POST' && path === '/containers/create?name=dsh-team-u-mnopqrstuvwx')
        f.daemon.setContainerId('f'.repeat(64));
    });
    // Inject a durable storage transition, not a service/restart result. Real startup observes it.
    f.database.exec(`CREATE TRIGGER publish_error AFTER INSERT ON audit_events
      WHEN NEW.event_type='instance.created' AND NEW.target='${START_USER}'
      BEGIN UPDATE instances SET status='error',last_error='fixture storage failure' WHERE user_id='${START_USER}'; END`);
    const response = await f.restartRunning();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        { userId: START_USER, status: 'error', reason: 'error' },
        { userId: 'mnopqrstuvwx', status: 'starting', reason: 'starting' },
      ],
    });
    expect(restartAuditEntries(f.database)).toEqual([{ target: 'mnopqrstuvwx', details: '{}' }]);
    expect(
      f.database.prepare('SELECT status,last_error FROM instances WHERE user_id=?').get(START_USER),
    ).toEqual({ status: 'error', last_error: 'fixture storage failure' });
  } finally {
    await f.close();
  }
});
