import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { applyMigrations, openDatabase, writeSettings } from '../src/db/index.ts';
import { createDockerClient, createInstanceService } from '../src/orchestrator/index.ts';
import {
  START_CONTAINER,
  startupBarrier,
  startupDaemon,
  startupUnixOwnerFixture,
  startupUnixServer,
} from './container-start-fixture.ts';
import { observeHttp, reader, withUpstream } from './gateway-http-fixture.ts';
import { instanceConfig, registerInstanceUser } from './instance-fixture.ts';

// Promoted from the issue56 diagnostic: synchronize on real Engine/socket/process events.
// Time bounds protect cleanup; neither raw subprocess output nor cookies enter assertions.
async function eventually(
  predicate: () => boolean | Promise<boolean>,
  label: string,
): Promise<void> {
  const until = Date.now() + 5_000;
  while (Date.now() < until) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function closed(socket: Duplex): Promise<void> {
  const result = Promise.withResolvers<undefined>();
  socket.once('close', () => {
    result.resolve(undefined);
  });
  socket.on('error', () => undefined);
  return result.promise;
}

it('direct application close fences established HTTP and WebSocket connections before held lifecycle work settles', async () => {
  const f = await startupUnixOwnerFixture({
    rootPrefix: 'dsh-instance-close-',
    users: {},
    userImage: 'dsh-team-user:local',
    subnetPool: '172.30.0.0/16',
    transport: { upstreamMode: 'published-loopback', platformContainerName: 'dsh-team-platform' },
  });
  const readiness = startupBarrier();
  const config = instanceConfig(f.root, { dockerSocketPath: join(f.root, 'engine.sock') });
  const service = createInstanceService({
    database: f.database,
    config,
    client: createDockerClient(config.dockerSocketPath),
  });
  const app = await buildApp(config, f.database, undefined, undefined, service);
  const clients: Socket[] = [];
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = app.addresses()[0]?.port;
    if (port === undefined) throw new Error('Missing application port');
    const base = `http://127.0.0.1:${String(port)}`;
    const a = await registerInstanceUser(base, config.publicUrl, 'closing-a@example.test');
    const b = await registerInstanceUser(base, config.publicUrl, 'closing-b@example.test');
    writeSettings(f.database, {
      modelBaseUrl: 'http://model.invalid/v1',
      modelApiKey: 'fixture-model-key',
      models: [{ name: 'office-model' }],
      defaultModel: 'office-model',
    });
    let admissions = 0;
    const upstreamClosed: Promise<void>[] = [];
    await withUpstream(
      (incoming, response) => {
        admissions += 1;
        upstreamClosed.push(closed(incoming.socket));
        response.writeHead(200, { 'content-length': '1000000' }).write('prefix');
      },
      async (target, upstream) => {
        upstream.on('upgrade', (_incoming, socket) => {
          admissions += 1;
          upstreamClosed.push(closed(socket));
          // HTTP upgrade sockets are half-open; acknowledge the gateway's FIN.
          socket.once('end', () => {
            socket.end();
          });
          socket.write(
            'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
          );
        });
        f.database
          .prepare(
            "INSERT INTO instances(user_id,status,upstream_host,upstream_port,dsh_cookie,last_started_at) VALUES (?, 'running', '127.0.0.1', ?, ?, 1)",
          )
          .run(b.id, target.port, target.cookie);
        f.hold((method, path) =>
          method === 'GET' && path.includes(`/containers/${START_CONTAINER}/logs?`)
            ? readiness.hold()
            : undefined,
        );
        await service.start(a.id);
        await observeHttp(readiness.reached);
        const clientClosed: Promise<void>[] = [];
        for (const mode of ['http', 'websocket']) {
          const socket = connect(port, '127.0.0.1');
          clients.push(socket);
          clientClosed.push(closed(socket));
          await observeHttp(once(socket, 'connect'));
          const read = reader(socket);
          const upgrade =
            mode === 'websocket'
              ? `Connection: Upgrade\r\nUpgrade: websocket\r\nOrigin: ${config.publicUrl}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n`
              : 'Connection: keep-alive\r\n';
          socket.write(
            `GET /${mode} HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nCookie: ${b.cookie}\r\n${upgrade}\r\n`,
          );
          const header = (await observeHttp(read('\r\n\r\n'))).toString();
          expect(header.startsWith(mode === 'http' ? 'HTTP/1.1 200 ' : 'HTTP/1.1 101 ')).toBe(true);
          if (mode === 'http') expect(await observeHttp(read(6))).toEqual(Buffer.from('prefix'));
        }
        let settled = false;
        const closing = app.close().then(() => {
          settled = true;
        });
        await eventually(async () => {
          try {
            await service.start(a.id);
            return false;
          } catch {
            return true;
          }
        }, 'service admission fence');
        await expect(service.start(b.id)).rejects.toThrow('Instance service unavailable');
        await observeHttp(Promise.all([...clientClosed, ...upstreamClosed]));
        expect(settled).toBe(false);
        expect(f.database.open).toBe(true);
        const fresh = await fetch(`${base}/after-close`, {
          headers: { cookie: b.cookie },
          signal: AbortSignal.timeout(1_000),
        }).then(
          (response) => response.status === 200,
          () => false,
        );
        expect(fresh).toBe(false);
        expect(admissions).toBe(2);
        readiness.release();
        await observeHttp(closing);
        expect(f.database.open).toBe(false);
      },
    );
  } finally {
    readiness.release();
    for (const socket of clients) socket.destroy();
    await app.close();
    await f.close();
  }
  // Leave time for bounded failed-peer observation and real cleanup on a regression.
}, 30_000);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pidAt(path: string): Promise<number | undefined> {
  try {
    const value = Number((await readFile(path, 'utf8')).trim());
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function command(root: string, name: 'dev:bg' | 'dev:stop', env: NodeJS.ProcessEnv) {
  const child = spawn('pnpm', ['--dir', root, 'run', name], {
    cwd: root,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Keep private diagnostic output in the child's logfile, not assertion/error messages.
  child.stdout.resume();
  child.stderr.resume();
  const result = new Promise<number | null>((resolveResult, reject) => {
    child.once('error', reject);
    child.once('close', resolveResult);
  });
  void result.catch(() => undefined);
  return { child, result };
}

async function copyDevRuntime(repository: string, root: string): Promise<void> {
  await mkdir(join(root, 'scripts'));
  for (const file of ['package.json', 'pnpm-workspace.yaml', 'tsconfig.json']) {
    await copyFile(join(repository, file), join(root, file));
  }
  await symlink(join(repository, 'scripts/dev-server.sh'), join(root, 'scripts/dev-server.sh'));
  // Own sources/output so this fixture's dev:bg build cannot clear shared web/dist.
  await cp(join(repository, 'platform/src'), join(root, 'platform/src'), { recursive: true });
  await cp(join(repository, 'platform/web/src'), join(root, 'platform/web/src'), {
    recursive: true,
  });
  await copyFile(join(repository, 'platform/package.json'), join(root, 'platform/package.json'));
  for (const file of ['package.json', 'tsconfig.json', 'vite.config.ts', 'index.html']) {
    await copyFile(join(repository, 'platform/web', file), join(root, 'platform/web', file));
  }
  for (const directory of ['node_modules', 'platform/node_modules', 'platform/web/node_modules']) {
    await symlink(join(repository, directory), join(root, directory), 'dir');
  }
}

it('canonical dev stop retains captured source-main ownership through held work and rejects a concurrent stale-health start', async () => {
  const repository = resolve(import.meta.dirname, '../..');
  const root = await mkdtemp(join(tmpdir(), 'dsh-instance-dev-'));
  const daemon = startupDaemon();
  const readiness = startupBarrier();
  const engine = startupUnixServer(
    (request) =>
      request.path === '/version'
        ? { status: 200, document: { ApiVersion: '1.44' } }
        : daemon.reply(request),
    (method, path) =>
      method === 'GET' && path.includes(`/containers/${START_CONTAINER}/logs?`)
        ? readiness.hold()
        : undefined,
  );
  let mainPid: number | undefined;
  const commands: Promise<number | null>[] = [];
  let environment: NodeJS.ProcessEnv | undefined;
  try {
    await copyDevRuntime(repository, root);
    await writeFile(join(root, 'seccomp.json'), '{"defaultAction":"SCMP_ACT_ERRNO","syscalls":[]}');
    const data = join(root, 'data');
    await mkdir(data);
    const database = openDatabase(join(data, 'platform.db'));
    try {
      applyMigrations(database);
      writeSettings(database, {
        modelBaseUrl: 'http://model.invalid/v1',
        modelApiKey: 'fixture-model-key',
        models: [{ name: 'office-model' }],
        defaultModel: 'office-model',
      });
    } finally {
      database.close();
    }
    const socket = join(root, 'engine.sock');
    engine.listen(socket);
    await observeHttp(once(engine, 'listening'));
    const listener = createServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const address = listener.address();
    if (address === null || typeof address === 'string') throw new Error('Missing test port');
    const port = address.port;
    await new Promise<void>((resolveClose, reject) => {
      listener.close((error) => {
        if (error === undefined) resolveClose();
        else reject(error);
      });
    });
    const base = `http://127.0.0.1:${String(port)}`;
    environment = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? root,
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      PLATFORM_HOST: '127.0.0.1',
      PLATFORM_PORT: String(port),
      PLATFORM_LOG_LEVEL: 'silent',
      PLATFORM_PUBLIC_URL: base,
      PLATFORM_DATA_DIR: data,
      PLATFORM_DOCKER_SOCKET: socket,
      PLATFORM_UPSTREAM_MODE: 'published-loopback',
      PLATFORM_SECCOMP_PROFILE: join(root, 'seccomp.json'),
    };
    const pidfile = join(root, '.run/dev.pid');
    const started = command(root, 'dev:bg', environment);
    commands.push(started.result);
    await eventually(async () => (await pidAt(pidfile)) !== undefined, 'source-main ownership');
    mainPid = await pidAt(pidfile);
    if (mainPid === undefined) throw new Error('Missing main PID');
    expect(await observeHttp(started.result, 10_000)).toBe(0);
    const user = await registerInstanceUser(base, base, 'process-held@example.test');
    const response = await fetch(`${base}/_platform/api/instance/start`, {
      method: 'POST',
      headers: { cookie: user.cookie, origin: base, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    await observeHttp(readiness.reached);
    const stopped = command(root, 'dev:stop', environment);
    commands.push(stopped.result);
    await eventually(async () => {
      const probe = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(200) }).catch(
        () => undefined,
      );
      return probe === undefined;
    }, 'main shutdown listener fence');
    expect((await pidAt(pidfile)) === mainPid).toBe(true);
    expect(stopped.child.exitCode).toBeNull();
    // A repeated SIGTERM must join the same drain, not invoke default termination.
    process.kill(mainPid, 'SIGTERM');
    const restarted = command(root, 'dev:bg', environment);
    commands.push(restarted.result);
    expect(await observeHttp(restarted.result)).toBe(1);
    expect((await pidAt(pidfile)) === mainPid).toBe(true);
    expect(alive(mainPid)).toBe(true);
    readiness.release();
    expect(await observeHttp(stopped.result, 5_000)).toBe(0);
    await eventually(() => mainPid !== undefined && !alive(mainPid), 'graceful main exit');
    expect(await pidAt(pidfile)).toBeUndefined();
    const successor = command(root, 'dev:bg', environment);
    commands.push(successor.result);
    expect(await observeHttp(successor.result, 10_000)).toBe(0);
    const successorPid = await pidAt(pidfile);
    expect(successorPid !== undefined && successorPid !== mainPid).toBe(true);
    mainPid = successorPid;
    const finalStop = command(root, 'dev:stop', environment);
    commands.push(finalStop.result);
    expect(await observeHttp(finalStop.result, 5_000)).toBe(0);
    expect(await pidAt(pidfile)).toBeUndefined();
  } finally {
    readiness.release();
    // Do not interrupt a command that owns the lifecycle lock. Let it observe
    // released work, then stop any captured application before removing its files.
    mainPid ??= await pidAt(join(root, '.run/dev.pid'));
    await observeHttp(Promise.allSettled(commands), 35_000);
    const recordedPid = await pidAt(join(root, '.run/dev.pid'));
    if (recordedPid !== undefined) mainPid = recordedPid;
    if (mainPid !== undefined && alive(mainPid) && environment !== undefined) {
      const cleanup = command(root, 'dev:stop', environment);
      expect(await observeHttp(cleanup.result, 35_000)).toBe(0);
      await eventually(() => mainPid !== undefined && !alive(mainPid), 'cleanup main exit');
    }
    engine.closeAllConnections();
    if (engine.listening)
      await new Promise<void>((resolveClose, reject) => {
        engine.close((error) => {
          if (error === undefined) resolveClose();
          else reject(error);
        });
      });
    await rm(root, { recursive: true, force: true });
  }
  // Two genuine process startups plus graceful-stop cleanup exceed the runner's default deadline.
}, 60_000);
