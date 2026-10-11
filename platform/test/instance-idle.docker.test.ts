import { randomUUID } from 'node:crypto';
import { arch, platform } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { writeSettings } from '../src/db/index.ts';
import { inspect, record } from './container-start-docker-fixture.ts';
import { isAbsentResource } from './docker-command.ts';
import {
  activityUpgradeRequest,
  connectActivityPeer,
  observeActivity,
} from './gateway-activity-fixture.ts';
import { sendHttp } from './gateway-http-fixture.ts';
import { withDockerIdleInstance, waitDockerIdle } from './instance-idle-docker-fixture.ts';
import type { DockerIdleContext } from './instance-idle-docker-fixture.ts';

function expectIdleRetirement(f: DockerIdleContext): void {
  expect(f.service.status(f.user.id)).toEqual({ status: 'stopped', reason: 'stopped' });
  expect(
    isAbsentResource(
      f.lifecycle.command(['container', 'inspect', f.containerId], 15_000),
      'container',
      f.containerId,
    ),
  ).toBe(true);
  expect(
    f.database
      .prepare(
        "SELECT event_type,target,target_email,details FROM audit_events WHERE event_type='instance.stopped' ORDER BY id",
      )
      .all(),
  ).toEqual([
    {
      event_type: 'instance.stopped',
      target: f.user.id,
      target_email: 'idle-docker@example.test',
      details: '{"reason":"idle"}',
    },
  ]);
  f.verifyVolumes();
}

it('real DSH without connections or tasks is retired only after a full idle interval with retained home and work volumes', async () => {
  expect(platform()).toBe('linux');
  expect(arch()).toBe('x64');
  await withDockerIdleInstance(async (f) => {
    const items = f.rpc('session/list', { _request: {} }).items;
    if (!Array.isArray(items)) throw new Error('Missing released complete Session list');
    for (const item of items) expect(record(item).running).toBe(false);
    expect(f.app.getUserActivity(f.user.id).liveCount).toBe(0);
    const began = Date.now();
    await f.checkIdle();
    f.setNow(began + 59_999);
    await f.checkIdle();
    expect(record(inspect(f.lifecycle, f.containerId).State).Running).toBe(true);
    f.setNow(began + 60_000);
    await f.checkIdle();
    expectIdleRetirement(f);
  });
});

it('an open authenticated page connection to real DSH prevents retirement beyond the configured idle interval', async () => {
  await withDockerIdleInstance(async (f) => {
    const port = f.app.addresses()[0]?.port;
    if (port === undefined) throw new Error('Missing actual platform listener');
    const peer = await connectActivityPeer(port);
    try {
      peer.socket.write(
        activityUpgradeRequest(port, f.user.cookie, 'http://instance.example').replace(
          '/activity-ws',
          '/api/remote.mux',
        ),
      );
      expect((await peer.read('\r\n\r\n')).toString().startsWith('HTTP/1.1 101 ')).toBe(true);
      expect(f.app.getUserActivity(f.user.id).liveCount).toBe(1);
      const began = Date.now();
      await f.checkIdle();
      f.setNow(began + 5 * 60_000);
      await f.checkIdle();
      expect(record(inspect(f.lifecycle, f.containerId).State).Running).toBe(true);
      expect(
        f.database
          .prepare("SELECT details FROM audit_events WHERE event_type='instance.stopped'")
          .all(),
      ).toEqual([]);
      peer.socket.destroy();
      await peer.closed;
      await observeActivity(() => f.app.getUserActivity(f.user.id).liveCount === 0);
      await f.checkIdle();
      expect(f.service.status(f.user.id)).toEqual({ status: 'running', reason: null });
      f.setNow(began + 6 * 60_000);
      await f.checkIdle();
      expectIdleRetirement(f);
    } finally {
      peer.socket.destroy();
      await peer.closed;
    }
  });
});

it('a real held Agent turn in the same Web instance survives without connections and completion starts a fresh idle interval', async () => {
  await withDockerIdleInstance(async (f) => {
    const created = f.rpc('session/create', {
      request: { cwd: '/data/work', agentPreset: 'standard' },
    });
    if (typeof created.sessionId !== 'string') throw new Error('Missing real Session');
    const sessionId = created.sessionId;
    const nonce = randomUUID();
    f.control({ op: 'adopt', sessionId });
    const running = () => {
      const items = f.rpc('session/list', { _request: {} }).items;
      if (!Array.isArray(items)) throw new Error('Missing released task list');
      const item: unknown = items.find((value: unknown) => record(value).sessionId === sessionId);
      const status = record(item).running;
      if (typeof status !== 'boolean') throw new Error('Missing strict real running state');
      return status;
    };
    await waitDockerIdle(() => !running());
    const began = Date.now();
    await f.checkIdle();
    let released = false;
    try {
      f.control({ op: 'hold', sessionId, nonce });
      await waitDockerIdle(() => running());
      const holds = f.control({ op: 'status' }).holds;
      if (!Array.isArray(holds)) throw new Error('Missing real adapter observations');
      expect(holds.map((value: unknown) => record(value))).toContainEqual({
        nonce,
        sessionId,
        entered: true,
        completed: false,
        aborted: false,
      });
      expect(f.app.getUserActivity(f.user.id).liveCount).toBe(0);
      f.setNow(began + 5 * 60_000);
      await f.checkIdle();
      expect(running()).toBe(true);
      expect(record(inspect(f.lifecycle, f.containerId).State).Running).toBe(true);
      f.control({ op: 'release', nonce });
      released = true;
      await waitDockerIdle(() => !running());
      await f.checkIdle();
      f.setNow(began + 6 * 60_000 - 1);
      await f.checkIdle();
      expect(f.service.status(f.user.id)).toEqual({ status: 'running', reason: null });
      f.setNow(began + 6 * 60_000);
      await f.checkIdle();
      expectIdleRetirement(f);
    } finally {
      if (!released) f.control({ op: 'release', nonce });
    }
  });
});

it('changing idle minutes from thirty to five affects the next real DSH decision without restarting the platform', async () => {
  await withDockerIdleInstance(async (f) => {
    writeSettings(f.database, { idleMinutes: 30 });
    const began = Date.now();
    await f.checkIdle();
    f.setNow(began + 5 * 60_000);
    await f.checkIdle();
    expect(record(inspect(f.lifecycle, f.containerId).State).Running).toBe(true);
    writeSettings(f.database, { idleMinutes: 5 });
    await f.checkIdle();
    expectIdleRetirement(f);
  });
});

it('the same platform session resumes a retired instance with its completed conversation and exact work bytes', async () => {
  await withDockerIdleInstance(async (f) => {
    const cookie = f.user.cookie;
    // Never capture a DSH cookie or backend address: every RPC resolves the current instance.
    const gatewayRpc = async (method: string, args: unknown) => {
      const rpcId = randomUUID();
      const response = await sendHttp(
        f.base,
        {
          path: `/api/${method}`,
          method: 'POST',
          headers: {
            cookie,
            origin: f.origin,
            'content-type': 'application/json',
          },
        },
        JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
      );
      expect(response.status).toBe(200);
      const envelope = record(JSON.parse(response.body.toString('utf8')));
      expect(envelope.type).toBe('server-response');
      expect(envelope.rpcId).toBe(rpcId);
      const result = record(envelope.result);
      expect(result.ok).toBe(true);
      return record(result.value);
    };
    const created = await gatewayRpc('session/create', {
      request: { cwd: '/data/work', agentPreset: 'standard' },
    });
    if (typeof created.sessionId !== 'string') throw new Error('Missing original real Session');
    const sessionId = created.sessionId;
    // Adopt submits a genuine user message to the registered Agent and owned LlmAdapter.
    f.control({ op: 'adopt', sessionId });
    await waitDockerIdle(() => {
      const status = f.control({ op: 'status' });
      if (!Array.isArray(status.audit) || !Array.isArray(status.sessions))
        throw new Error('Missing completed owned Agent observations');
      return (
        status.audit.some((value: unknown) => {
          const event = record(value);
          return (
            event.sessionId === sessionId &&
            event.type === 'turn/end' &&
            record(record(event.data).reason).kind === 'completed'
          );
        }) &&
        status.sessions.some((value: unknown) => {
          const session = record(value);
          return session.sessionId === sessionId && session.status === 'idle';
        })
      );
    });
    const owned = f.control({ op: 'status' });
    expect(owned.externalModelCalls).toBe(0);
    expect(owned.streams).toEqual([
      { sessionId, loopOwned: true, provider: 'issue83-ui-owned', model: 'owned' },
    ]);
    const requireSession = async () => {
      const listed = await gatewayRpc('session/list', { _request: {} });
      if (!Array.isArray(listed.items)) throw new Error('Missing complete Session inventory');
      expect(
        listed.items.map((value: unknown) => {
          const session = record(value);
          return { sessionId: session.sessionId, cwd: session.cwd, running: session.running };
        }),
      ).toEqual([{ sessionId, cwd: '/data/work', running: false }]);
    };
    const readHistory = async () => {
      const projection = await gatewayRpc('session/projections', { request: { sessionId } });
      expect(typeof projection.asOfSeq).toBe('number');
      const page = await gatewayRpc('session/page', {
        request: {
          address: { kind: 'session', sessionId },
          throughSeq: projection.asOfSeq,
          maxMessages: 10,
        },
      });
      if (!Array.isArray(page.records)) throw new Error('Missing complete original history');
      expect(page.hasMore).toBe(false);
      expect(record(record(page.records[0]).event).seq).toBe(0);
      expect(record(record(page.records.at(-1)).event).seq).toBe(projection.asOfSeq);
      return page.records.map((value: unknown) => record(value));
    };
    await requireSession();
    const history = await readHistory();
    const events = history.map((value: unknown) => record(record(value).event));
    const userMessages = events.filter(
      (event) => event.type === 'user/message' && record(record(event.data).source).kind === 'user',
    );
    expect(userMessages).toMatchObject([
      {
        data: {
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'issue83-ui initialize' }],
        },
      },
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
    expect(events.filter((event) => event.type === 'turn/end')).toMatchObject([
      { data: { reason: { kind: 'completed' } } },
    ]);
    const filePath = '/data/work/issue60-resume.bin';
    const bytes = Buffer.concat([
      Buffer.from('task12.5 original work\r\n中文会话保留\t{"rows":[3,1,4]}\n', 'utf8'),
      Buffer.from([0, 127, 128, 255, 10]),
    ]);
    const exec = (containerId: string, script: string) => {
      const result = f.lifecycle.command(
        ['exec', '--user', '1001', containerId, 'node', '--input-type=module', '-e', script],
        15_000,
      );
      expect(result.status).toBe(0);
      expect(result.error).toBeUndefined();
      return result.stdout.trim();
    };
    // This write occurs once, before retirement, outside adapter installation/restart.
    exec(
      f.containerId,
      `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(filePath)},Buffer.from(${JSON.stringify(bytes.toString('base64'))},'base64'),{flag:'wx'});`,
    );
    const readBytes = (containerId: string) =>
      Buffer.from(
        exec(
          containerId,
          `import {readFileSync} from 'node:fs'; process.stdout.write(readFileSync(${JSON.stringify(filePath)}).toString('base64'));`,
        ),
        'base64',
      );
    expect(readBytes(f.containerId)).toEqual(bytes);
    const mountMetadata = (containerId: string) => {
      const mounts = inspect(f.lifecycle, containerId).Mounts;
      if (!Array.isArray(mounts)) throw new Error('Missing owned container mounts');
      return new Map(
        mounts.map((value: unknown) => {
          const mount = record(value);
          if (typeof mount.Destination !== 'string') throw new Error('Missing mount destination');
          return [mount.Destination, mount] as const;
        }),
      );
    };
    const originalMounts = mountMetadata(f.containerId);
    expect(f.app.getUserActivity(f.user.id).liveCount).toBe(0);

    const began = Date.now();
    await f.checkIdle();
    f.setNow(began + 60_000);
    await f.checkIdle();
    expectIdleRetirement(f);
    const waiting = await sendHttp(f.base, {
      path: '/',
      headers: { cookie, accept: 'text/html' },
    });
    expect(waiting.status).toBe(302);
    expect(waiting.headers.location).toBe('/_platform/wait');
    const stopped = await sendHttp(f.base, {
      path: '/_platform/api/instance',
      headers: { cookie },
    });
    expect(stopped.status).toBe(200);
    expect(JSON.parse(stopped.body.toString('utf8'))).toEqual({
      status: 'stopped',
      reason: 'stopped',
    });
    expectIdleRetirement(f);
    const starting = await sendHttp(
      f.base,
      {
        path: '/_platform/api/instance/start',
        method: 'POST',
        headers: {
          cookie,
          origin: f.origin,
          'content-type': 'application/json',
        },
      },
      '{}',
    );
    expect(starting.status).toBe(200);
    expect(JSON.parse(starting.body.toString('utf8'))).toEqual({
      status: 'starting',
      reason: 'starting',
    });
    // Retain the real fixture's independent 90-second authenticated-readiness deadline.
    const ready = AbortSignal.timeout(90_000);
    for (;;) {
      const status = await sendHttp(f.base, {
        path: '/_platform/api/instance',
        headers: { cookie },
        signal: ready,
      });
      expect(status.status).toBe(200);
      const state: unknown = JSON.parse(status.body.toString('utf8'));
      if (record(state).status === 'running') {
        expect(state).toEqual({ status: 'running', reason: null });
        break;
      }
      expect(state).toEqual({ status: 'starting', reason: 'starting' });
      await delay(100, undefined, { signal: ready });
    }

    const row = record(
      f.database.prepare('SELECT container_id FROM instances WHERE user_id=?').get(f.user.id),
    );
    if (typeof row.container_id !== 'string') throw new Error('Missing ready replacement');
    expect(row.container_id).not.toBe(f.containerId);
    const replacement = inspect(f.lifecycle, row.container_id);
    expect(record(replacement.State).Running).toBe(true);
    expect(replacement.Image).toBe(f.lifecycle.imageId);
    expect(mountMetadata(row.container_id)).toEqual(originalMounts);
    f.verifyVolumes();
    const homepage = await sendHttp(f.base, {
      path: '/',
      headers: { cookie, accept: 'text/html' },
    });
    expect(homepage.status).toBe(200);
    expect(homepage.headers['content-type']).toContain('text/html');
    expect(homepage.headers['set-cookie']).toBeUndefined();
    expect(homepage.body.toString('utf8')).toMatch(/<!doctype html/i);
    expect(homepage.body.toString('utf8')).toMatch(/<script[^>]+src=/i);
    await requireSession();
    // Cold projection/page reads do not activate an Agent, so no suffix is justified here.
    expect(await readHistory()).toEqual(history);
    expect(readBytes(row.container_id)).toEqual(bytes);
  });
});
