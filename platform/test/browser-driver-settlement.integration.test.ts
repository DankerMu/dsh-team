import { type ChildProcessByStdio, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  awaitRegisteredDrivers,
  processBirth,
  readReceipt,
  writeReceipt,
} from '../../scripts/probe-browser-runtime.mjs';

type Driver = ChildProcessByStdio<null, Readable, null>;
interface Identity {
  readonly pid: number;
  readonly birth: string;
}

let directory: string;
const drivers: Driver[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-team-driver-settlement-'));
});
afterEach(async () => {
  await Promise.all(
    drivers.splice(0).map(async (driver) => {
      if (driver.exitCode !== null || driver.signalCode !== null) return;
      const exited = once(driver, 'exit');
      driver.kill('SIGKILL');
      await exited;
    }),
  );
  await rm(directory, { recursive: true, force: true });
});

/** Starts a real driver process and resolves its first stdout line once it is running. */
async function startDriver(
  file: string,
  args: string[],
): Promise<{ driver: Driver; line: string }> {
  const driver = spawn(file, args, {
    env: { PATH: process.env.PATH },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  drivers.push(driver);
  const [chunk] = (await once(driver.stdout, 'data')) as [Buffer];
  return { driver, line: chunk.toString().trim() };
}

function node(program: string, ...args: string[]) {
  return startDriver(process.execPath, ['-e', program, ...args]);
}

async function identity(pid: number | undefined): Promise<Identity> {
  if (!pid) throw new Error('Owned driver process missing');
  return { pid, birth: await processBirth(pid) };
}

async function register(driver: Identity, overrides: Record<string, unknown> = {}, prefix = '') {
  const nonce = randomUUID();
  const path = join(directory, `${prefix}${nonce}.launch.json`);
  await writeReceipt(path, {
    version: 1,
    nonce,
    kind: 'docker-isolated-network',
    state: 'running',
    driver,
    receiptFile: join(directory, `${nonce}.receipt.json`),
    ...overrides,
  });
  return path;
}

async function timedWait(limitMs: number) {
  const started = performance.now();
  const result = await awaitRegisteredDrivers(directory, limitMs);
  return { ...result, elapsed: performance.now() - started };
}

/** Independent of the helper's observer: '' once the pid is gone, `Z…` while it is a zombie. */
function processState(pid: number): string {
  return spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
}

const LIVE = 'process.stdout.write("ready\\n");setInterval(()=>{},1000)';

it('returns once a registered driver exits', async () => {
  const { driver } = await node('process.stdout.write("ready\\n");setTimeout(()=>{},600)');
  const live = await identity(driver.pid);
  await register(live);

  const { settled, elapsed } = await timedWait(10_000);

  expect(settled).toBe(true);
  expect(elapsed).toBeGreaterThanOrEqual(400);
  expect(elapsed).toBeLessThan(5_000);
  expect(processState(live.pid)).toMatch(/^(Z.*)?$/);
}, 20_000);

it('returns once the driver records its pointer stopped while it is still alive', async () => {
  const nonce = randomUUID();
  const path = join(directory, `${nonce}.launch.json`);
  // The driver itself rewrites its registration, as `recordStoppedReceipt` does after chrome.stop().
  const { driver } = await node(
    `const fs = require('node:fs');
process.stdout.write('ready\\n');
setInterval(() => {}, 1000);
setTimeout(() => {
  const path = process.argv[1];
  const pointer = JSON.parse(fs.readFileSync(path, 'utf8'));
  fs.writeFileSync(path + '.pending', JSON.stringify({ ...pointer, state: 'stopped' }), { mode: 0o600 });
  fs.renameSync(path + '.pending', path);
}, 500);`,
    path,
  );
  const live = await identity(driver.pid);
  await writeReceipt(path, {
    version: 1,
    nonce,
    kind: 'docker-isolated-network',
    state: 'running',
    driver: live,
    receiptFile: join(directory, `${nonce}.receipt.json`),
  });

  const { settled, elapsed } = await timedWait(10_000);

  expect(settled).toBe(true);
  expect(elapsed).toBeGreaterThanOrEqual(300);
  expect(elapsed).toBeLessThan(5_000);
  expect((await readReceipt(path)).state).toBe('stopped');
  expect(processState(live.pid)).toMatch(/^[^Z]/);
}, 20_000);

it('reports a driver that never settles at the limit', async () => {
  const { driver } = await node(LIVE);
  const live = await identity(driver.pid);
  await register(live);

  const { settled, elapsed } = await timedWait(800);

  expect(settled).toBe(false);
  expect(elapsed).toBeGreaterThanOrEqual(800);
  expect(elapsed).toBeLessThan(4_000);
  expect(processState(live.pid)).toMatch(/^[^Z]/);
}, 20_000);

function otherBirth(birth: string): string {
  const fields = birth.split(':');
  const last = Number(fields.at(-1));
  return [...fields.slice(0, -1), String(last === 0 ? 1 : last - 1)].join(':');
}

it.each([
  [
    'a birth mismatch',
    async (live: Identity) => register({ ...live, birth: otherBirth(live.birth) }),
  ],
  ['the waiting process itself', async () => register(await identity(process.pid))],
  ['a non-isolated registration', async (live: Identity) => register(live, { kind: 'native' })],
  ['a stopped registration', async (live: Identity) => register(live, { state: 'stopped' })],
  [
    'an unregistered receipt',
    async (live: Identity) => {
      const nonce = randomUUID();
      const path = join(directory, `${nonce}.receipt.json`);
      await writeReceipt(path, {
        version: 1,
        nonce,
        kind: 'docker-isolated-network',
        driver: live,
      });
      return path;
    },
  ],
])(
  'returns immediately for %s',
  async (_case, setup) => {
    const { driver } = await node(LIVE);
    const live = await identity(driver.pid);
    // A valid pointer proves the case, not a read failure, decides the result.
    await readReceipt(await setup(live));

    const { settled, elapsed } = await timedWait(10_000);

    expect(settled).toBe(true);
    expect(elapsed).toBeLessThan(2_000);
    expect(processState(live.pid)).toMatch(/^[^Z]/);
  },
  20_000,
);

it('leaves malformed registrations and unobservable drivers to rescue without waiting', async () => {
  const { driver } = await node(LIVE);
  const live = await identity(driver.pid);
  await writeFile(join(directory, `${randomUUID()}.launch.json`), '{', { mode: 0o600 });
  // `liveProcessBirth` rejects pid 0, so rescue, not this wait, must decide the registration.
  await readReceipt(await register({ pid: 0, birth: live.birth }));

  const { settled, elapsed } = await timedWait(10_000);

  expect(settled).toBe(true);
  expect(elapsed).toBeLessThan(2_000);
}, 20_000);

it('keeps waiting for a live driver listed among malformed and unobservable registrations', async () => {
  const { driver } = await node(LIVE);
  const live = await identity(driver.pid);
  const liveName = basename(await register(live, {}, 'm-'));
  // readdir order is filesystem-defined, so add bad pointers until each kind lies on both sides.
  const kinds = new Map<string, string>();
  const surrounds = (names: string[], kind: string) => {
    const at = names.indexOf(liveName);
    const sides = names.map((name, index) =>
      kinds.get(name) === kind ? Math.sign(index - at) : 0,
    );
    return sides.includes(-1) && sides.includes(1);
  };
  for (let attempt = 0; ; attempt += 1) {
    const names = await readdir(directory);
    if (surrounds(names, 'malformed') && surrounds(names, 'unobservable')) break;
    if (attempt > 50) throw new Error('Owned registrations never surrounded the live driver');
    const prefix = attempt % 2 === 0 ? 'a-' : 'z-';
    const malformed = `${prefix}${randomUUID()}.launch.json`;
    await writeFile(join(directory, malformed), '{', { mode: 0o600 });
    kinds.set(malformed, 'malformed');
    // A readable pointer, so `liveProcessBirth(0)` rather than parsing rejects it.
    const unobservable = await register({ pid: 0, birth: live.birth }, {}, prefix);
    await readReceipt(unobservable);
    kinds.set(basename(unobservable), 'unobservable');
  }

  const { settled, elapsed } = await timedWait(800);

  expect(settled).toBe(false);
  expect(elapsed).toBeGreaterThanOrEqual(800);
  expect(elapsed).toBeLessThan(4_000);
  expect(processState(live.pid)).toMatch(/^[^Z]/);
}, 20_000);

it('returns immediately for a zombie driver whose parent never reaps it', async () => {
  // `exec sleep` replaces the shell, so nothing waits for the background child.
  const { line } = await startDriver('sh', ['-c', 'sleep 1 & echo $!; exec sleep 30']);
  const zombie = await identity(Number(line));
  await register(zombie);
  for (let attempt = 0; !/^(Z.*)?$/.test(processState(zombie.pid)); attempt += 1) {
    if (attempt > 100) throw new Error('Owned zombie driver never exited');
    await delay(50);
  }

  const { settled, elapsed } = await timedWait(10_000);

  expect(settled).toBe(true);
  expect(elapsed).toBeLessThan(2_000);
}, 20_000);
