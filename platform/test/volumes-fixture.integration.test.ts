import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { runUserVolumes } from './volumes-fixture.ts';

it('aborts a persisted stalled create and reaches exact-owned cleanup without watchdog rescue', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-volumes-'));
  const socket = join(directory, 'engine.sock');
  const sentinel = { Name: 'unrelated-volume', Labels: { 'dsh-team.user': 'unrelated' } };
  const volumes = new Map<string, unknown>([[sentinel.Name, sentinel]]);
  const requests: { method: string | undefined; path: string | undefined }[] = [];
  let stalled: ServerResponse | undefined;
  let connectionClosed: Promise<unknown> | undefined;
  let persistedName: string | undefined;
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url });
    if (request.method === 'POST' && request.url === '/volumes/create') {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const document: unknown = JSON.parse(Buffer.concat(chunks).toString());
        if (
          typeof document !== 'object' ||
          document === null ||
          !('Name' in document) ||
          typeof document.Name !== 'string'
        ) {
          response.writeHead(400).end();
          return;
        }
        persistedName = document.Name;
        volumes.set(document.Name, document);
        stalled = response;
        connectionClosed = once(request.socket, 'close');
        response.writeHead(201).write('{');
      });
      return;
    }
    const name = request.url?.slice('/volumes/'.length) ?? '';
    if (!volumes.has(name)) {
      response.writeHead(404).end();
    } else if (request.method === 'DELETE') {
      volumes.delete(name);
      response.writeHead(204).end();
    } else {
      response.end(JSON.stringify(volumes.get(name)));
    }
  });
  try {
    server.listen(socket);
    await once(server, 'listening');
    const settled = runUserVolumes(socket, 200).then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    const watchdog = new AbortController();
    const rescued = await Promise.race([
      settled.then(async () => {
        // The same watchdog bounds both cleanup completion and closure of the
        // actual stalled connection; neither proof can await indefinitely.
        if (connectionClosed !== undefined) await connectionClosed;
        return false;
      }),
      delay(2_000, true, { signal: watchdog.signal }),
    ]);
    watchdog.abort();
    // The pre-fix RED also releases its hung fixture, so this test never leaves a socket/resource behind.
    if (rescued) stalled?.destroy();
    const { error } = await settled;

    expect(
      rescued,
      'Acceptance must cancel, close its stalled connection and finish cleanup before rescue',
    ).toBe(false);
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError))
      throw new Error('Expected aggregated acceptance failure');
    expect(error.errors.map(String)).toEqual([`Error: Docker socket ${socket}: ABORT_ERR`]);
    expect(persistedName).toMatch(/^dsh-team-home-[a-f0-9]{10}00$/);
    expect(requests.filter(({ method }) => method === 'POST')).toEqual([
      { method: 'POST', path: '/volumes/create' },
    ]);
    expect(requests.filter(({ method }) => method === 'DELETE')).toEqual([
      { method: 'DELETE', path: `/volumes/${persistedName ?? ''}` },
    ]);
    expect([...volumes.entries()]).toEqual([[sentinel.Name, sentinel]]);
  } finally {
    stalled?.destroy();
    server.closeAllConnections();
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
    await rm(directory, { recursive: true, force: true });
  }
});
