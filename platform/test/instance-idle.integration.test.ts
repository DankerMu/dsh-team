import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { writeSettings } from '../src/db/index.ts';
import { createGatewayConnections } from '../src/gateway/index.ts';
import { createDockerClient, createInstanceService } from '../src/orchestrator/index.ts';
import {
  START_CONTAINER,
  START_IMAGE,
  START_USER,
  startupUnixOwnerFixture,
} from './container-start-fixture.ts';
import { withUpstream } from './gateway-http-fixture.ts';
import { instanceConfig } from './instance-fixture.ts';

function sessionListRpcId(envelope: unknown): string | undefined {
  if (
    typeof envelope !== 'object' ||
    envelope === null ||
    !('type' in envelope) ||
    envelope.type !== 'client-request' ||
    !('rpcId' in envelope) ||
    typeof envelope.rpcId !== 'string' ||
    !('method' in envelope) ||
    envelope.method !== 'session/list' ||
    !('payload' in envelope) ||
    JSON.stringify(envelope.payload) !== '{"args":{"_request":{}}}'
  )
    return undefined;
  return envelope.rpcId;
}

it('starts a fresh known-idle interval before retiring the exact instance with an idle audit and no volume deletion', async () => {
  const f = await startupUnixOwnerFixture({
    rootPrefix: 'dsh-instance-idle-',
    users: { [START_USER]: 'idle-employee@example.test' },
    userImage: 'dsh-team-user:local',
    subnetPool: '172.30.0.0/16',
    transport: { upstreamMode: 'published-loopback', platformContainerName: 'dsh-team-platform' },
  });
  const config = instanceConfig(f.root, { dockerSocketPath: join(f.root, 'engine.sock') });
  const service = createInstanceService({
    database: f.database,
    config,
    client: createDockerClient(config.dockerSocketPath),
  });
  const connections = createGatewayConnections(service.recordActivity);
  // Control the policy clock only: real HTTP/Unix I/O and deadline timers remain live.
  let now = 600_000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  let storedCookie = '';
  const row = () => f.database.prepare('SELECT * FROM instances WHERE user_id = ?').get(START_USER);
  const audits = () =>
    f.database
      .prepare('SELECT event_type, target, target_email, details FROM audit_events ORDER BY id')
      .all();
  const mutations = () =>
    f.daemon.requests
      .filter(({ method }) => method !== 'GET')
      .map(({ method, path, body }) => ({ method, path, body }));
  try {
    await withUpstream(
      (request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          try {
            const envelope: unknown = JSON.parse(Buffer.concat(chunks).toString());
            const rpcId = sessionListRpcId(envelope);
            if (
              request.method !== 'POST' ||
              request.url !== '/api/session/list' ||
              request.headers.host !== config.authority ||
              request.headers.origin !== config.publicUrl ||
              request.headers.cookie !== storedCookie ||
              request.headers['content-type']?.split(';')[0] !== 'application/json' ||
              rpcId === undefined
            ) {
              response.writeHead(400).end();
              return;
            }
            // Pinned rc.2 full unpaginated list, at the external HTTP boundary only.
            response.writeHead(200, { 'content-type': 'application/json' }).end(
              JSON.stringify({
                type: 'server-response',
                rpcId,
                result: { ok: true, value: { items: [] } },
              }),
            );
          } catch {
            // Malformed input is a failed probe, never fabricated idle evidence.
            response.writeHead(400).end();
          }
        });
      },
      async (target) => {
        storedCookie = target.cookie;
        writeSettings(f.database, {
          idleMinutes: 1,
          modelBaseUrl: 'http://model.invalid/v1',
          modelApiKey: 'idle-fixture-not-a-provider-key',
          models: [{ name: 'office-model' }],
          defaultModel: 'office-model',
        });
        f.database
          .prepare(
            `INSERT INTO instances (user_id, status, container_id, image_id, image_tag,
              upstream_host, upstream_port, dsh_cookie, last_started_at, last_activity_at, last_error)
             VALUES (?, 'running', ?, ?, 'dsh-team-user:local', ?, ?, ?, 101, 202, 'historical diagnostic')`,
          )
          .run(START_USER, START_CONTAINER, START_IMAGE, target.host, target.port, target.cookie);
        f.daemon.containers.set(START_CONTAINER, {
          Id: START_CONTAINER,
          Name: `/dsh-team-u-${START_USER}`,
          Image: START_IMAGE,
          Config: { Labels: { 'dsh-team.user': START_USER } },
          State: { Running: true },
          NetworkSettings: { Ports: {} },
        });
        const before = row();

        // Ancient persisted activity cannot establish how long tasks have been idle.
        await service.checkIdle(connections.getUserActivity);
        expect(service.status(START_USER)).toEqual({ status: 'running', reason: null });
        expect(row()).toEqual(before);
        expect(mutations()).toEqual([]);
        expect(audits()).toEqual([]);

        now = 659_999;
        await service.checkIdle(connections.getUserActivity);
        expect(row()).toEqual(before);
        expect(mutations()).toEqual([]);
        expect(audits()).toEqual([]);

        now = 660_000;
        await service.checkIdle(connections.getUserActivity);

        expect(service.status(START_USER)).toEqual({ status: 'stopped', reason: 'stopped' });
        expect(f.daemon.containers.has(START_CONTAINER)).toBe(false);
        // Exact mutation paths exclude force/removal-volume options and all volume APIs.
        // This proves API-level volume protection, not real Docker data persistence.
        expect(mutations()).toEqual([
          { method: 'POST', path: `/containers/${START_CONTAINER}/stop?t=1`, body: {} },
          { method: 'DELETE', path: `/containers/${START_CONTAINER}`, body: {} },
        ]);
        expect(row()).toEqual({
          user_id: START_USER,
          status: 'stopped',
          container_id: null,
          image_id: null,
          image_tag: null,
          upstream_host: null,
          upstream_port: null,
          dsh_cookie: null,
          last_started_at: 101,
          last_activity_at: 202,
          last_error: 'historical diagnostic',
          instance_token_hash: null,
        });
        expect(audits()).toEqual([
          {
            event_type: 'instance.stopped',
            target: START_USER,
            target_email: 'idle-employee@example.test',
            details: '{"reason":"idle"}',
          },
        ]);
      },
    );
  } finally {
    try {
      await connections.close();
      await service.close();
    } finally {
      clock.mockRestore();
      await f.close();
    }
  }
});
