import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { applyMigrations, openDatabase, writeSettings } from '../src/db/index.ts';
import type { DatabaseHandle } from '../src/db/index.ts';
import { startupBarrier, startupDaemon, startupUnixServer } from './container-start-fixture.ts';
import type { StartupDaemon } from './container-start-fixture.ts';
import { unusedPort } from './gateway-http-fixture.ts';

const mainPath = fileURLToPath(new URL('../src/main.ts', import.meta.url));

interface StartupContext {
  readonly directory: string;
  readonly socketPath: string;
  readonly daemon: StartupDaemon;
}
interface StartupOptions {
  readonly setup?: (
    context: StartupContext & { readonly database: DatabaseHandle; readonly signal: AbortSignal },
  ) => Promise<void>;
  readonly exercise?: (base: string, signal: AbortSignal) => Promise<void>;
  readonly afterExit?: (
    context: StartupContext & { readonly signal: AbortSignal },
  ) => Promise<void>;
}

export interface StartupObservation {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly health: { readonly status: number; readonly body: unknown } | null;
}

interface StartupExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** Capture the child's complete stderr and close outcome from spawn onward. */
export function watchMainProcess(child: ChildProcess & { readonly stderr: Readable }): {
  readonly closed: Promise<StartupExit>;
  readonly stderr: () => string;
} {
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const closed = new Promise<StartupExit>((resolveClosed, rejectClosed) => {
    child.once('error', rejectClosed);
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      resolveClosed({ code, signal });
    });
  });
  return { closed, stderr: () => stderr };
}

type StartupOutcome = { readonly observation: StartupObservation } | { readonly error: unknown };

const STDERR_TAIL = 8192;

function stderrTail(stderr: string): string {
  const omitted = stderr.length - STDERR_TAIL;
  if (omitted <= 0) return stderr;
  return `[stderr truncated: ${String(omitted)} earlier characters omitted]${stderr.slice(omitted)}`;
}

async function stopMainProcess(
  child: ChildProcess,
  closed: Promise<StartupExit>,
  stderr: () => string,
  outcome: StartupOutcome,
): Promise<void> {
  const requested = child.exitCode === null && child.signalCode === null;
  if (requested) child.kill('SIGTERM');
  const exit = await closed;
  if (requested && (exit.code !== 0 || exit.signal !== null)) {
    // Exit class evidence only: code, signal and stderr together; the cause stays unattributed.
    const observed =
      'observation' in outcome
        ? `health=${String(outcome.observation.health?.status ?? null)} exitCode=${String(outcome.observation.exitCode)}`
        : 'rejected (see cause)';
    throw new Error(
      `Main did not settle through graceful shutdown: code=${String(exit.code)} signal=${String(exit.signal)}; observation: ${observed}; stderr:\n${stderrTail(stderr())}`,
      'error' in outcome ? { cause: outcome.error } : undefined,
    );
  }
}

/** Observe, then stop the main process gracefully; afterStop runs only after a successful stop. */
export async function settleMainProcess(
  child: ChildProcess,
  closed: Promise<StartupExit>,
  stderr: () => string,
  observe: () => Promise<StartupObservation>,
  afterStop?: () => Promise<void>,
): Promise<StartupObservation> {
  // A stop failure must carry, never replace, the observation outcome it follows.
  const outcome: StartupOutcome = await observe().then(
    (observation) => ({ observation }),
    (error: unknown) => ({ error }),
  );
  await stopMainProcess(child, closed, stderr, outcome);
  await afterStop?.();
  if ('error' in outcome) throw outcome.error;
  return outcome.observation;
}

async function observeMainListener(
  child: ChildProcess,
  closed: Promise<StartupExit>,
  base: string,
  stderr: () => string,
  exercise: StartupOptions['exercise'],
): Promise<StartupObservation> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const exit = await closed;
      return { exitCode: exit.code, stderr: stderr(), health: null };
    }
    let response: Response | undefined;
    try {
      response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(200) });
    } catch {
      // Connection refusal/timeouts are expected until the real main listens.
    }
    if (response !== undefined) {
      const body: unknown = await response.json();
      await exercise?.(base, AbortSignal.timeout(2000));
      return {
        exitCode: child.exitCode,
        stderr: stderr(),
        health: { status: response.status, body },
      };
    }
    await delay(20);
  }
  throw new Error(`Startup neither exited nor served health before its deadline: ${stderr()}`);
}

/** The actual source process, with only owned external Engine/HTTP boundaries supplied by tests. */
export async function observeStartup(
  pool: string | undefined,
  maxRunningInstances?: number,
  environment: Readonly<Record<string, string>> = {},
  beforeReconcile?: (healthUrl: string, terminate: () => void) => Promise<void>,
  options: StartupOptions = {},
): Promise<StartupObservation> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-team-subnet-'));
  const daemon = startupDaemon();
  const gate = startupBarrier();
  const engine = startupUnixServer(daemon.reply, (method, path) =>
    beforeReconcile !== undefined && method === 'GET' && path.startsWith('/containers/json')
      ? gate.hold()
      : undefined,
  );
  const socketPath = join(directory, 'engine.sock');
  const context = { directory, socketPath, daemon };
  engine.listen(socketPath);
  await once(engine, 'listening');
  try {
    const database = openDatabase(join(directory, 'platform.db'));
    try {
      applyMigrations(database);
      if (maxRunningInstances !== undefined) writeSettings(database, { maxRunningInstances });
      // Abort admission on deadline, but await the callback's actual owner drainage before closing SQLite.
      await options.setup?.({ ...context, database, signal: AbortSignal.timeout(5000) });
    } finally {
      database.close();
    }
    // All Engine/upstream listeners must already be bound before this port handoff.
    const port = await unusedPort();
    const base = `http://127.0.0.1:${String(port)}`;
    const child = spawn(process.execPath, [mainPath], {
      cwd: directory,
      env: {
        PLATFORM_HOST: '127.0.0.1',
        PLATFORM_PORT: String(port),
        PLATFORM_LOG_LEVEL: 'silent',
        PLATFORM_PUBLIC_URL: base,
        PLATFORM_DATA_DIR: directory,
        PLATFORM_DOCKER_SOCKET: socketPath,
        PLATFORM_UPSTREAM_MODE: 'published-loopback',
        ...(pool === undefined ? {} : { PLATFORM_SUBNET_POOL: pool }),
        ...environment,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
      // A broken startup must not leave a process behind, even if observation fails.
      timeout: 6000,
      killSignal: 'SIGKILL',
    });
    const { closed, stderr } = watchMainProcess(child);
    const observe = async () => {
      if (beforeReconcile !== undefined) {
        await Promise.race([
          gate.reached,
          closed.then(() => {
            throw new Error('Main exited before reconciliation');
          }),
        ]);
        try {
          await beforeReconcile(`${base}/healthz`, () => {
            child.kill('SIGTERM');
          });
          if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null)
            throw new Error('Main exited before held reconciliation settled');
          // Independently observe the process alive while the Engine response is still held.
          process.kill(child.pid, 0);
        } finally {
          gate.release();
        }
      }
      return await observeMainListener(child, closed, base, stderr, options.exercise);
    };
    return await settleMainProcess(child, closed, stderr, observe, async () => {
      await options.afterExit?.({ ...context, signal: AbortSignal.timeout(2000) });
    });
  } finally {
    gate.release();
    engine.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      engine.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
    await rm(directory, { recursive: true, force: true });
  }
}
