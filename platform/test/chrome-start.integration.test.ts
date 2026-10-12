import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { startChrome } from '../../scripts/probe-dsh-api-cdp.mjs';
import { rescueChrome } from '../../scripts/probe-browser-runtime.mjs';

const SECRET = 'sk-chrome-discovery-secret';

const receiptWriteFault: {
  path: string | undefined;
  ackPidFile: string | undefined;
  ackPortFile: string | undefined;
  capturedPid: number | undefined;
  capturedPort: number | undefined;
  capturedReceipt: string | undefined;
} = {
  path: undefined,
  ackPidFile: undefined,
  ackPortFile: undefined,
  capturedPid: undefined,
  capturedPort: undefined,
  capturedReceipt: undefined,
};

async function portListening(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port <= 0) return false;
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = createConnection({ host: '127.0.0.1', port });
  socket.once('connect', () => {
    socket.destroy();
    resolve(true);
  });
  socket.once('error', () => {
    resolve(false);
  });
  return promise;
}

async function failAcknowledgedReceipt(spawnedPid: number): Promise<never> {
  const deadline = Date.now() + 5_000;
  const { ackPidFile, ackPortFile } = receiptWriteFault;
  if (ackPidFile === undefined || ackPortFile === undefined)
    throw new Error('pid write fault missing child acknowledgement paths');
  while (Date.now() < deadline) {
    try {
      const childPid = Number(readFileSync(ackPidFile, 'utf8').trim());
      const childPort = Number(readFileSync(ackPortFile, 'utf8').trim());
      if (childPid === spawnedPid && (await portListening(childPort))) {
        receiptWriteFault.capturedPort = childPort;
        throw Object.assign(new Error('ENOENT: pid write fault'), { code: 'ENOENT' });
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'ENOENT: pid write fault') throw error;
    }
    await delay(10);
  }
  throw new Error('child pid/listener did not acknowledge before pid write');
}

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    async writeFile(
      path: Parameters<typeof actual.writeFile>[0],
      data: Parameters<typeof actual.writeFile>[1],
      options?: Parameters<typeof actual.writeFile>[2],
    ) {
      if (
        receiptWriteFault.path === undefined ||
        typeof path !== 'string' ||
        !path.startsWith(receiptWriteFault.path)
      ) {
        return actual.writeFile(path, data, options);
      }
      if (typeof data !== 'string') {
        throw new Error('expected serialized lifecycle receipt at write boundary');
      }
      const receipt = JSON.parse(data) as { native?: { pid: number } | null };
      const spawnedPid = receipt.native?.pid;
      if (spawnedPid === undefined) return actual.writeFile(path, data, options);
      if (!Number.isInteger(spawnedPid) || spawnedPid <= 0) {
        throw new Error('expected spawned child pid at pid write boundary');
      }
      receiptWriteFault.capturedPid = spawnedPid;
      receiptWriteFault.capturedReceipt = data;
      return await failAcknowledgedReceipt(spawnedPid);
    },
  };
});

function fakeChrome(script: string): { bin: string; work: string } {
  const work = mkdtempSync(join(tmpdir(), 'dsh-team-chrome-start-'));
  const bin = join(work, 'chrome');
  writeFileSync(bin, `#!/usr/bin/env node\n${script}\n`, { mode: 0o755 });
  return { bin, work };
}

async function assertGone(pid: number, port: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('expected child pid');
  if (!Number.isInteger(port) || port <= 0) throw new Error('expected listener port');
  expect(() => process.kill(pid, 0)).toThrow();
  const { promise, resolve, reject } = Promise.withResolvers<undefined>();
  const socket = createConnection({ host: '127.0.0.1', port });
  socket.once('connect', () => {
    socket.destroy();
    reject(new Error(`listener still bound on ${String(port)}`));
  });
  socket.once('error', () => {
    resolve(undefined);
  });
  await promise;
}

afterEach(() => {
  receiptWriteFault.path = undefined;
  receiptWriteFault.ackPidFile = undefined;
  receiptWriteFault.ackPortFile = undefined;
  receiptWriteFault.capturedPid = undefined;
  receiptWriteFault.capturedPort = undefined;
  receiptWriteFault.capturedReceipt = undefined;
});

it('stops the spawned child when lifecycle receipt writing fails after start', async () => {
  const { bin, work } = fakeChrome(`
const fs = require('node:fs');
const http = require('node:http');
const portFlag = process.argv.find((arg) => arg.startsWith('--remote-debugging-port='));
const port = Number(portFlag.slice('--remote-debugging-port='.length));
fs.writeFileSync(process.env.DSH_TEAM_PID_FILE, String(process.pid));
fs.writeFileSync(process.env.DSH_TEAM_PORT_FILE, String(port));
http.createServer().listen(port, '127.0.0.1');
process.stderr.write(${JSON.stringify(SECRET)});
`);
  const profile = join(work, 'profile');
  mkdirSync(profile);
  const receiptFile = join(work, 'chrome.receipt.json');
  const observedPidFile = join(work, 'observed.pid');
  const observedPortFile = join(work, 'observed.port');
  process.env.DSH_TEAM_PID_FILE = observedPidFile;
  process.env.DSH_TEAM_PORT_FILE = observedPortFile;
  receiptWriteFault.path = receiptFile;
  receiptWriteFault.ackPidFile = observedPidFile;
  receiptWriteFault.ackPortFile = observedPortFile;
  try {
    await startChrome({
      runtime: { kind: 'native', bin },
      origin: 'http://127.0.0.1:12345',
      profile,
      receiptFile,
    });
    throw new Error('must reject lifecycle receipt write failure');
  } catch (error) {
    expect(String(error)).toMatch(/^Error: chrome-start /);
    expect(String(error)).not.toContain(SECRET);
    expect(error).not.toHaveProperty('cause');
    const pid = receiptWriteFault.capturedPid;
    const port = receiptWriteFault.capturedPort;
    if (pid === undefined) {
      throw new Error('expected captured child pid before pid write failure', { cause: error });
    }
    if (port === undefined) {
      throw new Error('expected captured listener port before pid write failure', { cause: error });
    }
    await assertGone(pid, port);
  } finally {
    if (receiptWriteFault.capturedReceipt) {
      const capturedFile = join(work, 'failed-receipt.json');
      writeFileSync(capturedFile, receiptWriteFault.capturedReceipt, { mode: 0o600 });
      await rescueChrome(capturedFile);
    }
    delete process.env.DSH_TEAM_PID_FILE;
    delete process.env.DSH_TEAM_PORT_FILE;
    rmSync(work, { recursive: true, force: true });
  }
});

it('stops the spawned child when debugger discovery returns invalid JSON', async () => {
  const { bin, work } = fakeChrome(`
const fs = require('node:fs');
const net = require('node:net');
const portFlag = process.argv.find((arg) => arg.startsWith('--remote-debugging-port='));
const port = Number(portFlag.slice('--remote-debugging-port='.length));
fs.writeFileSync(process.env.DSH_TEAM_PORT_FILE, String(port));
fs.writeFileSync(process.env.DSH_TEAM_PID_FILE, String(process.pid));
const server = net.createServer((socket) => {
  socket.end('HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\nnot-json ${SECRET}');
});
server.listen(port, '127.0.0.1');
process.stderr.write(${JSON.stringify(SECRET)});
`);
  const profile = join(work, 'profile');
  mkdirSync(profile);
  const receiptFile = join(work, 'chrome.receipt.json');
  const observedPidFile = join(work, 'observed.pid');
  const observedPortFile = join(work, 'observed.port');
  process.env.DSH_TEAM_PID_FILE = observedPidFile;
  process.env.DSH_TEAM_PORT_FILE = observedPortFile;
  try {
    await startChrome({
      runtime: { kind: 'native', bin },
      origin: 'http://127.0.0.1:12345',
      profile,
      receiptFile,
    });
    throw new Error('must reject debugger JSON failure');
  } catch (error) {
    expect(String(error)).toMatch(/^Error: chrome-start /);
    expect(String(error)).not.toContain(SECRET);
    expect(error).not.toHaveProperty('cause');
    const pid = Number(readFileSync(observedPidFile, 'utf8'));
    const port = Number(readFileSync(observedPortFile, 'utf8'));
    await assertGone(pid, port);
  } finally {
    delete process.env.DSH_TEAM_PID_FILE;
    delete process.env.DSH_TEAM_PORT_FILE;
    rmSync(work, { recursive: true, force: true });
  }
});

it('rejects a missing Chrome binary as an awaited chrome-start error', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dsh-team-chrome-missing-'));
  const bin = join(work, 'missing-chrome');
  const profile = join(work, 'profile');
  mkdirSync(profile);
  const receiptFile = join(work, 'chrome.receipt.json');
  try {
    await startChrome({
      runtime: { kind: 'native', bin },
      origin: 'http://127.0.0.1:12345',
      profile,
      receiptFile,
    });
    throw new Error('must reject missing chrome');
  } catch (error) {
    expect(String(error)).toMatch(/^Error: chrome-start /);
    expect(error).not.toHaveProperty('cause');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
