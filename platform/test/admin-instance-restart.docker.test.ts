import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import {
  inspect,
  record,
  corruptOwnedOverlay,
  assertFailedStartupLogs,
  normalizeInspectMounts,
} from './container-start-docker-fixture.ts';
import { observeHttp } from './gateway-http-fixture.ts';
import { instanceGatewayFixture, orderedMounts } from './instance-gateway-docker-fixture.ts';
import { withDockerIdleInstance } from './instance-idle-docker-fixture.ts';
import type { DockerIdleContext } from './instance-idle-docker-fixture.ts';
import { registerInstanceUser } from './instance-fixture.ts';

async function restart(f: DockerIdleContext, cookie: string, userId?: string) {
  const path = userId === undefined ? 'restart-running' : `${userId}/restart`;
  const response = await fetch(`${f.base}/_platform/api/admin/instances/${path}`, {
    method: 'POST',
    headers: { cookie, origin: f.origin, 'content-type': 'application/json' },
    body: '{}',
  });
  expect(response.status).toBe(200);
  return record(await response.json());
}

async function restartReady(
  f: DockerIdleContext,
  adminCookie: string,
  ready: (cookie: string) => Promise<void>,
) {
  f.setNow(Date.now() + 1000);
  expect(await restart(f, adminCookie, f.user.id)).toEqual({
    userId: f.user.id,
    status: 'starting',
    reason: 'starting',
  });
  await ready(f.user.cookie);
}

async function ownedUser(f: DockerIdleContext, email: string) {
  const user = await registerInstanceUser(f.base, f.origin, email);
  const ownership = { 'dsh-team.user': user.id };
  f.lifecycle.registerResource('container', `dsh-team-u-${user.id}`, ownership);
  for (const name of [`dsh-team-home-${user.id}`, `dsh-team-work-${user.id}`])
    f.lifecycle.registerResource('volume', name, ownership);
  return user;
}
async function errorState(f: DockerIdleContext) {
  const signal = AbortSignal.timeout(90_000);
  for (;;) {
    const response = await fetch(`${f.base}/_platform/api/instance`, {
      headers: { cookie: f.user.cookie },
    });
    expect(response.status).toBe(200);
    const state: unknown = await response.json();
    if (record(state).status === 'error') {
      expect(state).toEqual({ status: 'error', reason: 'error' });
      return;
    }
    expect(state).toEqual({ status: 'starting', reason: 'starting' });
    await delay(100, undefined, { signal });
  }
}

it('admin HTTP restart updates physical StartedAt, reaches ready and preserves genuine Session/history, files, volumes, platform sessions and sibling connection', async () => {
  await withDockerIdleInstance(async (f) => {
    const gateway = instanceGatewayFixture(f);
    try {
      const admin = await registerInstanceUser(f.base, f.origin, 'restart-admin@example.test');
      f.database.prepare("UPDATE users SET role='admin' WHERE id=?").run(admin.id);
      const sibling = await ownedUser(f, 'restart-sibling@example.test');
      await gateway.state(sibling.cookie, true);
      await gateway.ready(sibling.cookie);
      const siblingRow = record(
        f.database.prepare('SELECT * FROM instances WHERE user_id=?').get(sibling.id),
      );
      if (typeof siblingRow.container_id !== 'string')
        throw new Error('Missing real sibling identity');
      const siblingId = siblingRow.container_id;
      gateway.exec(
        siblingId,
        "import {writeFileSync} from 'node:fs'; for(const path of ['/data/home/issue71-sibling','/data/work/issue71-sibling'])writeFileSync(path,'sibling unchanged 中文\\n');",
      );
      const siblingBefore = inspect(f.lifecycle, siblingId);
      const siblingConnection = await gateway.open(sibling.cookie);
      const targetConnection = await gateway.open(f.user.cookie);
      const { sessionId, originalHistory } = await gateway.persistedSession(f);
      const bytes = Buffer.from([0, 13, 10, 127, 128, 255]);
      gateway.exec(
        f.containerId,
        `import {writeFileSync} from 'node:fs'; for(const path of ['/data/home/issue71-home','/data/work/issue71-work'])writeFileSync(path,Buffer.from('${bytes.toString('base64')}','base64'));`,
      );
      const before = inspect(f.lifecycle, f.containerId);
      const startedAt = record(before.State).StartedAt;
      if (typeof startedAt !== 'string') throw new Error('Missing independent StartedAt');
      const row = record(
        f.database.prepare('SELECT * FROM instances WHERE user_id=?').get(f.user.id),
      );
      const sessions = f.database
        .prepare('SELECT * FROM platform_sessions ORDER BY token_hash')
        .all();
      const accounts = f.database.prepare('SELECT * FROM users ORDER BY id').all();
      f.setNow(Date.now() + 1000);

      const receipt = await restart(f, admin.cookie, f.user.id);
      expect(receipt).toEqual({ userId: f.user.id, status: 'starting', reason: 'starting' });
      await observeHttp(targetConnection.closed, 5000);
      await gateway.ready(f.user.cookie);

      const ready = record(
        f.database.prepare('SELECT * FROM instances WHERE user_id=?').get(f.user.id),
      );
      if (
        typeof ready.container_id !== 'string' ||
        typeof ready.last_started_at !== 'number' ||
        typeof row.last_started_at !== 'number'
      )
        throw new Error('Missing restarted ready identity');
      expect(ready.container_id).not.toBe(f.containerId);
      expect(ready.last_started_at).toBeGreaterThan(row.last_started_at);
      expect(ready.status).toBe('running');
      expect(ready.last_error).toBeNull();
      const after = inspect(f.lifecycle, ready.container_id);
      expect(after.Id).toBe(ready.container_id);
      expect(record(after.State).Running).toBe(true);
      const newStartedAt = record(after.State).StartedAt;
      if (typeof newStartedAt !== 'string') throw new Error('Missing replacement StartedAt');
      expect(Date.parse(newStartedAt)).toBeGreaterThan(Date.parse(startedAt));
      expect(orderedMounts(after.Mounts)).toEqual(orderedMounts(before.Mounts));
      f.verifyVolumes();
      expect(
        JSON.parse(
          gateway.exec(
            ready.container_id,
            "import {readFileSync} from 'node:fs'; process.stdout.write(JSON.stringify(['/data/home/issue71-home','/data/work/issue71-work'].map(path=>readFileSync(path).toString('base64'))));",
          ),
        ),
      ).toEqual([bytes.toString('base64'), bytes.toString('base64')]);
      expect(await gateway.history(f.user.cookie, sessionId)).toEqual(originalHistory);
      const listed = await gateway.rpc(f.user.cookie, 'session/list', { _request: {} });
      expect(listed.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sessionId, cwd: '/data/work', running: false }),
        ]),
      );
      const reconnected = await gateway.open(f.user.cookie);
      expect(reconnected.socket.destroyed).toBe(false);
      expect(
        f.database.prepare('SELECT * FROM platform_sessions ORDER BY token_hash').all(),
      ).toEqual(sessions);
      expect(f.database.prepare('SELECT * FROM users ORDER BY id').all()).toEqual(accounts);
      expect(siblingConnection.socket.destroyed).toBe(false);
      expect(normalizeInspectMounts(inspect(f.lifecycle, siblingId))).toEqual(
        normalizeInspectMounts(siblingBefore),
      );
      expect(f.database.prepare('SELECT * FROM instances WHERE user_id=?').get(sibling.id)).toEqual(
        siblingRow,
      );
      expect(
        JSON.parse(
          gateway.exec(
            siblingId,
            "import {readFileSync} from 'node:fs'; process.stdout.write(JSON.stringify(['/data/home/issue71-sibling','/data/work/issue71-sibling'].map(path=>readFileSync(path,'utf8'))));",
          ),
        ),
      ).toEqual(['sibling unchanged 中文\n', 'sibling unchanged 中文\n']);
      expect(
        f.database
          .prepare(
            "SELECT event_type,target,actor_email,target_email,details FROM audit_events WHERE event_type IN ('instance.stopped','instance.restarted') ORDER BY id",
          )
          .all(),
      ).toEqual([
        {
          event_type: 'instance.stopped',
          target: f.user.id,
          actor_email: null,
          target_email: 'idle-docker@example.test',
          details: '{"reason":"admin"}',
        },
        {
          event_type: 'instance.restarted',
          target: f.user.id,
          actor_email: 'restart-admin@example.test',
          target_email: 'idle-docker@example.test',
          details: '{}',
        },
      ]);
      const audit = f.database
        .prepare<[string], { source_address: string }>(
          "SELECT source_address FROM audit_events WHERE event_type='instance.restarted' AND target=?",
        )
        .get(f.user.id);
      expect(audit?.source_address).toBe('127.0.0.1');
      const projected = await fetch(`${f.base}/_platform/api/admin/instances`, {
        headers: { cookie: admin.cookie },
      });
      expect(projected.status).toBe(200);
      const projection = record(await projected.json());
      expect(projection.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            userId: f.user.id,
            status: 'running',
            lastStartedAt: ready.last_started_at,
            lastError: null,
          }),
        ]),
      );
      for (const secret of [
        f.user.cookie,
        row.dsh_cookie,
        ready.dsh_cookie,
        'owned-idle-not-provider-key',
      ]) {
        if (typeof secret === 'string')
          expect(
            JSON.stringify({
              receipt,
              projection,
              audit: f.database.prepare('SELECT * FROM audit_events').all(),
            }),
          ).not.toContain(secret);
      }
    } finally {
      gateway.close();
    }
  });
});

it('admin restart recovers stopped and retained-error instances; a second real startup failure publishes a fresh error before recovery', async () => {
  let fault: 'none' | 'sequence' | 'mapping' = 'none';
  await withDockerIdleInstance(
    async (f) => {
      const gateway = instanceGatewayFixture(f);
      try {
        const admin = await registerInstanceUser(
          f.base,
          f.origin,
          'restart-recovery-admin@example.test',
        );
        f.database.prepare("UPDATE users SET role='admin' WHERE id=?").run(admin.id);
        const { sessionId, originalHistory } = await gateway.persistedSession(f);
        await f.service.stop(f.user.id, 'admin');
        expect(await gateway.state(f.user.cookie)).toEqual({
          status: 'stopped',
          reason: 'stopped',
        });
        await restartReady(f, admin.cookie, gateway.ready);
        expect(await gateway.history(f.user.cookie, sessionId)).toEqual(originalHistory);
        const auditsBeforeFault = f.database
          .prepare("SELECT * FROM audit_events WHERE event_type='instance.restarted'")
          .all();
        fault = 'sequence';
        f.setNow(Date.now() + 1000);
        const failedAdmission = await restart(f, admin.cookie, f.user.id);
        expect([
          { userId: f.user.id, status: 'starting', reason: 'starting' },
          { userId: f.user.id, status: 'error', reason: 'error' },
        ]).toContainEqual(failedAdmission);
        await errorState(f);
        const firstError = record(
          f.database.prepare('SELECT * FROM instances WHERE user_id=?').get(f.user.id),
        );
        if (typeof firstError.container_id !== 'string')
          throw new Error('Missing retained error container');
        const firstFailed = inspect(f.lifecycle, firstError.container_id);
        expect(record(firstFailed.State).Running).toBe(false);
        const logs = f.lifecycle.command(
          ['logs', '--tail', '1000', firstError.container_id],
          15000,
        );
        expect(logs.status).toBe(0);
        assertFailedStartupLogs(firstError, logs.stdout + logs.stderr);
        expect(
          f.database
            .prepare("SELECT * FROM audit_events WHERE event_type='instance.restarted'")
            .all(),
        ).toHaveLength(auditsBeforeFault.length + (failedAdmission.status === 'starting' ? 1 : 0));
        fault = 'mapping';
        f.setNow(Date.now() + 1000);
        const secondAdmission = await restart(f, admin.cookie, f.user.id);
        expect([
          { userId: f.user.id, status: 'starting', reason: 'starting' },
          { userId: f.user.id, status: 'error', reason: 'error' },
        ]).toContainEqual(secondAdmission);
        await errorState(f);
        const secondError = record(
          f.database.prepare('SELECT * FROM instances WHERE user_id=?').get(f.user.id),
        );
        if (typeof secondError.container_id !== 'string')
          throw new Error('Missing new retained error identity');
        expect(secondError.container_id).not.toBe(firstError.container_id);
        expect(secondError.last_error).not.toBe(firstError.last_error);
        const newLogs = f.lifecycle.command(
          ['logs', '--tail', '1000', secondError.container_id],
          15000,
        );
        expect(newLogs.status).toBe(0);
        assertFailedStartupLogs(secondError, newLogs.stdout + newLogs.stderr);
        const listed = await fetch(`${f.base}/_platform/api/admin/instances`, {
          headers: { cookie: admin.cookie },
        });
        expect(listed.status).toBe(200);
        expect(record(await listed.json()).items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              userId: f.user.id,
              status: 'error',
              lastError: secondError.last_error,
            }),
          ]),
        );
        expect(
          f.database
            .prepare("SELECT target FROM audit_events WHERE event_type='instance.start-failed'")
            .all(),
        ).toEqual([{ target: f.user.id }, { target: f.user.id }]);
        fault = 'none';
        await restartReady(f, admin.cookie, gateway.ready);
        const recovered = record(
          f.database.prepare('SELECT * FROM instances WHERE user_id=?').get(f.user.id),
        );
        expect(recovered.container_id).not.toBe(secondError.container_id);
        expect(recovered.last_error).toBeNull();
        expect(await gateway.history(f.user.cookie, sessionId)).toEqual(originalHistory);
        f.verifyVolumes();
        const stopped = f.database
          .prepare(
            "SELECT details FROM audit_events WHERE event_type='instance.stopped' AND target=?",
          )
          .all(f.user.id);
        expect(stopped).toEqual(
          Array.from({ length: 4 }, () => ({ details: '{"reason":"admin"}' })),
        );
      } finally {
        gateway.close();
      }
    },
    async (lifecycle, userId, containerId) => {
      if (fault !== 'none')
        await corruptOwnedOverlay(
          lifecycle,
          userId,
          containerId,
          fault === 'sequence'
            ? '- id: webserver\n  config: [\n'
            : '- id: webserver\n  config: {\n',
        );
    },
  );
});

it('bulk real admin HTTP restart selects only captured running instances and preserves stopped, retained error and uncreated targets', async () => {
  let fail = false;
  await withDockerIdleInstance(
    async (f) => {
      const gateway = instanceGatewayFixture(f);
      try {
        const admin = await registerInstanceUser(
          f.base,
          f.origin,
          'bulk-restart-admin@example.test',
        );
        f.database.prepare("UPDATE users SET role='admin' WHERE id=?").run(admin.id);
        const uncreated = await ownedUser(f, 'bulk-uncreated@example.test');
        const stopped = await ownedUser(f, 'bulk-stopped@example.test');
        await gateway.state(stopped.cookie, true);
        await gateway.ready(stopped.cookie);
        await f.service.stop(stopped.id, 'admin');
        const sibling = await ownedUser(f, 'bulk-running-sibling@example.test');
        await gateway.state(sibling.cookie, true);
        await gateway.ready(sibling.cookie);
        // Retain a genuine startup error for the original employee through the single public admin endpoint.
        fail = true;
        f.setNow(Date.now() + 1000);
        await restart(f, admin.cookie, f.user.id);
        await errorState(f);
        fail = false;
        const errorBefore = f.database
          .prepare('SELECT * FROM instances WHERE user_id=?')
          .get(f.user.id);
        const stoppedBefore = f.database
          .prepare('SELECT * FROM instances WHERE user_id=?')
          .get(stopped.id);
        const runningBefore = record(
          f.database.prepare('SELECT * FROM instances WHERE user_id=?').get(sibling.id),
        );
        if (typeof runningBefore.container_id !== 'string')
          throw new Error('Missing selected running container');
        const before = inspect(f.lifecycle, runningBefore.container_id);
        const oldStartedAt = record(before.State).StartedAt;
        f.setNow(Date.now() + 1000);

        expect(await restart(f, admin.cookie)).toEqual({
          items: [{ userId: sibling.id, status: 'starting', reason: 'starting' }],
        });
        await gateway.ready(sibling.cookie);

        const runningAfter = record(
          f.database.prepare('SELECT * FROM instances WHERE user_id=?').get(sibling.id),
        );
        if (typeof runningAfter.container_id !== 'string')
          throw new Error('Missing restarted selected container');
        expect(runningAfter.container_id).not.toBe(runningBefore.container_id);
        expect(record(inspect(f.lifecycle, runningAfter.container_id).State).StartedAt).not.toBe(
          oldStartedAt,
        );
        expect(
          f.database.prepare('SELECT * FROM instances WHERE user_id=?').get(f.user.id),
        ).toEqual(errorBefore);
        expect(
          f.database.prepare('SELECT * FROM instances WHERE user_id=?').get(stopped.id),
        ).toEqual(stoppedBefore);
        expect(
          f.database.prepare('SELECT * FROM instances WHERE user_id=?').get(uncreated.id),
        ).toBeUndefined();
        expect(
          f.database
            .prepare(
              "SELECT details FROM audit_events WHERE event_type='instance.stopped' AND target=?",
            )
            .all(sibling.id),
        ).toEqual([{ details: '{"reason":"admin"}' }]);
        expect(
          f.database
            .prepare(
              "SELECT actor_email,target,details FROM audit_events WHERE event_type='instance.restarted' AND target=?",
            )
            .all(sibling.id),
        ).toEqual([
          { actor_email: 'bulk-restart-admin@example.test', target: sibling.id, details: '{}' },
        ]);
        f.verifyVolumes();
      } finally {
        gateway.close();
      }
    },
    async (lifecycle, userId, containerId) => {
      if (fail) await corruptOwnedOverlay(lifecycle, userId, containerId);
    },
  );
});
