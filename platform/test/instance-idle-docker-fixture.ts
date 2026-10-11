import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { expect, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import type { PlatformConfig } from '../src/config.ts';
import { applyMigrations, openDatabase, writeSettings } from '../src/db/index.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import { writeManagedConfig } from '../src/managed-config/index.ts';
import { createInstanceService } from '../src/orchestrator/index.ts';
import type { InstanceService, DockerClient } from '../src/orchestrator/index.ts';
import { inspect, record, startupClient } from './container-start-docker-fixture.ts';
import { instanceConfig, registerInstanceUser } from './instance-fixture.ts';
import { runUserImage } from './user-image-fixture.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

export interface DockerIdleContext {
  lifecycle: UserImageLifecycle;
  database: DatabaseHandle;
  service: InstanceService;
  app: FastifyInstance;
  user: { id: string; cookie: string };
  base: string;
  origin: string;
  containerId: string;
  setNow: (value: number) => void;
  checkIdle: () => Promise<void>;
  rpc: (method: string, args: unknown) => Record<string, unknown>;
  control: (args: unknown) => Record<string, unknown>;
  verifyVolumes: () => void;
}

type IdleDockerCommand = (args: readonly string[], timeout?: number) => string;

export async function waitDockerIdle(predicate: () => boolean): Promise<void> {
  // Real deadline remains independent of the controlled platform Date.now policy clock.
  const signal = AbortSignal.timeout(30_000);
  while (!predicate()) await delay(50, undefined, { signal });
}

async function installOwnedAdapter(
  lifecycle: UserImageLifecycle,
  config: PlatformConfig,
  userId: string,
  source: string,
  command: IdleDockerCommand,
  seedMarkers: boolean,
): Promise<void> {
  for (const volume of [`dsh-team-home-${userId}`, `dsh-team-work-${userId}`])
    expect(
      command(['volume', 'inspect', '--format', '{{ index .Labels "dsh-team.user" }}', volume]),
    ).toBe(userId);
  const helper = `dsh-team-test-${lifecycle.runId}-idle-install`;
  lifecycle.registerContainer(helper);
  // Seed once only: installing the adapter on replacement must never repair lost user data.
  const markers = seedMarkers
    ? "writeFileSync('/data/home/issue59-state.txt','idle state survives\\n'); writeFileSync('/data/work/issue59-work.txt','idle work survives\\n');"
    : '';
  const script = `import {writeFileSync} from 'node:fs'; writeFileSync('/data/home/issue83-ui-owned-protocol.mjs',${JSON.stringify(source)},{mode:0o644}); ${markers}`;
  command([
    'run',
    '--rm',
    '--name',
    helper,
    '--network',
    'none',
    '--user',
    '1001',
    '--label',
    `dsh-team.test-run=${lifecycle.runId}`,
    '--mount',
    `type=volume,src=dsh-team-home-${userId},dst=/data/home`,
    '--mount',
    `type=volume,src=dsh-team-work-${userId},dst=/data/work`,
    lifecycle.imageId,
    'node',
    '--input-type=module',
    '-e',
    script,
  ]);
  const overlay = join(config.managedConfigDir, `${userId}.patch.yml`);
  const rows: unknown = JSON.parse(await readFile(overlay, 'utf8'));
  if (!Array.isArray(rows)) throw new Error('Missing canonical managed overlay');
  // Reuse the existing browser-owned model boundary; production policy rows stay intact.
  rows.push(
    { id: 'llm-pi-ai', disabled: true },
    { id: 'session-title-llm', disabled: true },
    { id: 'otel', disabled: true },
    {
      id: 'agent-default-model',
      config: { provider: 'issue83-ui-owned', model: 'owned' },
    },
    {
      insert: [
        {
          id: 'issue83-ui-owned-protocol',
          name: '/data/home/issue83-ui-owned-protocol.mjs',
        },
      ],
    },
  );
  await writeManagedConfig(config.managedConfigDir, userId, JSON.stringify(rows));
}

function verifyIdleVolumes(
  lifecycle: UserImageLifecycle,
  command: IdleDockerCommand,
  userId: string,
  volumeSnapshot: unknown,
): void {
  expect(
    JSON.parse(
      command(['volume', 'inspect', `dsh-team-home-${userId}`, `dsh-team-work-${userId}`]),
    ),
  ).toEqual(volumeSnapshot);
  for (const volume of [`dsh-team-home-${userId}`, `dsh-team-work-${userId}`])
    expect(
      command(['volume', 'inspect', '--format', '{{ index .Labels "dsh-team.user" }}', volume]),
    ).toBe(userId);
  const helper = `dsh-team-test-${lifecycle.runId}-idle-preservation`;
  lifecycle.registerContainer(helper);
  expect(
    command([
      'run',
      '--rm',
      '--name',
      helper,
      '--network',
      'none',
      '--user',
      '1001',
      '--label',
      `dsh-team.test-run=${lifecycle.runId}`,
      '--mount',
      `type=volume,src=dsh-team-home-${userId},dst=/data/home,readonly`,
      '--mount',
      `type=volume,src=dsh-team-work-${userId},dst=/data/work,readonly`,
      lifecycle.imageId,
      'node',
      '--input-type=module',
      '-e',
      "import {readFileSync} from 'node:fs'; process.stdout.write(JSON.stringify({home:readFileSync('/data/home/issue59-state.txt','utf8'),work:readFileSync('/data/work/issue59-work.txt','utf8')}));",
    ]),
  ).toBe('{"home":"idle state survives\\n","work":"idle work survives\\n"}');
}

/** Same real Web instance owns service readiness, registered adapter, Agent turn and task-list RPC. */
export async function withDockerIdleInstance(
  run: (context: DockerIdleContext) => Promise<void>,
  beforeStart?: (
    lifecycle: UserImageLifecycle,
    userId: string,
    containerId: string,
  ) => Promise<void>,
): Promise<void> {
  await runUserImage(
    'container-start',
    () => undefined,
    undefined,
    async (lifecycle) => {
      const root = dirname(lifecycle.overlayDirectory);
      const database = openDatabase(join(root, 'idle-platform.db'));
      applyMigrations(database);
      const config = instanceConfig(root, {
        userImage: lifecycle.imageId,
        seccompProfilePath: lifecycle.seccomp,
        managedConfigDir: lifecycle.overlayDirectory,
      });
      const source = await readFile(
        new URL('./permission-browser-provider.mjs', import.meta.url),
        'utf8',
      );
      const transport = startupClient(lifecycle);
      let userId = '';
      let adapterInstalled = false;
      const command: IdleDockerCommand = (args, timeout = 30_000): string => {
        const result = lifecycle.command(args, timeout);
        if (result.status !== 0 || result.error !== undefined)
          throw new Error('Owned idle Docker operation failed');
        return result.stdout.trim();
      };
      let createdId: string | undefined;
      const client: DockerClient = {
        ...transport.client,
        async json(method, path, body, signal, maxBytes) {
          if (method === 'POST' && path === `/containers/create?name=dsh-team-u-${userId}`) {
            await installOwnedAdapter(
              lifecycle,
              config,
              userId,
              source,
              command,
              !adapterInstalled,
            );
            adapterInstalled = true;
          }
          if (
            method === 'POST' &&
            createdId !== undefined &&
            path === `/containers/${createdId}/start`
          )
            await beforeStart?.(lifecycle, userId, createdId);
          const result = await transport.client.json(method, path, body, signal, maxBytes);
          if (method === 'POST' && path === `/containers/create?name=dsh-team-u-${userId}`) {
            const id = record(result).Id;
            if (typeof id !== 'string') throw new Error('Missing owned Docker create identity');
            createdId = id;
          }
          return result;
        },
      };
      const service = createInstanceService({ database, config, client });
      // Own app intervals while leaving real Engine/HTTP/body deadlines and subprocesses live.
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      // Pass-through observation only: await the real timer invocation, never replace its result.
      const minutes = vi.spyOn(service, 'checkIdle');
      let app: FastifyInstance | undefined;
      let clock: { mockRestore: () => void } | undefined;
      let containerId = '';
      try {
        app = await buildApp(config, database, undefined, undefined, service);
        await service.reconcile();
        await app.listen({ host: '127.0.0.1', port: 0 });
        const base = `http://127.0.0.1:${String(app.addresses()[0]?.port)}`;
        const user = await registerInstanceUser(base, config.publicUrl, 'idle-docker@example.test');
        userId = user.id;
        for (const name of [`dsh-team-home-${userId}`, `dsh-team-work-${userId}`])
          lifecycle.registerResource('volume', name, { 'dsh-team.user': userId });
        lifecycle.registerResource('container', `dsh-team-u-${userId}`, {
          'dsh-team.user': userId,
        });
        writeSettings(database, {
          idleMinutes: 1,
          modelBaseUrl: 'http://127.0.0.1:9/v1',
          modelApiKey: 'owned-idle-not-provider-key',
          models: [{ name: 'owned' }],
          defaultModel: 'owned',
        });
        const starting = await fetch(`${base}/_platform/api/instance/start`, {
          method: 'POST',
          headers: {
            cookie: user.cookie,
            origin: config.publicUrl,
            'content-type': 'application/json',
          },
          body: '{}',
        });
        expect(starting.status).toBe(200);
        await starting.arrayBuffer();
        // Authenticated DSH readiness is real; retain its independent existing 90-second bound.
        const ready = AbortSignal.timeout(90_000);
        while (service.status(userId).status === 'starting')
          await delay(100, undefined, { signal: ready });
        expect(service.status(userId)).toEqual({ status: 'running', reason: null });
        const row = record(database.prepare('SELECT * FROM instances WHERE user_id=?').get(userId));
        if (typeof row.container_id !== 'string' || typeof row.dsh_cookie !== 'string')
          throw new Error('Missing real ready identity');
        containerId = row.container_id;
        expect(inspect(lifecycle, containerId).Image).toBe(lifecycle.imageId);
        const volumeSnapshot: unknown = JSON.parse(
          command(['volume', 'inspect', `dsh-team-home-${userId}`, `dsh-team-work-${userId}`]),
        );
        // Keep session-expiry units valid while moving only the platform policy clock.
        let now = Date.now();
        clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
        const exec = (script: string) =>
          command(
            ['exec', '--user', '1001', containerId, 'node', '--input-type=module', '-e', script],
            15_000,
          );
        const rpc = (method: string, args: unknown): Record<string, unknown> => {
          const rpcId = randomUUID();
          const body = JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } });
          const script = `import {request} from 'node:http'; const {promise,resolve,reject}=Promise.withResolvers(); const req=request({host:'127.0.0.1',port:3080,path:${JSON.stringify(`/api/${method}`)},method:'POST',headers:{Host:${JSON.stringify(config.authority)},Origin:${JSON.stringify(config.publicUrl)},Cookie:${JSON.stringify(row.dsh_cookie)},'content-type':'application/json'},signal:AbortSignal.timeout(10000),maxHeaderSize:8192},res=>{let text='';res.on('data',chunk=>{text+=chunk;if(text.length>1048576)req.destroy(new Error('limit'));});res.on('error',reject);res.on('end',()=>res.statusCode===200&&res.complete?resolve(text):reject(new Error('http')));});req.on('error',reject);req.end(${JSON.stringify(body)}); const parsed=JSON.parse(await promise);if(parsed.type!=='server-response'||parsed.rpcId!==${JSON.stringify(rpcId)}||parsed.result?.ok!==true)throw new Error('rpc');process.stdout.write(JSON.stringify(parsed.result.value));`;
          return record(JSON.parse(exec(script)));
        };
        const control = (args: unknown): Record<string, unknown> =>
          record(
            JSON.parse(
              exec(
                `const response=await fetch('http://127.0.0.1:3081/control',{method:'POST',headers:{'content-type':'application/json'},body:${JSON.stringify(JSON.stringify(args))},signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error('owned control');process.stdout.write(await response.text());`,
              ),
            ),
          );
        const checkIdle = async () => {
          const before = minutes.mock.results.length;
          await vi.advanceTimersByTimeAsync(60_000);
          const tick = minutes.mock.results[before];
          if (tick?.type !== 'return') throw new Error('Application minute sweep did not run');
          await tick.value;
        };
        await run({
          lifecycle,
          database,
          service,
          app,
          user,
          base,
          containerId,
          origin: config.publicUrl,
          setNow: (value) => {
            now = value;
          },
          checkIdle,
          rpc,
          control,
          verifyVolumes: () => {
            verifyIdleVolumes(lifecycle, command, userId, volumeSnapshot);
          },
        });
        return containerId;
      } finally {
        clock?.mockRestore();
        try {
          if (app !== undefined) await app.close();
          else {
            await service.close();
            database.close();
          }
        } finally {
          minutes.mockRestore();
          vi.useRealTimers();
        }
      }
    },
  );
}
