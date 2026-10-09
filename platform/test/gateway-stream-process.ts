import { registerHooks } from 'node:module';
import type * as App from '../src/app.ts';
import type * as Config from '../src/config.ts';
import type * as Database from '../src/db/index.ts';
import type * as Auth from '../src/auth/index.ts';
import type { StreamMode, StreamSurface } from './gateway-stream-fixture.ts';

type FailureCategory =
  | 'configuration'
  | 'artifact-missing'
  | 'seam-mismatch'
  | 'mutation-missing'
  | 'initialization'
  | 'protocol'
  | 'ipc'
  | 'cleanup';
let phase:
  | 'configuration'
  | 'imports'
  | 'database'
  | 'listen'
  | 'ready'
  | 'measuring'
  | 'complete'
  | 'closing' = 'configuration';
class StreamFailure extends Error {
  readonly category: FailureCategory;
  constructor(category: FailureCategory) {
    super(category);
    this.category = category;
  }
}
function failed(error: unknown): void {
  const category =
    error instanceof StreamFailure
      ? error.category
      : phase === 'imports' &&
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ERR_MODULE_NOT_FOUND'
        ? 'artifact-missing'
        : phase === 'closing'
          ? 'cleanup'
          : 'initialization';
  // Only fixed categories/phases are emitted. Import paths, config, sessions and arbitrary errors stay private.
  process.exitCode = 1;
  // Flush the bounded category record before exiting; exit() alone may discard pipe writes.
  process.stderr.write(`gateway-stream ${category} ${phase}\n`, () => {
    process.exit(1);
  });
}
function send(value: Record<string, unknown>): Promise<void> {
  const pending = Promise.withResolvers<undefined>();
  try {
    if (process.send === undefined) throw new StreamFailure('ipc');
    process.send(value, (error) => {
      if (error !== null) pending.reject(new StreamFailure('ipc'));
      else pending.resolve(undefined);
    });
  } catch {
    pending.reject(new StreamFailure('ipc'));
  }
  return pending.promise;
}
function configuration(input: unknown): {
  port: number;
  cookie: string;
  mode: StreamMode;
  surface: StreamSurface;
} {
  if (typeof input !== 'object' || input === null) throw new StreamFailure('configuration');
  if (
    !('port' in input) ||
    typeof input.port !== 'number' ||
    !Number.isInteger(input.port) ||
    input.port < 1 ||
    input.port > 65535 ||
    !('cookie' in input) ||
    typeof input.cookie !== 'string'
  )
    throw new StreamFailure('configuration');
  if (
    !('mode' in input) ||
    !['stream', 'buffer-upload', 'buffer-download'].includes(String(input.mode)) ||
    !('surface' in input) ||
    !['src', 'dist'].includes(String(input.surface))
  )
    throw new StreamFailure('configuration');
  // The finite mode/surface values were validated above.
  return {
    port: input.port,
    cookie: input.cookie,
    mode: input.mode as StreamMode,
    surface: input.surface as StreamSurface,
  };
}

async function main(): Promise<void> {
  if (process.send === undefined) throw new StreamFailure('ipc');
  const configured = Promise.withResolvers<unknown>();
  const disconnected = () => {
    configured.reject(new StreamFailure('ipc'));
  };
  process.once('disconnect', disconnected);
  process.once('message', configured.resolve);
  const input = configuration(await configured.promise);
  process.removeListener('disconnect', disconnected);
  const { mode, surface } = input;
  const extension = surface === 'src' ? 'ts' : 'js';
  let mutated = false;
  phase = 'imports';
  // Ordinary mode installs no loader hook. Mutations target exactly one unchanged forwarding seam.
  const hook =
    mode === 'stream'
      ? undefined
      : registerHooks({
          load(url, context, nextLoad) {
            const loaded = nextLoad(url, context);
            if (url !== new URL(`../${surface}/gateway/http.${extension}`, import.meta.url).href)
              return loaded;
            const source =
              typeof loaded.source === 'string'
                ? loaded.source
                : new TextDecoder().decode(loaded.source);
            const seam =
              mode === 'buffer-upload'
                ? 'incoming.raw.pipe(outgoing);'
                : 'response.pipe(reply.raw);';
            if (source.split(seam).length !== 2) throw new StreamFailure('seam-mismatch');
            const replacement =
              mode === 'buffer-upload'
                ? "const chunks = []; incoming.raw.on('data', chunk => chunks.push(chunk)); incoming.raw.on('end', () => outgoing.end(Buffer.concat(chunks)));"
                : "const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => reply.raw.end(Buffer.concat(chunks)));";
            mutated = true;
            return { ...loaded, source: source.replace(seam, replacement) };
          },
        });
  // Both source and its generated build expose the same typed public module contracts.
  const { buildApp } = (await import(`../${surface}/app.${extension}`)) as typeof App;
  const { loadConfig } = (await import(`../${surface}/config.${extension}`)) as typeof Config;
  const { openDatabase, applyMigrations } = (await import(
    `../${surface}/db/index.${extension}`
  )) as typeof Database;
  const { createSession } = (await import(`../${surface}/auth/index.${extension}`)) as typeof Auth;
  hook?.deregister();
  if (mutated !== (mode !== 'stream')) throw new StreamFailure('mutation-missing');
  phase = 'database';
  const database = openDatabase(':memory:');
  applyMigrations(database);
  const userId = 'abcdefghijkl';
  database
    .prepare(
      "INSERT INTO users (id, email, password_hash, role, status, created_at) VALUES (?, 'stream@example.com', 'unused-session-fixture', 'employee', 'active', ?)",
    )
    .run(userId, Date.now());
  const token = createSession(database, userId, Date.now());
  const app = await buildApp(
    loadConfig({ PLATFORM_PUBLIC_URL: 'http://127.0.0.1:8080', PLATFORM_LOG_LEVEL: 'silent' }),
    database,
    undefined,
    (id) =>
      id === userId ? { host: '127.0.0.1', port: input.port, cookie: input.cookie } : undefined,
  );
  phase = 'listen';
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  let timer: NodeJS.Timeout | undefined;
  phase = 'ready';
  let baseline = 0;
  let peak = 0;
  let samples = 0;
  const sample = () => {
    peak = Math.max(peak, process.memoryUsage.rss());
    samples += 1;
  };
  async function command(value: unknown): Promise<void> {
    if (value === 'begin' && phase === 'ready') {
      phase = 'measuring';
      baseline = process.memoryUsage.rss();
      peak = baseline;
      samples = 0;
      // Actual resource sampling; kernel maxRSS also captures peaks between ticks.
      timer = setInterval(sample, 10);
      await send({
        kind: 'baseline',
        pid: process.pid,
        baseline,
        highWater: process.resourceUsage().maxRSS * 1024,
      });
    } else if (value === 'end' && phase === 'measuring') {
      phase = 'complete';
      clearInterval(timer);
      sample();
      await send({
        kind: 'measurement',
        pid: process.pid,
        baseline,
        peak,
        highWater: process.resourceUsage().maxRSS * 1024,
        samples,
        mutated,
      });
    } else if (value === 'close' && phase !== 'closing') {
      phase = 'closing';
      clearInterval(timer);
      await app.close();
      process.disconnect();
    } else throw new StreamFailure('protocol');
  }
  let commands = Promise.resolve();
  process.on('message', (value: unknown) => {
    commands = commands
      .then(async () => {
        await command(value);
      })
      .catch((error: unknown) => {
        clearInterval(timer);
        failed(error);
      });
  });
  process.once('disconnect', () => {
    clearInterval(timer);
    if (phase !== 'closing') {
      phase = 'closing';
      void app.close().catch(failed);
    }
  });
  await send({
    kind: 'ready',
    pid: process.pid,
    base,
    cookie: `platform_session=${token}`,
    mutated,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  });
}

void main().catch(failed);
