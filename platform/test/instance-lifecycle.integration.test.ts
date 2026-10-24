import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
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

interface DevLifecycle {
  readonly root: string;
  readonly base: string;
  readonly pidfile: string;
  readonly environment: NodeJS.ProcessEnv;
  mainPid: number | undefined;
  readonly run: (name: 'dev:bg' | 'dev:stop') => ReturnType<typeof command>;
}

async function runDevLifecycle(
  engine: ReturnType<typeof startupUnixServer>,
  release: () => void,
  scenario: (lifecycle: DevLifecycle) => Promise<void>,
  // Commands-settlement bound; only tests of an unconfirmed settlement shorten it.
  settleMs = 35_000,
): Promise<void> {
  const repository = resolve(import.meta.dirname, '../..');
  const root = await mkdtemp(join(tmpdir(), 'dsh-instance-dev-'));
  const pidfile = join(root, '.run/dev.pid');
  const commands: Promise<number | null>[] = [];
  let lifecycle: DevLifecycle | undefined;
  let failure: { readonly error: unknown } | undefined;
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
    const environment: NodeJS.ProcessEnv = {
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
    lifecycle = {
      root,
      base,
      pidfile,
      environment,
      mainPid: undefined,
      run(name) {
        const started = command(root, name, environment);
        commands.push(started.result);
        return started;
      },
    };
    await scenario(lifecycle);
  } catch (error) {
    failure = { error };
  }
  let mainPid = lifecycle?.mainPid;
  const cleanup: Record<string, 'confirmed' | 'failed'> = {};
  const cleanupErrors: unknown[] = [];
  // Each step runs and reports independently, in the original order.
  const step = async (name: string, action: () => unknown) => {
    try {
      await action();
      cleanup[name] = 'confirmed';
    } catch (error) {
      cleanup[name] = 'failed';
      cleanupErrors.push(error);
    }
  };
  await step('readiness', release);
  await step('commands', async () => {
    // Do not interrupt a command that owns the lifecycle lock. Let it observe
    // released work, then stop any captured application before removing its files.
    mainPid ??= await pidAt(pidfile);
    await observeHttp(Promise.allSettled(commands), settleMs);
  });
  await step('main', async () => {
    const recordedPid = await pidAt(pidfile);
    if (recordedPid !== undefined) mainPid = recordedPid;
    if (mainPid !== undefined && alive(mainPid) && lifecycle !== undefined) {
      const cleanup = command(root, 'dev:stop', lifecycle.environment);
      expect(await observeHttp(cleanup.result, 35_000)).toBe(0);
      await eventually(() => mainPid !== undefined && !alive(mainPid), 'cleanup main exit');
    }
  });
  await step('engine', async () => {
    engine.closeAllConnections();
    if (engine.listening)
      await new Promise<void>((resolveClose, reject) => {
        engine.close((error) => {
          if (error === undefined) resolveClose();
          else reject(error);
        });
      });
  });
  await step('root', () => {
    // Unconfirmed retirement keeps pidfile/lock/log for a lock-owning dev-server.sh.
    if (cleanup.commands !== 'confirmed' || cleanup.main !== 'confirmed')
      throw new Error('Private root retained: lifecycle retirement unconfirmed');
    return rm(root, { recursive: true, force: true });
  });
  // Step names and outcomes only: raw cleanup errors can name private root/socket paths.
  const facts = JSON.stringify({ cleanup });
  if (failure !== undefined) {
    // The first scenario failure stays primary: same object, first line and assertion details.
    if (failure.error instanceof Error) {
      failure.error.message += `\n${facts}`;
      throw failure.error;
    }
    throw new Error(`${String(failure.error)}\n${facts}`, { cause: failure.error });
  }
  if (cleanupErrors.length > 0)
    throw new Error(`Lifecycle cleanup failed\n${facts}`, {
      cause: new AggregateError(cleanupErrors),
    });
}

const OWNERSHIP_TIMEOUT = 'Timed out waiting for source-main ownership';

interface OwnershipEvidence {
  readonly lock: number | null;
  readonly webBuild: number | null;
  readonly mainLog: number | null;
  readonly pid: number | null;
  readonly command: {
    readonly state: 'running' | 'closed' | 'error';
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly closedMs: number | null;
  };
  readonly pidfile: 'missing' | 'invalid' | 'valid';
}

/**
 * The initial ownership wait: the original predicate, 5000ms/20ms bound and leading text, plus
 * closed-set first-observed facts on timeout. A PID published then cleared within one poll
 * (mainLog observed, pid null, pidfile missing|invalid, command closed) is covered by this
 * evidence shape only: inducing it would need a script or production change.
 */
async function ownershipEventually(
  lifecycle: DevLifecycle,
  started: ReturnType<typeof command>,
): Promise<void> {
  const spawned = Date.now();
  let settled: OwnershipEvidence['command'] = {
    state: 'running',
    code: null,
    signal: null,
    closedMs: null,
  };
  const settle = (
    state: 'closed' | 'error',
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => {
    if (settled.state === 'running')
      settled = { state, code, signal, closedMs: Date.now() - spawned };
  };
  // Attached in the spawn's own turn, so no close/error event precedes these listeners.
  started.child.once('close', (code, signal) => {
    settle('closed', code, signal);
  });
  started.child.once('error', () => {
    settle('error', null, null);
  });
  const watched = [
    ['lock', '.run/dev.lock'],
    ['webBuild', 'platform/web/dist/index.html'],
    ['mainLog', '.run/dev.log'],
  ] as const;
  const seen: Record<(typeof watched)[number][0], number | null> = {
    lock: null,
    webBuild: null,
    mainLog: null,
  };
  const pidfile = lifecycle.pidfile;
  const until = Date.now() + 5_000;
  while (Date.now() < until) {
    if ((await pidAt(pidfile)) !== undefined) return;
    for (const [fact, path] of watched)
      if (seen[fact] === null && existsSync(join(lifecycle.root, path)))
        seen[fact] = Date.now() - spawned;
    await delay(20);
  }
  const valid = (await pidAt(pidfile)) !== undefined;
  const evidence: OwnershipEvidence = {
    ...seen,
    // A valid PID ends the wait, so the timeout path has never observed one.
    pid: null,
    command: settled,
    pidfile: valid ? 'valid' : existsSync(pidfile) ? 'invalid' : 'missing',
  };
  throw new Error(`Timed out waiting for source-main ownership\n${JSON.stringify(evidence)}`);
}

it('canonical dev stop retains captured source-main ownership through held work and rejects a concurrent stale-health start', async () => {
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
  await runDevLifecycle(engine, readiness.release, async (lifecycle) => {
    const { base, pidfile } = lifecycle;
    const started = lifecycle.run('dev:bg');
    await ownershipEventually(lifecycle, started);
    lifecycle.mainPid = await pidAt(pidfile);
    if (lifecycle.mainPid === undefined) throw new Error('Missing main PID');
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
    const stopped = lifecycle.run('dev:stop');
    await eventually(async () => {
      const probe = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(200) }).catch(
        () => undefined,
      );
      return probe === undefined;
    }, 'main shutdown listener fence');
    expect((await pidAt(pidfile)) === lifecycle.mainPid).toBe(true);
    expect(stopped.child.exitCode).toBeNull();
    // A repeated SIGTERM must join the same drain, not invoke default termination.
    process.kill(lifecycle.mainPid, 'SIGTERM');
    const restarted = lifecycle.run('dev:bg');
    expect(await observeHttp(restarted.result)).toBe(1);
    expect((await pidAt(pidfile)) === lifecycle.mainPid).toBe(true);
    expect(alive(lifecycle.mainPid)).toBe(true);
    readiness.release();
    expect(await observeHttp(stopped.result, 5_000)).toBe(0);
    await eventually(
      () => lifecycle.mainPid !== undefined && !alive(lifecycle.mainPid),
      'graceful main exit',
    );
    expect(await pidAt(pidfile)).toBeUndefined();
    const successor = lifecycle.run('dev:bg');
    expect(await observeHttp(successor.result, 10_000)).toBe(0);
    const successorPid = await pidAt(pidfile);
    expect(successorPid !== undefined && successorPid !== lifecycle.mainPid).toBe(true);
    lifecycle.mainPid = successorPid;
    const finalStop = lifecycle.run('dev:stop');
    expect(await observeHttp(finalStop.result, 5_000)).toBe(0);
    expect(await pidAt(pidfile)).toBeUndefined();
  });
  // Two genuine process startups plus graceful-stop cleanup exceed the runner's default deadline.
}, 60_000);

const RETIRED = {
  readiness: 'confirmed',
  commands: 'confirmed',
  main: 'confirmed',
  engine: 'confirmed',
  root: 'confirmed',
} as const;

/** Runs only the initial start and its ownership wait against a controlled Engine preflight. */
async function inducedOwnershipTimeout(
  engine: ReturnType<typeof startupUnixServer>,
  settleMs?: number,
) {
  let observed: { root: string; environment: NodeJS.ProcessEnv } | undefined;
  let started: ReturnType<typeof command> | undefined;
  let waitedMs = 0;
  let released: { lock: boolean; running: boolean } | undefined;
  const lockOf = (root: string) => existsSync(join(root, '.run/dev.lock'));
  const failure = await runDevLifecycle(
    engine,
    // The controlled preflight has no readiness work to release. This first cleanup step runs
    // before Engine closure; it only records facts, since a throw would become a cleanup failure.
    () => {
      if (observed !== undefined && started !== undefined)
        released = { lock: lockOf(observed.root), running: started.child.exitCode === null };
    },
    async (lifecycle) => {
      observed = { root: lifecycle.root, environment: lifecycle.environment };
      const begun = Date.now();
      started = lifecycle.run('dev:bg');
      try {
        await ownershipEventually(lifecycle, started);
      } finally {
        waitedMs = Date.now() - begun;
      }
    },
    settleMs,
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  if (observed === undefined || started === undefined) throw new Error('Missing induced start');
  // The harness alone decides root removal; the lock is the start command's to release.
  const surfaced = { root: existsSync(observed.root) };
  return { failure, observed, started, waitedMs, released, surfaced };
}

/** The ownership-timeout message: original first line, closed-set evidence and cleanup facts. */
function ownershipTimeout({
  failure,
  observed,
  waitedMs,
}: Awaited<ReturnType<typeof inducedOwnershipTimeout>>) {
  if (!(failure instanceof Error)) throw new Error('Missing ownership timeout');
  const lines = failure.message.split('\n');
  expect(lines).toHaveLength(3);
  expect(lines[0]).toBe(OWNERSHIP_TIMEOUT);
  // Evidence is closed-set: no credential, private path, environment value or output text.
  for (const secret of [
    'fixture-model-key',
    observed.root,
    'Docker HTTP',
    // The numeric port is excluded: it can coincide with a relative millisecond value.
    ...Object.entries(observed.environment).flatMap(([name, value]) =>
      name === 'PLATFORM_PORT' || value === undefined ? [] : [value],
    ),
  ])
    expect(failure.message.includes(secret)).toBe(false);
  // Neither an early command exit nor a held preflight shortens the original bound.
  expect(waitedMs).toBeGreaterThanOrEqual(5_000);
  // The second line is this file's own JSON.stringify of OwnershipEvidence.
  const evidence = JSON.parse(lines[1] ?? '') as OwnershipEvidence;
  return { evidence, cleanup: JSON.parse(lines[2] ?? '') as unknown };
}

/** An ownership timeout under the original settlement bound retires everything it owns. */
async function retiredOwnershipTimeout(engine: ReturnType<typeof startupUnixServer>) {
  const induced = await inducedOwnershipTimeout(engine);
  const { evidence, cleanup } = ownershipTimeout(induced);
  expect(cleanup).toEqual({ cleanup: RETIRED });
  expect(induced.surfaced.root).toBe(false);
  return { evidence, code: await induced.started.result };
}

function heldPreflightEngine() {
  return startupUnixServer(
    () => ({ status: 200, document: { ApiVersion: '1.44' } }),
    // Never released: the start command ends only through its own preflight failure.
    (_method, path) => (path === '/version' ? new Promise<undefined>(() => undefined) : undefined),
  );
}

it('initial ownership timeout retains closed-set evidence while the Engine preflight is held', async () => {
  const { evidence, code } = await retiredOwnershipTimeout(heldPreflightEngine());

  const { lock, webBuild, ...unobserved } = evidence;
  expect([typeof lock, typeof webBuild]).toEqual(['number', 'number']);
  expect(unobserved).toStrictEqual({
    mainLog: null,
    pid: null,
    command: { state: 'running', code: null, signal: null, closedMs: null },
    pidfile: 'missing',
  });
  expect(code).toBe(1);
}, 30_000);

it('initial ownership timeout retains the early command exit when the Engine preflight fails', async () => {
  const engine = startupUnixServer(
    () => ({ status: 500 }),
    () => undefined,
  );

  const { evidence, code } = await retiredOwnershipTimeout(engine);

  const {
    lock,
    webBuild,
    command: { closedMs, ...settled },
    ...unobserved
  } = evidence;
  expect([typeof lock, typeof webBuild, typeof closedMs]).toEqual(['number', 'number', 'number']);
  expect(settled).toStrictEqual({ state: 'closed', code: 1, signal: null });
  expect(unobserved).toStrictEqual({ mainLog: null, pid: null, pidfile: 'missing' });
  // The command closed inside the bound, before the ownership wait gave up.
  expect(closedMs !== null && closedMs < 5_000).toBe(true);
  expect(code).toBe(1);
}, 30_000);

it('unconfirmed command settlement retains the private root and lock for the owning start', async () => {
  const induced = await inducedOwnershipTimeout(heldPreflightEngine(), 1_000);
  const { root } = induced.observed;
  try {
    expect(ownershipTimeout(induced).cleanup).toEqual({
      cleanup: { ...RETIRED, commands: 'failed', root: 'failed' },
    });
    // Recorded before Engine closure, while the held start still owned its lock.
    expect(induced.released).toEqual({ lock: true, running: true });
    expect(induced.surfaced.root).toBe(true);
    // Engine closure fails the held preflight; the start then settles and releases its lock.
    expect(await observeHttp(induced.started.result, 15_000)).toBe(1);
    expect([
      existsSync(join(root, '.run/dev.lock')),
      existsSync(join(root, '.run/dev.pid')),
    ]).toEqual([false, false]);
  } finally {
    // Never remove files a still-running lifecycle command owns.
    await Promise.allSettled([induced.started.result]);
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);

/** A spawn-free lifecycle whose readiness release fails with a message naming the private root. */
async function failedRelease(primary?: Error) {
  let root = '';
  let released: Error | undefined;
  const failure = await runDevLifecycle(
    startupUnixServer(
      () => ({ status: 200 }),
      () => undefined,
    ),
    () => {
      released = new Error(`Release failed under ${root}`);
      throw released;
    },
    (lifecycle) => {
      root = lifecycle.root;
      return primary === undefined ? Promise.resolve() : Promise.reject(primary);
    },
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  if (root === '' || released === undefined) throw new Error('Missing lifecycle release');
  expect(existsSync(root)).toBe(false);
  return { failure, root, released };
}

const RELEASE_FAILED = JSON.stringify({ cleanup: { ...RETIRED, readiness: 'failed' } });

it('a failed cleanup step keeps the first scenario failure primary', async () => {
  const primary = new Error('Scenario failed first');

  const { failure } = await failedRelease(primary);

  expect(failure).toBe(primary);
  expect(primary.message).toBe(`Scenario failed first\n${RELEASE_FAILED}`);
});

it('a cleanup-only failure reports step outcomes and keeps raw errors only as cause', async () => {
  const { failure, root, released } = await failedRelease();

  if (!(failure instanceof Error)) throw new Error('Missing cleanup failure');
  expect(failure.message).toBe(`Lifecycle cleanup failed\n${RELEASE_FAILED}`);
  expect(released.message.includes(root)).toBe(true);
  expect(failure.cause).toBeInstanceOf(AggregateError);
  expect((failure.cause as AggregateError).errors).toStrictEqual([released]);
  expect((failure.cause as AggregateError).errors[0]).toBe(released);
});
