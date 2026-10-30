import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  LOCAL_MODEL_READY_SCRIPT,
  awaitLocalModelReady,
  localModelReadyScript,
} from './local-model-readiness.ts';

type Read = (script: string) => Promise<Record<string, unknown>>;

it('propagates the first failed readiness exec instead of retrying it', async () => {
  const read = vi
    .fn<Read>()
    .mockRejectedValueOnce(new Error('Private observation failed'))
    .mockResolvedValue({ ready: true });
  await expect(awaitLocalModelReady(read)).rejects.toThrow('Private observation failed');
  expect(read).toHaveBeenCalledTimes(1);
});

it('resolves after one exec of the canonical script when the stub is ready', async () => {
  const read = vi.fn<Read>().mockResolvedValue({ ready: true });
  await awaitLocalModelReady(read);
  expect(read).toHaveBeenCalledTimes(1);
  expect(read.mock.calls[0]?.[0]).toBe(LOCAL_MODEL_READY_SCRIPT);
});

it('rejects a completed exec that does not report readiness', async () => {
  const read = vi.fn<Read>().mockResolvedValue({ ready: false });
  await expect(awaitLocalModelReady(read)).rejects.toThrow('Local model stub not ready');
  expect(read).toHaveBeenCalledTimes(1);
});

function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function close(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  server.closeAllConnections();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function freePort(): Promise<number> {
  const probe = createServer();
  const port = await listen(probe);
  await close(probe);
  return port;
}

function runScript(script: string): Promise<{ code: number | null; stdout: string }> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5_000,
    killSignal: 'SIGKILL',
  });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.resume();
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({ code, stdout });
    });
  });
}

describe('in-container readiness script', () => {
  it('waits for a late listener and succeeds after a 503', async () => {
    const port = await freePort();
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      if (requests === 1) {
        response.writeHead(503).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"ready":true}');
    });
    try {
      const run = runScript(localModelReadyScript(`http://127.0.0.1:${String(port)}`, 3_000));
      await delay(500);
      await listen(server, port);
      const result = await run;
      expect(result).toEqual({ code: 0, stdout: '{"ready":true}' });
      expect(requests).toBe(2);
    } finally {
      await close(server);
    }
  });

  it('exits 1 when the stub never becomes ready', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(503).end();
    });
    try {
      const port = await listen(server);
      const result = await runScript(
        localModelReadyScript(`http://127.0.0.1:${String(port)}`, 300),
      );
      expect(result).toEqual({ code: 1, stdout: '{"ready":false}' });
    } finally {
      await close(server);
    }
  });

  it('bounds an accepted but unanswered request by the deadline', async () => {
    const held: ServerResponse[] = [];
    const server = createServer();
    server.on('request', (_request, response: ServerResponse) => {
      held.push(response);
    });
    try {
      const port = await listen(server);
      const result = await runScript(
        localModelReadyScript(`http://127.0.0.1:${String(port)}`, 300),
      );
      expect(result).toEqual({ code: 1, stdout: '{"ready":false}' });
      expect(held).toHaveLength(1);
    } finally {
      await close(server);
    }
  });
});
