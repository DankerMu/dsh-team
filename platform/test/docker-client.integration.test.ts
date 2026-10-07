import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createDockerClient } from '../src/orchestrator/index.ts';

it('uses a real owned Unix HTTP socket for JSON, status, incremental logs and cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-http-'));
  const socket = join(directory, 'engine.sock');
  let logClosed: Promise<unknown> | undefined;
  const server = createServer((request, response) => {
    if (request.url === '/missing') {
      response.writeHead(404).end('secret daemon detail');
      return;
    }
    if (request.url === '/logs') {
      logClosed = once(response, 'close');
      response.write(Buffer.from('010000000000000361', 'hex'));
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () =>
      response.end(
        JSON.stringify({
          method: request.method,
          path: request.url,
          body: Buffer.concat(chunks).toString(),
        }),
      ),
    );
  });
  try {
    server.listen(socket);
    await once(server, 'listening');
    const client = createDockerClient(socket);

    expect(await client.json('POST', '/create?name=a%20b', { Image: '中文' })).toEqual({
      method: 'POST',
      path: '/create?name=a%20b',
      body: '{"Image":"中文"}',
    });
    await expect(client.json('GET', '/missing')).rejects.toMatchObject({ statusCode: 404 });
    const logs = client.logs('/logs');
    expect(await logs.next()).toMatchObject({
      done: false,
      value: { stream: 'stdout', data: Buffer.from('a') },
    });
    await logs.return(undefined);
    await logClosed;
    await expect(
      createDockerClient(join(directory, 'absent.sock')).json('GET', '/version'),
    ).rejects.toThrow(`Docker socket ${join(directory, 'absent.sock')}: ENOENT`);
  } finally {
    server.closeAllConnections();
    try {
      if (server.listening)
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
