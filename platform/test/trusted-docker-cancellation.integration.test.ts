import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processBirth, processIdentity } from '../../scripts/probe-browser-native.mjs';
import { writeReceipt } from '../../scripts/probe-browser-receipt.mjs';
import {
  ownedCancellation,
  signalOwnedGroup,
  watchCancellation,
} from '../../scripts/trusted-docker-owner.mjs';

type Listener = (event: string, name: string | Buffer | null) => void;

const INTERVAL_MS = 250;
const RETRY_MS = 1000;
const FAILURE = 'Trusted Docker cancellation signal failed: ';

/** Starts `watchCancellation` on a fake watcher that, like `fs.watch`, is silent once closed. */
function watched(intervalMs: number) {
  let listener: Listener = () => undefined;
  const watcher = Object.assign(new EventEmitter(), {
    close: vi.fn(() => {
      listener = () => undefined;
    }),
  });
  const watch = (_directory: string, next: Listener) => {
    listener = next;
    return watcher;
  };
  const read = vi.fn(() => Promise.resolve());
  const onError = vi.fn();
  const directory = '/private/custody/invocation';
  const close = watchCancellation(directory, read, onError, { watch, intervalMs });
  const emit = (name: string | null) => {
    listener('rename', name);
  };
  return { watcher, read, onError, close, emit };
}

describe('watchCancellation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads cancellation on every interval while the watcher delivers no event', () => {
    const { read, close } = watched(INTERVAL_MS);
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(read).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(4 * INTERVAL_MS);
    expect(read).toHaveBeenCalledTimes(5);
    close();
  });

  it.each([
    ['no file name', null],
    ['the watched directory name', 'invocation'],
    ['a temporary receipt name', 'cancel.json.0b6c.tmp'],
  ])('reads cancellation once per event carrying %s', (_case, name) => {
    const { read, close, emit } = watched(3_600_000);
    emit(name);
    expect(read).toHaveBeenCalledTimes(1);
    emit(name);
    expect(read).toHaveBeenCalledTimes(2);
    close();
  });

  it('reports watcher errors and stops both readers on close', () => {
    const { watcher, read, onError, close, emit } = watched(INTERVAL_MS);
    watcher.emit('error', new Error('watch failed'));
    expect(onError).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(INTERVAL_MS);
    emit(null);
    expect(read).toHaveBeenCalledTimes(2);

    close();
    expect(watcher.close).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5 * INTERVAL_MS);
    emit(null);
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe('ownedCancellation', () => {
  let time = 0;
  const now = () => time;
  const failing = (message: string) => () => Promise.reject(new Error(message));
  const failsOnce = (message: string) =>
    vi
      .fn<() => Promise<boolean>>()
      .mockImplementationOnce(failing(message))
      .mockResolvedValue(true);
  const settle = async (cancellation: ReturnType<typeof ownedCancellation>, kind: string) => {
    cancellation.cancel(kind);
    await cancellation.settled();
  };

  beforeEach(() => {
    time = 0;
  });

  it('retries a thrown attempt after retryMs and keeps one trace, even an unwritable one', async () => {
    const signal = failsOnce('child group identity changed');
    const report = vi.fn(() => {
      throw new Error('owner.log unavailable');
    });
    const cancellation = ownedCancellation(signal, report, { retryMs: RETRY_MS, now });

    await settle(cancellation, 'cancelled');
    time += RETRY_MS;
    await settle(cancellation, 'cancelled');

    expect(signal).toHaveBeenCalledTimes(2);
    expect(cancellation.signalled).toBe(true);
    expect(cancellation.failed).toBe(false);
    expect(report.mock.calls).toEqual([[`${FAILURE}child group identity changed`]]);
  });

  it('keeps retrying a persistent failure and traces only a changed message', async () => {
    const signal = vi.fn(() => {
      time += RETRY_MS / 2;
      return failing('child group identity changed')();
    });
    const report = vi.fn();
    const cancellation = ownedCancellation(signal, report, { retryMs: RETRY_MS, now });

    await settle(cancellation, 'cancelled');
    for (let attempt = 2; attempt <= 4; attempt += 1) {
      time += RETRY_MS - 1; // The throttle counts from when the thrown attempt settled.
      await settle(cancellation, 'cancelled');
      expect(signal).toHaveBeenCalledTimes(attempt - 1);
      time += 1;
      await settle(cancellation, 'cancelled');
      expect(signal).toHaveBeenCalledTimes(attempt);
    }

    expect(report).toHaveBeenCalledTimes(1);
    expect(cancellation.failed).toBe(true);
    expect(cancellation.signalled).toBe(false);

    signal.mockImplementation(failing('child identity changed'));
    time += RETRY_MS;
    await settle(cancellation, 'cancelled');
    expect(report.mock.calls).toEqual([
      [`${FAILURE}child group identity changed`],
      [`${FAILURE}child identity changed`],
    ]);
  });

  it('attempts once for consecutive cancels within retryMs of a thrown attempt', async () => {
    const signal = vi.fn(failing('child group identity changed'));
    const cancellation = ownedCancellation(signal, vi.fn(), { retryMs: RETRY_MS, now });

    cancellation.cancel('cancelled');
    cancellation.cancel('cancelled');
    await settle(cancellation, 'cancelled');
    time += RETRY_MS - 1;
    await settle(cancellation, 'cancelled');

    expect(signal).toHaveBeenCalledTimes(1);
    expect(cancellation.failed).toBe(true);
  });

  it('never signals again once the group signal was sent', async () => {
    const signal = vi.fn(() => Promise.resolve(true));
    const cancellation = ownedCancellation(signal, vi.fn(), { retryMs: RETRY_MS, now });

    await settle(cancellation, 'cancelled');
    time += RETRY_MS;
    await settle(cancellation, 'cancelled');

    expect(signal).toHaveBeenCalledTimes(1);
    expect(cancellation.signalled).toBe(true);
  });

  it('keeps the first interruption and re-drives only a pending one', async () => {
    const opts = { retryMs: RETRY_MS, now };
    const retried = ownedCancellation(failsOnce('child identity changed'), vi.fn(), opts);
    await settle(retried, 'owner-signal');
    time += RETRY_MS;
    retried.retry();
    await retried.settled();
    expect(retried.interruption).toBe('owner-signal');
    expect(retried.signalled).toBe(true);

    const sent = vi.fn(() => Promise.resolve(true));
    const ordered = ownedCancellation(sent, vi.fn(), { now });
    ordered.retry();
    await ordered.settled();
    expect(sent).not.toHaveBeenCalled();
    expect(ordered.interruption).toBe('none');
    await settle(ordered, 'owner-signal');
    await settle(ordered, 'cancelled');
    expect(ordered.interruption).toBe('owner-signal');
  });

  it('neither records nor throttles an attempt that had no group to signal', async () => {
    const signal = vi.fn(() => Promise.resolve(false));
    const report = vi.fn();
    const cancellation = ownedCancellation(signal, report, { retryMs: RETRY_MS, now });

    await settle(cancellation, 'capture-failed');
    await settle(cancellation, 'capture-failed');

    expect(signal).toHaveBeenCalledTimes(2);
    expect(report).not.toHaveBeenCalled();
    expect(cancellation.failed).toBe(false);
    expect(cancellation.signalled).toBe(false);
    expect(cancellation.interruption).toBe('capture-failed');
  });
});

it('signals a live owned child group after cancel.json is published to a silent watcher', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-team-cancellation-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
    detached: true,
    stdio: 'ignore',
  });
  const closed = once(child, 'close');
  let close: () => void = () => undefined;
  let deadline: NodeJS.Timeout | undefined;
  try {
    await once(child, 'spawn');
    if (child.pid === undefined) throw new Error('Missing owned signal fixture');
    const identity = processIdentity({ pid: child.pid, birth: await processBirth(child.pid) });
    const report = vi.fn();
    const cancellation = ownedCancellation(() => signalOwnedGroup(child, identity), report);
    const silent = () => ({ on: vi.fn(), close: vi.fn() });
    const read = () => {
      if (existsSync(join(directory, 'cancel.json'))) cancellation.cancel('cancelled');
      return Promise.resolve();
    };
    close = watchCancellation(directory, read, vi.fn(), { watch: silent, intervalMs: 20 });

    await writeReceipt(join(directory, 'cancel.json'), { version: 1 });
    const expired = new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => {
        reject(new Error('Owned child was not signalled within 3s of cancel.json'));
      }, 3000);
    });

    expect(await Promise.race([closed, expired])).toEqual([null, 'SIGINT']);
    await cancellation.settled();
    expect(cancellation.signalled).toBe(true);
    expect(report).not.toHaveBeenCalled();
  } finally {
    clearTimeout(deadline);
    close();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);
