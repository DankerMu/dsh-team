import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { request } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { readSessionCookie } from '../src/auth/index.ts';
import type { GatewayUpstream } from '../src/gateway/index.ts';
import { observeHttp, sendHttp, withUpstream } from './gateway-http-fixture.ts';
import { failureReport, traceTimeline, transferRecorder } from './gateway-stream-trace.ts';
import type { FailurePhase, StreamDirection, TransferRecorder } from './gateway-stream-trace.ts';

export type StreamMode = 'stream' | 'buffer-upload' | 'buffer-download';
export type StreamSurface = 'src' | 'dist';
const STREAM_BYTES = 200 * 1024 * 1024;
export const STREAM_RSS_LIMIT = 167_772_160;
const STARTUP_AMBIGUITY_LIMIT = 50_000_000;
interface Integrity {
  bytes: number;
  sha256: string;
}
interface StreamMeasurement extends Integrity {
  direction: StreamDirection;
  pid: number;
  baseline: number;
  peak: number;
  highWater: number;
  delta: number;
  samples: number;
  mutated: boolean;
}
interface StreamOptions {
  signal?: AbortSignal;
  // May shorten, never extend, the 45s operation budget reserved inside the 60s runner deadline.
  operationTimeoutMs?: number;
  // Credential-free ownership/activity observation for real-process fault probes, not alternate traffic.
  observe?: (event: {
    phase: 'resources' | 'child' | 'upload' | 'download' | 'child-settled' | 'cleaned';
    directory: string;
    file: string;
    child?: ChildProcess;
    port?: number;
  }) => void;
  // Attribution probes only: reject the download pipeline after its response finished, or
  // destroy the upstream's incoming upload after its first chunk.
  fault?: 'download-pipeline' | 'upload-incoming';
}
type Recorders = Partial<Record<StreamDirection, TransferRecorder>>;

interface PayloadState {
  uploaded?: Integrity;
  expectedCookie: string;
  uploadObserved: boolean;
  downloadObserved: boolean;
}
interface PayloadResources {
  state: PayloadState;
  pipelines: Set<Promise<void>>;
  errors: { direction: StreamDirection; error: unknown }[];
  handler: (incoming: IncomingMessage, response: ServerResponse) => void;
  upload: (base: string, cookie: string, recorder: TransferRecorder) => Promise<Integrity>;
  stored: () => Promise<Integrity>;
}

function preserve(primary: unknown, cleanup: unknown[]): unknown {
  if (cleanup.length !== 0)
    return new AggregateError(
      [primary, ...cleanup],
      'Gateway stream operation and cleanup failed',
      {
        cause: primary,
      },
    );
  return primary;
}
function send(child: ChildProcess, value: string | Record<string, unknown>): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<undefined>();
  try {
    child.send(value, (error) => {
      if (error !== null) reject(new Error('Stream IPC send failed'));
      else resolve(undefined);
    });
  } catch {
    reject(new Error('Stream IPC send failed'));
  }
  return promise;
}
function message(
  child: ChildProcess,
  kind: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
  const finish = (error?: Error, value?: Record<string, unknown>) => {
    clearTimeout(timer);
    child.removeListener('message', received);
    child.removeListener('exit', exited);
    child.removeListener('close', exited);
    child.removeListener('disconnect', disconnected);
    child.removeListener('error', failed);
    signal.removeEventListener('abort', aborted);
    if (error !== undefined) reject(error);
    else if (value !== undefined) resolve(value);
  };
  const received = (value: unknown) => {
    if (
      typeof value !== 'object' ||
      value === null ||
      !('kind' in value) ||
      value.kind !== kind ||
      !('pid' in value) ||
      value.pid !== child.pid
    ) {
      finish(new Error('Invalid stream process evidence'));
      return;
    }
    // IPC identity and object shape checked here; individual fields are checked before use.
    finish(undefined, value);
  };
  const exited = () => {
    finish(new Error(`Stream process terminated before ${kind}`));
  };
  const disconnected = () => {
    finish(new Error(`Stream IPC disconnected before ${kind}`));
  };
  const failed = () => {
    finish(new Error(`Stream IPC failed before ${kind}`));
  };
  const aborted = () => {
    finish(new Error(`Stream operation cancelled before ${kind}`));
  };
  // Startup/protocol waits consume the same overall operation budget as traffic.
  const timer = setTimeout(() => {
    finish(new Error(`Stream process deadline before ${kind}`));
  }, 10_000);
  child.once('message', received);
  child.once('exit', exited);
  child.once('close', exited);
  child.once('disconnect', disconnected);
  child.once('error', failed);
  signal.addEventListener('abort', aborted, { once: true });
  if (signal.aborted) aborted();
  else if (!child.connected || child.exitCode !== null || child.signalCode !== null) disconnected();
  return promise;
}
async function exchange(
  child: ChildProcess,
  kind: string,
  value: string | Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const waiting = new AbortController();
  try {
    // Attach rejection handlers to both promises before either send or receive can fail.
    const [received] = await Promise.all([
      message(child, kind, AbortSignal.any([signal, waiting.signal])),
      send(child, value),
    ]);
    return received;
  } finally {
    waiting.abort();
  }
}
function metric(value: unknown): number {
  assert.equal(typeof value, 'number');
  assert.ok(Number.isSafeInteger(value) && Number(value) > 0, 'Invalid RSS measurement');
  return Number(value);
}
function ownStreamChild() {
  const child = fork(fileURLToPath(new URL('./gateway-stream-process.ts', import.meta.url)), [], {
    execArgv: [],
    env: { PATH: dirname(process.execPath) },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const settled = Promise.withResolvers<undefined>();
  const diagnostics: { category: string; phase: string }[] = [];
  const state = {
    closeObserved: false,
    exited: false,
    spawned: false,
    spawnFailed: false,
    // Resource absence is valid only for failure before stdio/IPC acquisition (e.g. EMFILE).
    stderrClosed: !child.stderr,
    ipcDisconnected: !child.connected && !child.channel,
    resourcesSettled: false,
    ipcErrors: 0,
    stderrBytes: 0,
    escalated: false,
    diagnostics,
  };
  let stderr = '';
  const considerSettlement = () => {
    if ((state.exited || state.spawnFailed) && state.stderrClosed && state.ipcDisconnected) {
      state.resourcesSettled = true;
      settled.resolve(undefined);
    }
  };
  // Node24's explicit _disconnect() closes IPC without the EOF branch's maybeClose()
  // increment. Observe each owned resource, never repair counters or synthesize close.
  child.once('spawn', () => {
    state.spawned = true;
  });
  child.once('exit', () => {
    state.exited = true;
    considerSettlement();
  });
  child.once('disconnect', () => {
    state.ipcDisconnected = true;
    considerSettlement();
  });
  child.stderr?.once('close', () => {
    state.stderrClosed = true;
    considerSettlement();
  });
  child.once('close', () => {
    state.closeObserved = true;
  });
  // Lifetime protection also handles failed spawn, which emits error instead of exit.
  child.on('error', () => {
    state.ipcErrors += 1;
    if (
      !state.spawned &&
      (child.pid === undefined || child.pid === 0) &&
      child.exitCode !== null &&
      child.exitCode < 0
    )
      state.spawnFailed = true;
    considerSettlement();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    state.stderrBytes = Math.min(1_000_000, state.stderrBytes + chunk.length);
    // Drain arbitrary output, retaining at most 1KiB; never expose raw stderr or exceptions.
    stderr = (stderr + chunk.toString('utf8')).slice(-1024);
    let newline: number;
    while ((newline = stderr.indexOf('\n')) !== -1) {
      const line = stderr.slice(0, newline);
      stderr = stderr.slice(newline + 1);
      const match =
        /^gateway-stream (configuration|artifact-missing|seam-mismatch|mutation-missing|initialization|protocol|ipc|cleanup) (configuration|imports|database|listen|ready|measuring|complete|closing)$/.exec(
          line,
        );
      if (match?.[1] !== undefined && match[2] !== undefined) {
        state.diagnostics.push({ category: match[1], phase: match[2] });
        if (state.diagnostics.length > 8) state.diagnostics.shift();
      }
    }
  });
  return {
    child,
    state,
    async shutdown(): Promise<unknown[]> {
      const cleanup: unknown[] = [];
      // Teardown never uses the cancelled operation signal; failed send still proceeds to exit/kill.
      if (!state.resourcesSettled && !state.exited && !state.spawnFailed && child.connected) {
        try {
          await observeHttp(send(child, 'close'), 1_000);
        } catch (error) {
          cleanup.push(error);
        }
      }
      try {
        await observeHttp(settled.promise, 2_000);
      } catch {
        if (!state.exited && !state.spawnFailed) {
          state.escalated = true;
          try {
            child.kill('SIGKILL');
          } catch (error) {
            cleanup.push(error);
          }
        }
        try {
          await observeHttp(settled.promise, 3_000);
        } catch (error) {
          cleanup.push(error);
        }
      }
      if (child.exitCode !== 0 || child.signalCode !== null)
        cleanup.push(new Error('Stream child terminated unsuccessfully'));
      return cleanup;
    },
  };
}

async function measured(
  target: GatewayUpstream,
  mode: StreamMode,
  surface: StreamSurface,
  direction: StreamDirection,
  signal: AbortSignal,
  observe: (phase: 'child' | 'child-settled', child: ChildProcess) => void,
  recorder: TransferRecorder,
  work: (base: string, cookie: string) => Promise<Integrity>,
): Promise<StreamMeasurement> {
  signal.throwIfAborted();
  const lifecycle = ownStreamChild();
  const { child, state } = lifecycle;
  child.once('exit', (exitCode, exitSignal) => {
    recorder.exited(exitCode, exitSignal);
  });
  let result: StreamMeasurement | undefined;
  let primary: unknown;
  let failed = false;
  let phase = 'startup';
  try {
    observe('child', child);
    const identity = await exchange(
      child,
      'ready',
      { port: target.port, cookie: target.cookie, mode, surface },
      signal,
    );
    assert.equal(identity.node, process.version);
    assert.equal(identity.platform, process.platform);
    assert.equal(identity.arch, process.arch);
    assert.equal(identity.mutated, mode !== 'stream');
    // No assertion diffs may print authentication-bearing IPC fields.
    assert.ok(
      typeof identity.base === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(identity.base),
      'Invalid stream base',
    );
    assert.ok(
      typeof identity.cookie === 'string' && readSessionCookie(identity.cookie) !== null,
      'Invalid stream session',
    );
    const base = identity.base;
    const cookie = identity.cookie;
    phase = 'warmup';
    assert.equal(
      (await sendHttp(base, { path: '/warmup', headers: { cookie }, signal })).status,
      200,
    );
    phase = 'baseline';
    const before = await exchange(child, 'baseline', 'begin', signal);
    const baseline = metric(before.baseline);
    assert.ok(
      metric(before.highWater) - baseline <= STARTUP_AMBIGUITY_LIMIT,
      'Startup high-water makes the RSS baseline ambiguous',
    );
    phase = direction;
    const integrity = await work(base, cookie);
    phase = 'measurement';
    const after = await exchange(child, 'measurement', 'end', signal);
    assert.equal(after.baseline, baseline);
    assert.equal(after.mutated, mode !== 'stream');
    const peak = metric(after.peak);
    const highWater = metric(after.highWater);
    result = {
      ...integrity,
      direction,
      pid: metric(child.pid),
      baseline,
      peak,
      highWater,
      delta: Math.max(peak, highWater) - baseline,
      samples: metric(after.samples),
      mutated: mode !== 'stream',
    };
  } catch (error) {
    primary = error;
    failed = true;
  }
  const cleanup = await lifecycle.shutdown();
  recorder.trace.child.escalated = state.escalated;
  if (state.resourcesSettled) {
    try {
      observe('child-settled', child);
    } catch (error) {
      cleanup.push(error);
    }
  }
  if (failed || cleanup.length !== 0) {
    const evidence = {
      direction,
      phase,
      pid: child.pid,
      exitCode: child.exitCode,
      signal: child.signalCode,
      ...state,
    };
    const error = new Error(`Gateway stream child failure ${JSON.stringify(evidence)}`, {
      cause: failed ? primary : cleanup.shift(),
    });
    throw preserve(error, cleanup);
  }
  assert.ok(result !== undefined, 'Missing stream measurement');
  return result;
}

async function transfer(
  base: string,
  method: 'POST' | 'GET',
  cookie: string,
  signal: AbortSignal,
  recorder: TransferRecorder,
  source?: Readable,
): Promise<Integrity> {
  signal.throwIfAborted();
  const { client } = recorder.trace;
  const operation = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  const completed = Promise.withResolvers<Integrity>();
  let responseWork: Promise<void> | undefined;
  const closed = Promise.withResolvers<undefined>();
  const call = request(
    new URL('/payload', base),
    {
      method,
      headers: {
        cookie,
        ...(source === undefined ? {} : { 'content-length': String(STREAM_BYTES) }),
      },
      signal: operation,
    },
    (response) => {
      client.status = response.statusCode ?? null;
      recorder.observe('client', 'response', response, ['end', 'close', 'aborted']);
      const hash = createHash('sha256');
      let bytes = 0;
      responseWork = pipeline(
        response,
        new Writable({
          write(chunk: Buffer, _encoding, done) {
            hash.update(chunk);
            bytes += chunk.length;
            client.read += chunk.length;
            done();
          },
        }),
        { signal: operation },
      );
      void responseWork.then(() => {
        if (response.statusCode !== (method === 'POST' ? 201 : 200)) {
          completed.reject(new Error('Large transfer rejected'));
          return;
        }
        completed.resolve({ bytes, sha256: hash.digest('hex') });
      }, completed.reject);
    },
  );
  recorder.observe('client', 'request', call, ['finish', 'close']);
  call.once('socket', (socket) => {
    recorder.observe('client', 'socket', socket, ['finish', 'end', 'close']);
  });
  call.on('error', completed.reject);
  call.once('close', () => {
    closed.resolve(undefined);
  });
  const requestWork =
    source === undefined ? undefined : pipeline(source, call, { signal: operation });
  if (source === undefined) call.end();
  try {
    const [, result] = await Promise.all([requestWork, completed.promise]);
    return result;
  } finally {
    call.destroy();
    source?.destroy();
    await Promise.allSettled([requestWork, responseWork, closed.promise]);
  }
}

function streamOperation(options: StreamOptions) {
  const budget = options.operationTimeoutMs ?? 45_000;
  assert.ok(
    Number.isFinite(budget) && budget > 0 && budget <= 45_000,
    'Invalid stream operation budget',
  );
  const controller = new AbortController();
  const cancelled = () => {
    controller.abort(new Error('Stream operation cancelled'));
  };
  options.signal?.addEventListener('abort', cancelled, { once: true });
  if (options.signal?.aborted === true) cancelled();
  // Leave 15s for captured-child escalation, upstream/file settlement and removal before Vitest's 60s deadline.
  const deadline = setTimeout(() => {
    controller.abort(new Error('Stream operation budget exceeded'));
  }, budget);
  return {
    controller,
    signal: controller.signal,
    dispose() {
      clearTimeout(deadline);
      options.signal?.removeEventListener('abort', cancelled);
      controller.abort(new Error('Stream operation cleanup'));
    },
  };
}

function payloadResources(
  file: string,
  signal: AbortSignal,
  observe: (phase: 'upload' | 'download') => void,
  recorders: Recorders,
  fault: StreamOptions['fault'],
): PayloadResources {
  const producer = createHash('sha256');
  const state: PayloadState = {
    expectedCookie: '',
    uploadObserved: false,
    downloadObserved: false,
  };
  const pipelines = new Set<Promise<void>>();
  const errors: PayloadResources['errors'] = [];
  const track = (work: Promise<void>, direction: StreamDirection) => {
    const settled = work.catch((error: unknown) => {
      if (!signal.aborted) errors.push({ direction, error });
    });
    pipelines.add(settled);
    void settled.then(() => {
      pipelines.delete(settled);
    });
  };
  function* chunks(recorder: TransferRecorder): Generator<Buffer> {
    for (let offset = 0; offset < STREAM_BYTES; offset += 65536) {
      signal.throwIfAborted();
      const chunk = Buffer.alloc(Math.min(65536, STREAM_BYTES - offset), (offset / 65536) % 251);
      chunk.writeUInt32LE(offset, 0);
      producer.update(chunk);
      // Bytes produced into the request stream, ahead of the socket by its buffered chunks.
      recorder.trace.client.written += chunk.length;
      yield chunk;
    }
  }
  function receive(
    incoming: IncomingMessage,
    response: ServerResponse,
    recorder: TransferRecorder,
  ) {
    const hash = createHash('sha256');
    let bytes = 0;
    incoming.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      bytes += chunk.length;
      recorder.trace.upstream.received += chunk.length;
      if (!state.uploadObserved) {
        state.uploadObserved = true;
        observe('upload');
        if (fault === 'upload-incoming') incoming.destroy();
      }
    });
    track(
      pipeline(incoming, createWriteStream(file, { flags: 'wx', signal }), { signal })
        .then(() => {
          state.uploaded = { bytes, sha256: hash.digest('hex') };
          response.writeHead(201).end('stored');
        })
        .catch((error: unknown) => {
          response.destroy();
          throw error;
        }),
      'upload',
    );
  }
  function send(response: ServerResponse, recorder: TransferRecorder) {
    const source = createReadStream(file, { signal });
    source.on('data', (chunk: Buffer | string) => {
      recorder.trace.upstream.sent += chunk.length;
      if (!state.downloadObserved) {
        state.downloadObserved = true;
        observe('download');
      }
    });
    response.writeHead(200, { 'content-length': String(STREAM_BYTES) });
    const work = pipeline(source, response, { signal }).catch((error: unknown) => {
      response.destroy();
      throw error;
    });
    track(
      fault !== 'download-pipeline'
        ? work
        : work.then(() => {
            // The CI signature: one tracked download pipeline rejecting after the response finished.
            const injected = new Error('Injected download pipeline rejection');
            recorder.record('upstream', 'response', 'error', injected);
            throw injected;
          }),
      'download',
    );
  }
  return {
    state,
    pipelines,
    errors,
    handler(incoming: IncomingMessage, response: ServerResponse) {
      if (signal.aborted) {
        incoming.destroy();
        response.destroy();
        return;
      }
      if (incoming.headers.cookie !== state.expectedCookie) {
        response.writeHead(401).end();
        return;
      }
      if (incoming.url === '/warmup') {
        response.end('ready');
        return;
      }
      const recorder = recorders[incoming.method === 'POST' ? 'upload' : 'download'];
      if (incoming.url !== '/payload' || recorder === undefined) {
        response.writeHead(404).end();
        return;
      }
      recorder.observe('upstream', 'request', incoming, ['end', 'close', 'aborted']);
      recorder.observe('upstream', 'response', response, ['finish', 'close']);
      recorder.observe('upstream', 'socket', incoming.socket, ['finish', 'end', 'close']);
      if (incoming.method === 'POST') receive(incoming, response, recorder);
      else send(response, recorder);
    },
    async upload(base: string, cookie: string, recorder: TransferRecorder): Promise<Integrity> {
      const source = Readable.from(chunks(recorder), { objectMode: false });
      await transfer(base, 'POST', cookie, signal, recorder, source);
      signal.throwIfAborted();
      const expected = { bytes: STREAM_BYTES, sha256: producer.digest('hex') };
      assert.deepEqual(state.uploaded, expected);
      assert.equal((await stat(file)).size, STREAM_BYTES);
      signal.throwIfAborted();
      return expected;
    },
    async stored(): Promise<Integrity> {
      const diskHash = createHash('sha256');
      let diskBytes = 0;
      await pipeline(
        createReadStream(file, { signal }),
        new Writable({
          write(chunk: Buffer, _encoding, done) {
            diskHash.update(chunk);
            diskBytes += chunk.length;
            done();
          },
        }),
        { signal },
      );
      const stored = { bytes: diskBytes, sha256: diskHash.digest('hex') };
      assert.deepEqual(stored, state.uploaded);
      return stored;
    },
  };
}

// Temp-dir removal and its observer, after the invocation-owned file pipelines settled.
async function removePayload(
  directory: string | undefined,
  observe: StreamOptions['observe'],
): Promise<unknown[]> {
  const cleanup: unknown[] = [];
  if (directory === undefined) return cleanup;
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    cleanup.push(error);
    return cleanup;
  }
  try {
    observe?.({ phase: 'cleaned', directory, file: join(directory, 'payload.bin') });
  } catch {
    cleanup.push(new Error('Stream cleanup observer failed'));
  }
  return cleanup;
}

export async function runLargeTransfer(
  mode: StreamMode = 'stream',
  surface: StreamSurface = 'src',
  options: StreamOptions = {},
): Promise<StreamMeasurement[]> {
  const timeline = traceTimeline();
  const recorders: Recorders = {};
  let phase: FailurePhase = 'resources';
  // A plain Error: Vitest prints only an AggregateError's members, never its own message.
  const failure = (cause: unknown, at: FailurePhase) =>
    new Error(`Gateway stream failure ${JSON.stringify(failureReport(at, recorders))}`, { cause });
  let operation: ReturnType<typeof streamOperation>;
  try {
    operation = streamOperation(options);
  } catch (error) {
    throw failure(error, phase);
  }
  const { signal, controller } = operation;
  let directory: string | undefined;
  let payload: PayloadResources | undefined;
  let primary: unknown;
  let failed = false;
  const measurements: StreamMeasurement[] = [];
  try {
    signal.throwIfAborted();
    directory = await mkdtemp(join(tmpdir(), 'dsh-team-stream-'));
    const ownedDirectory = directory;
    const file = join(directory, 'payload.bin');
    const observe = (
      phase: 'resources' | 'child' | 'upload' | 'download' | 'child-settled' | 'cleaned',
      child?: ChildProcess,
      port?: number,
    ) => {
      try {
        options.observe?.({
          phase,
          directory: ownedDirectory,
          file,
          ...(child === undefined ? {} : { child }),
          ...(port === undefined ? {} : { port }),
        });
      } catch {
        controller.abort(new Error('Stream ownership observer failed'));
      }
    };
    observe('resources');
    signal.throwIfAborted();
    const ownedPayload = payloadResources(file, signal, observe, recorders, options.fault);
    payload = ownedPayload;
    await withUpstream(
      ownedPayload.handler,
      async (target) => {
        ownedPayload.state.expectedCookie = target.cookie;
        const direction = (
          name: StreamDirection,
          work: (recorder: TransferRecorder, base: string, cookie: string) => Promise<Integrity>,
        ) => {
          phase = name;
          const recorder = transferRecorder(timeline);
          recorders[name] = recorder;
          const directionMode = mode === `buffer-${name}` ? mode : 'stream';
          return measured(
            target,
            directionMode,
            surface,
            name,
            signal,
            (childPhase, child) => {
              observe(childPhase, child, target.port);
            },
            recorder,
            (base, cookie) => work(recorder, base, cookie),
          );
        };
        measurements.push(
          await direction('upload', (recorder, base, cookie) =>
            ownedPayload.upload(base, cookie, recorder),
          ),
        );
        phase = 'stored';
        const stored = await ownedPayload.stored();
        measurements.push(
          await direction('download', async (recorder, base, cookie) => {
            const result = await transfer(base, 'GET', cookie, signal, recorder);
            assert.deepEqual(result, stored);
            return result;
          }),
        );
        phase = 'upstream-cleanup';
      },
      signal,
    );
    signal.throwIfAborted();
  } catch (error) {
    primary = error;
    failed = true;
  } finally {
    operation.dispose();
  }
  // File pipelines are invocation-owned; server closure is not proof their descriptors settled.
  await Promise.allSettled(payload === undefined ? [] : [...payload.pipelines]);
  const pipelineErrors = payload?.errors ?? [];
  const cleanup = [
    ...pipelineErrors.map((entry) => entry.error),
    ...(await removePayload(directory, options.observe)),
  ];
  if (failed) throw failure(preserve(primary, cleanup), phase);
  if (cleanup.length !== 0) {
    const first = pipelineErrors[0];
    throw failure(
      new AggregateError(cleanup, 'Gateway stream cleanup failed'),
      first === undefined ? 'payload-cleanup' : `upstream-pipeline:${first.direction}`,
    );
  }
  return measurements;
}
