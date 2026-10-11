import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { connect, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { inspect, record } from './container-start-docker-fixture.ts';
import { isAbsentResource } from './docker-command.ts';
import { observeHttp, reader } from './gateway-http-fixture.ts';
import { withDockerIdleInstance, waitDockerIdle } from './instance-idle-docker-fixture.ts';
import { registerInstanceUser } from './instance-fixture.ts';

it('disable closes both real DSH sessions and physically retires within five seconds; enable preserves conversation, volumes and sibling', async () => {
  await withDockerIdleInstance(async (f) => {
    const sockets: Socket[] = [];
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
    const rpc = async (cookie: string, method: string, args: unknown) => {
      const rpcId = randomUUID();
      const response = await fetch(`${f.base}/api/${method}`, {
        method: 'POST',
        headers: headers(cookie),
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
      });
      expect(response.status).toBe(200);
      const envelope = record(await response.json());
      expect(envelope).toMatchObject({ type: 'server-response', rpcId, result: { ok: true } });
      return record(record(envelope.result).value);
    };
    const exec = (id: string, script: string) => {
      const result = f.lifecycle.command(
        ['exec', '--user', '1001', id, 'node', '--input-type=module', '-e', script],
        15_000,
      );
      if (result.status !== 0 || result.error !== undefined)
        throw new Error('Owned data observation failed');
      return result.stdout.trim();
    };
    const state = async (cookie: string, start = false) => {
      const response = await fetch(`${f.base}/_platform/api/instance${start ? '/start' : ''}`, {
        method: start ? 'POST' : 'GET',
        headers: headers(cookie),
        ...(start ? { body: '{}' } : {}),
      });
      expect(response.status).toBe(200);
      return record(await response.json());
    };
    const ready = async (cookie: string) => {
      const signal = AbortSignal.timeout(90_000);
      for (;;) {
        const observed = await state(cookie);
        if (observed.status === 'running') {
          expect(observed).toEqual({ status: 'running', reason: null });
          return;
        }
        expect(observed).toEqual({ status: 'starting', reason: 'starting' });
        await delay(100, undefined, { signal });
      }
    };
    const open = async (cookie: string) => {
      const url = new URL(f.base);
      const socket = connect(Number(url.port), '127.0.0.1');
      sockets.push(socket);
      socket.on('error', () => undefined);
      const closed = Promise.withResolvers<number>();
      socket.once('close', () => {
        closed.resolve(performance.now());
      });
      await once(socket, 'connect');
      const read = reader(socket);
      socket.write(
        `GET /api/remote.mux HTTP/1.1\r\nHost: ${url.host}\r\nCookie: ${cookie}\r\nOrigin: ${f.origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`,
      );
      expect((await read('\r\n\r\n')).toString()).toMatch(/^HTTP\/1\.1 101 /);
      // These idle real peers must answer released DSH heartbeat pings during restart.
      // No logical mux stream is opened here; idle carriers receive only control frames.
      let frames = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        frames = Buffer.concat([frames, chunk]);
        while (frames.length >= 2) {
          const length = frames.readUInt8(1) & 127;
          if (length > 125) throw new Error('Unexpected non-control frame on idle DSH peer');
          if (frames.length < length + 2) return;
          if ((frames.readUInt8(0) & 15) === 9) {
            const mask = randomBytes(4);
            const pong = Buffer.alloc(length + 6);
            pong[0] = 0x8a;
            pong[1] = 0x80 | length;
            mask.copy(pong, 2);
            for (let i = 0; i < length; i++)
              pong[i + 6] = frames.readUInt8(i + 2) ^ mask.readUInt8(i % 4);
            socket.write(pong);
          }
          frames = frames.subarray(length + 2);
        }
      });
      socket.resume();
      return { socket, closed: closed.promise };
    };
    try {
      const admin = await registerInstanceUser(f.base, f.origin, 'status-admin@example.test');
      f.database.prepare("UPDATE users SET role='admin' WHERE id=?").run(admin.id);
      const sibling = await registerInstanceUser(f.base, f.origin, 'status-sibling@example.test');
      const ownership = { 'dsh-team.user': sibling.id };
      f.lifecycle.registerResource('container', `dsh-team-u-${sibling.id}`, ownership);
      for (const name of [`dsh-team-home-${sibling.id}`, `dsh-team-work-${sibling.id}`])
        f.lifecycle.registerResource('volume', name, ownership);
      await state(sibling.cookie, true);
      await ready(sibling.cookie);
      const siblingRow = record(
        f.database.prepare('SELECT * FROM instances WHERE user_id=?').get(sibling.id),
      );
      if (typeof siblingRow.container_id !== 'string') throw new Error('Missing sibling identity');
      const siblingId = siblingRow.container_id;
      const siblingMounts = inspect(f.lifecycle, siblingId).Mounts;
      exec(
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
      const created = await rpc(f.user.cookie, 'session/create', {
        request: { cwd: '/data/work', agentPreset: 'standard' },
      });
      if (typeof created.sessionId !== 'string') throw new Error('Missing genuine Session');
      const sessionId = created.sessionId;
      f.control({ op: 'adopt', sessionId });
      await waitDockerIdle(() => {
        const status = f.control({ op: 'status' });
        return (
          Array.isArray(status.audit) &&
          status.audit.some((value: unknown) => {
            const event = record(value);
            return (
              event.sessionId === sessionId &&
              event.type === 'turn/end' &&
              record(record(event.data).reason).kind === 'completed'
            );
          })
        );
      });
      expect(f.control({ op: 'status' }).externalModelCalls).toBe(0);
      const history = async (cookie: string): Promise<readonly unknown[]> => {
        const projection = await rpc(cookie, 'session/projections', { request: { sessionId } });
        const page = await rpc(cookie, 'session/page', {
          request: {
            address: { kind: 'session', sessionId },
            throughSeq: projection.asOfSeq,
            maxMessages: 10,
          },
        });
        expect(page.hasMore).toBe(false);
        const records: unknown = page.records;
        if (!Array.isArray(records)) throw new Error('Missing genuine history');
        const historyRecords: readonly unknown[] = records;
        return historyRecords;
      };
      const originalHistory = await history(f.user.cookie);
      const events = originalHistory.map((value: unknown) => record(record(value).event));
      expect(events.filter((event) => event.type === 'user/message')).toMatchObject([
        { data: { role: 'user', content: [{ type: 'text', text: 'issue83-ui initialize' }] } },
      ]);
      expect(events.filter((event) => event.type === 'assistant/message')).toMatchObject([
        {
          data: {
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Owned protocol fixture idle.' }],
            },
          },
        },
      ]);
      const bytes = Buffer.from([0, 13, 10, 127, 128, 255]);
      exec(
        f.containerId,
        `import {writeFileSync} from 'node:fs'; for(const path of ['/data/home/issue69-home','/data/work/issue69-work'])writeFileSync(path,Buffer.from('${bytes.toString('base64')}','base64'));`,
      );
      const readBytes = (id: string) =>
        exec(
          id,
          "import {readFileSync} from 'node:fs'; process.stdout.write(JSON.stringify(['/data/home/issue69-home','/data/work/issue69-work'].map(path=>readFileSync(path).toString('base64'))));",
        );
      expect(JSON.parse(readBytes(f.containerId))).toEqual([
        bytes.toString('base64'),
        bytes.toString('base64'),
      ]);
      const mounts = record(inspect(f.lifecycle, f.containerId)).Mounts;
      const statusPut = (status: string) =>
        fetch(`${f.base}/_platform/api/admin/users/${f.user.id}/status`, {
          method: 'PUT',
          headers: headers(admin.cookie),
          body: JSON.stringify({ status }),
        });
      const began = performance.now();
      const disabling = statusPut('disabled');
      const physical = (async () => {
        for (;;) {
          await delay(10);
          const result = f.lifecycle.command(['container', 'inspect', f.containerId], 5_000);
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
      for (const at of [closedFirst, closedSecond, physicallyStopped])
        expect(at - began).toBeLessThanOrEqual(5_000);
      const disabled = await disabling;
      expect(disabled.status).toBe(204);
      expect(await disabled.text()).toBe('');
      expect(
        f.database.prepare('SELECT * FROM platform_sessions WHERE user_id=?').all(f.user.id),
      ).toEqual([]);
      expect(siblingConnection.socket.destroyed).toBe(false);
      expect(record(inspect(f.lifecycle, siblingId).State).Running).toBe(true);
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
      const newMounts = inspect(f.lifecycle, replacement).Mounts;
      // Bind overlay inode may change; persistent named-volume identities must not.
      const volumes = (value: unknown) => {
        if (!Array.isArray(value)) throw new Error('Missing volume inventory');
        return value
          .map((entry: unknown) => record(entry))
          .filter((entry) => entry.Type === 'volume')
          .sort((a, b) => String(a.Destination).localeCompare(String(b.Destination)));
      };
      expect(volumes(newMounts)).toEqual(volumes(mounts));
      f.verifyVolumes();
      expect(await history(cookie)).toEqual(originalHistory);
      const listed = await rpc(cookie, 'session/list', { _request: {} });
      expect(listed.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sessionId, cwd: '/data/work', running: false }),
        ]),
      );
      expect(JSON.parse(readBytes(replacement))).toEqual([
        bytes.toString('base64'),
        bytes.toString('base64'),
      ]);
      expect(
        JSON.parse(
          exec(
            siblingId,
            "import {readFileSync} from 'node:fs'; process.stdout.write(JSON.stringify(['/data/home/issue69-sibling','/data/work/issue69-sibling'].map(path=>readFileSync(path,'utf8'))));",
          ),
        ),
      ).toEqual(['sibling unchanged 中文\n', 'sibling unchanged 中文\n']);
      expect(inspect(f.lifecycle, siblingId).Mounts).toEqual(siblingMounts);
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
      for (const socket of sockets) socket.destroy();
    }
  });
});
