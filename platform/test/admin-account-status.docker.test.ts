import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { inspectAsync, record } from './container-start-docker-fixture.ts';
import { isAbsentResource } from './docker-command.ts';
import { observeHttp } from './gateway-http-fixture.ts';
import { withDockerIdleInstance } from './instance-idle-docker-fixture.ts';
import { registerInstanceUser } from './instance-fixture.ts';
import { instanceGatewayFixture, orderedMounts } from './instance-gateway-docker-fixture.ts';

it('disable closes both real DSH sessions and physically retires within five seconds; enable preserves conversation, volumes and sibling', async () => {
  await withDockerIdleInstance(async (f) => {
    const { rpc, exec, state, ready, open, close, history, persistedSession } =
      instanceGatewayFixture(f);
    const headers = (cookie: string) => ({
      cookie,
      origin: f.origin,
      'content-type': 'application/json',
    });
    const login = async (email: string, expected: number) => {
      const response = await fetch(`${f.base}/_platform/api/login`, {
        method: 'POST',
        headers: headers(''),
        body: JSON.stringify({ email, password: 'instance-acceptance-password' }),
      });
      expect(response.status).toBe(expected);
      await response.arrayBuffer();
      const cookie = response.headers.get('set-cookie')?.split(';')[0];
      if (expected === 200 && cookie === undefined) throw new Error('Missing renewed login');
      return cookie ?? '';
    };
    try {
      const admin = await registerInstanceUser(f.base, f.origin, 'status-admin@example.test');
      f.database.prepare("UPDATE users SET role='admin' WHERE id=?").run(admin.id);
      const sibling = await registerInstanceUser(f.base, f.origin, 'status-sibling@example.test');
      const ownership = { 'dsh-team.user': sibling.id };
      await f.lifecycle.registerResourceAsync('container', `dsh-team-u-${sibling.id}`, ownership);
      for (const name of [`dsh-team-home-${sibling.id}`, `dsh-team-work-${sibling.id}`])
        await f.lifecycle.registerResourceAsync('volume', name, ownership);
      await state(sibling.cookie, true);
      await ready(sibling.cookie);
      const siblingRow = record(
        f.database.prepare('SELECT * FROM instances WHERE user_id=?').get(sibling.id),
      );
      if (typeof siblingRow.container_id !== 'string') throw new Error('Missing sibling identity');
      const siblingId = siblingRow.container_id;
      const siblingMounts = (await inspectAsync(f.lifecycle, siblingId)).Mounts;
      await exec(
        siblingId,
        "import {writeFileSync} from 'node:fs'; for(const path of ['/data/home/issue69-sibling','/data/work/issue69-sibling'])writeFileSync(path,'sibling unchanged 中文\\n');",
      );
      const siblingConnection = await open(sibling.cookie);
      const secondCookie = await login('idle-docker@example.test', 200);
      const sessions = f.database
        .prepare('SELECT token_hash FROM platform_sessions WHERE user_id=?')
        .all(f.user.id);
      expect(sessions.length).toBeGreaterThanOrEqual(2);
      expect(secondCookie).not.toBe(f.user.cookie);
      const first = await open(f.user.cookie);
      const second = await open(secondCookie);
      expect(f.app.getUserActivity(f.user.id).liveCount).toBe(2);
      const { sessionId, originalHistory } = await persistedSession(f);
      const bytes = Buffer.from([0, 13, 10, 127, 128, 255]);
      await exec(
        f.containerId,
        `import {writeFileSync} from 'node:fs'; for(const path of ['/data/home/issue69-home','/data/work/issue69-work'])writeFileSync(path,Buffer.from('${bytes.toString('base64')}','base64'));`,
      );
      const readBytes = (id: string) =>
        exec(
          id,
          "import {readFileSync} from 'node:fs'; process.stdout.write(JSON.stringify(['/data/home/issue69-home','/data/work/issue69-work'].map(path=>readFileSync(path).toString('base64'))));",
        );
      expect(JSON.parse(await readBytes(f.containerId))).toEqual([
        bytes.toString('base64'),
        bytes.toString('base64'),
      ]);
      const mounts = record(await inspectAsync(f.lifecycle, f.containerId)).Mounts;
      const statusPut = (status: string) =>
        fetch(`${f.base}/_platform/api/admin/users/${f.user.id}/status`, {
          method: 'PUT',
          headers: headers(admin.cookie),
          body: JSON.stringify({ status }),
        });
      expect(first.socket.destroyed).toBe(false);
      expect(second.socket.destroyed).toBe(false);
      const began = performance.now();
      const disabling = statusPut('disabled');
      const physical = (async () => {
        for (;;) {
          await delay(10);
          const result = await f.lifecycle.commandAsync(
            ['container', 'inspect', f.containerId],
            5_000,
          );
          if (isAbsentResource(result, 'container', f.containerId)) return performance.now();
          if (result.status !== 0 || result.error !== undefined)
            throw new Error('Physical stop observation failed');
          const rows: unknown = JSON.parse(result.stdout);
          if (!Array.isArray(rows) || rows.length !== 1)
            throw new Error('Missing exact physical container');
          const container = record(rows[0]);
          expect(container.Id).toBe(f.containerId);
          if (record(container.State).Running === false) return performance.now();
          if (performance.now() - began >= 5_000)
            throw new Error('Physical retirement exceeded five seconds');
        }
      })();
      const [closedFirst, closedSecond, physicallyStopped] = await observeHttp(
        Promise.all([first.closed, second.closed, physical]),
        5_000,
      );
      for (const at of [closedFirst, closedSecond, physicallyStopped]) {
        expect(at).toBeGreaterThanOrEqual(began);
        expect(at - began).toBeLessThanOrEqual(5_000);
      }
      const disabled = await disabling;
      expect(disabled.status).toBe(204);
      expect(await disabled.text()).toBe('');
      expect(
        f.database.prepare('SELECT * FROM platform_sessions WHERE user_id=?').all(f.user.id),
      ).toEqual([]);
      expect(siblingConnection.socket.destroyed).toBe(false);
      expect(record((await inspectAsync(f.lifecycle, siblingId)).State).Running).toBe(true);
      expect(f.database.prepare('SELECT * FROM instances WHERE user_id=?').get(sibling.id)).toEqual(
        siblingRow,
      );
      for (const cookie of [f.user.cookie, secondCookie]) {
        const denied = await fetch(`${f.base}/_platform/api/instance`, { headers: { cookie } });
        expect(denied.status).toBe(401);
        await denied.arrayBuffer();
      }
      await login('idle-docker@example.test', 403);
      const repeated = await statusPut('disabled');
      expect(repeated.status).toBe(204);
      await repeated.arrayBuffer();
      const enabled = await statusPut('active');
      expect(enabled.status).toBe(204);
      await enabled.arrayBuffer();
      const enabledAgain = await statusPut('active');
      expect(enabledAgain.status).toBe(204);
      await enabledAgain.arrayBuffer();
      for (const cookie of [f.user.cookie, secondCookie]) {
        const denied = await fetch(`${f.base}/_platform/api/instance`, { headers: { cookie } });
        expect(denied.status).toBe(401);
        await denied.arrayBuffer();
      }
      const cookie = await login('idle-docker@example.test', 200);
      expect(await state(cookie)).toEqual({ status: 'stopped', reason: 'stopped' });
      await state(cookie, true);
      await ready(cookie);
      const replacement = record(
        f.database.prepare('SELECT container_id FROM instances WHERE user_id=?').get(f.user.id),
      ).container_id;
      if (typeof replacement !== 'string') throw new Error('Missing restored container');
      expect(replacement).not.toBe(f.containerId);
      const newMounts = (await inspectAsync(f.lifecycle, replacement)).Mounts;
      // Bind overlay inode may change; persistent named-volume identities must not.
      expect(orderedMounts(newMounts)).toEqual(orderedMounts(mounts));
      await f.verifyVolumes();
      expect(await history(cookie, sessionId)).toEqual(originalHistory);
      const listed = await rpc(cookie, 'session/list', { _request: {} });
      expect(listed.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sessionId, cwd: '/data/work', running: false }),
        ]),
      );
      expect(JSON.parse(await readBytes(replacement))).toEqual([
        bytes.toString('base64'),
        bytes.toString('base64'),
      ]);
      expect(
        JSON.parse(
          await exec(
            siblingId,
            "import {readFileSync} from 'node:fs'; process.stdout.write(JSON.stringify(['/data/home/issue69-sibling','/data/work/issue69-sibling'].map(path=>readFileSync(path,'utf8'))));",
          ),
        ),
      ).toEqual(['sibling unchanged 中文\n', 'sibling unchanged 中文\n']);
      expect(orderedMounts((await inspectAsync(f.lifecycle, siblingId)).Mounts, false)).toEqual(
        orderedMounts(siblingMounts, false),
      );
      expect(siblingConnection.socket.destroyed).toBe(false);
      expect(
        f.database
          .prepare(
            "SELECT event_type,target,actor_email,target_email,details FROM audit_events WHERE event_type IN ('account.disabled','account.enabled','instance.stopped') ORDER BY id",
          )
          .all(),
      ).toEqual([
        {
          event_type: 'account.disabled',
          target: f.user.id,
          actor_email: 'status-admin@example.test',
          target_email: 'idle-docker@example.test',
          details: '{}',
        },
        {
          event_type: 'instance.stopped',
          target: f.user.id,
          actor_email: null,
          target_email: 'idle-docker@example.test',
          details: '{"reason":"disabled"}',
        },
        {
          event_type: 'account.enabled',
          target: f.user.id,
          actor_email: 'status-admin@example.test',
          target_email: 'idle-docker@example.test',
          details: '{}',
        },
      ]);
    } finally {
      close();
    }
  });
});
