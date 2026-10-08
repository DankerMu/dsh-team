import { PassThrough, Readable, Writable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { createDockerClient, DockerHttpError } from './index.ts';
import type { DockerTransport } from './index.ts';

function boundary(statusCode = 200, chunks: Buffer[] = []) {
  const response = Object.assign(Readable.from(chunks), { statusCode });
  const sent: Buffer[] = [];
  const request = new Writable({
    write(chunk: Buffer, _encoding, done) {
      sent.push(chunk);
      done();
    },
  });
  const transport = vi.fn<DockerTransport>((_options, receive) => {
    queueMicrotask(() => {
      receive(response);
    });
    return request;
  });
  return {
    client: createDockerClient('/owned/docker.sock', transport),
    response,
    request,
    transport,
    sent,
  };
}

it('preserves JSON documents and sends method, query and UTF-8 JSON on the configured socket', async () => {
  const wire = boundary(201, [Buffer.from('{"Id":"abc"}')]);

  const result = await wire.client.json('POST', '/containers/create?name=a%20b', { Image: '中文' });

  expect(result).toEqual({ Id: 'abc' });
  expect(wire.transport.mock.calls[0]?.[0]).toMatchObject({
    socketPath: '/owned/docker.sock',
    method: 'POST',
    path: '/containers/create?name=a%20b',
  });
  expect(Buffer.concat(wire.sent).toString()).toBe('{"Image":"中文"}');
  expect(wire.transport).toHaveBeenCalledTimes(1);
});

it.each([200, 204])('returns no document for empty HTTP %i success', async (status) => {
  expect(await boundary(status).client.json('DELETE', '/containers/absent')).toBeUndefined();
});

it.each(['', 'secret non-JSON body', '{"message":"secret"}'])(
  'preserves HTTP404 without disclosing body %j',
  async (body) => {
    const wire = boundary(404, [Buffer.from(body)]);

    const error: unknown = await wire.client
      .json('GET', '/secret')
      .catch((error: unknown) => error);

    expect(error).toBeInstanceOf(DockerHttpError);
    expect(error).toMatchObject({ statusCode: 404 });
    expect(String(error) + JSON.stringify(error)).not.toContain('secret');
    expect(error).not.toHaveProperty('cause');
    expect(wire.response.destroyed).toBe(true);
  },
);

it('rejects malformed successful JSON without disclosing its content', async () => {
  const wire = boundary(200, [Buffer.from('secret broken JSON')]);

  await expect(wire.client.json('GET', '/version')).rejects.toThrow('Invalid Docker JSON response');
});

it.each(['throw', 'request', 'response'] as const)(
  'sanitizes %s transport failures and destroys resources',
  async (stage) => {
    const response = Object.assign(new PassThrough(), { statusCode: 200 });
    const outgoing = new PassThrough();
    const failure = Object.assign(new Error('secret transport detail'), { code: 'ECONNRESET' });
    const transport: DockerTransport = (_options, receive) => {
      if (stage === 'throw') throw failure;
      queueMicrotask(() => {
        if (stage === 'request') outgoing.emit('error', failure);
        else {
          receive(response);
          queueMicrotask(() => response.destroy(failure));
        }
      });
      return outgoing;
    };

    const error: unknown = await createDockerClient('/owned/docker.sock', transport)
      .json('GET', '/version')
      .catch((error: unknown) => error);

    expect(String(error)).toBe('Error: Docker socket /owned/docker.sock: ECONNRESET');
    expect(error).not.toHaveProperty('cause');
    if (stage !== 'throw') expect(outgoing.destroyed).toBe(true);
  },
);

it('decodes split headers and UTF-8 payload bytes with coalesced stdout and stderr frames', async () => {
  // Docker wire: stdout "中", empty stdout, stderr "!".
  const bytes = Buffer.from('0100000000000003e4b8ad0100000000000000020000000000000121', 'hex');
  const wire = boundary(200, [bytes.subarray(0, 3), bytes.subarray(3, 9), bytes.subarray(9)]);
  const outputs = [];

  for await (const chunk of wire.client.logs('/containers/a/logs?stdout=1&stderr=1'))
    outputs.push(chunk);

  expect(outputs.map((chunk) => chunk.stream)).toEqual(['stdout', 'stdout', 'stderr']);
  expect(
    Buffer.concat(outputs.filter((chunk) => chunk.stream === 'stdout').map((chunk) => chunk.data)),
  ).toEqual(Buffer.from('中'));
  expect(outputs[2]?.data).toEqual(Buffer.from('!'));
});

it.each([
  '0300000000000000',
  '0101000000000000',
  '0100010000000000',
  '0100000100000000',
  '010000',
  '020000000000000261',
])('rejects malformed or truncated log frame %s and closes the response', async (hex) => {
  const wire = boundary(200, [Buffer.from(hex, 'hex')]);

  await expect(Readable.from(wire.client.logs('/logs')).toArray()).rejects.toThrow(
    /Docker log frame/,
  );
  expect(wire.response.destroyed).toBe(true);
  expect(wire.request.destroyed).toBe(true);
});

it('yields a partial large frame before completion, bounds read-ahead and closes on early exit', async () => {
  let produced = 0;
  let closed = false;
  const response = Object.assign(
    Readable.from(
      (function* () {
        try {
          yield Buffer.from('01000000ffffffff61', 'hex');
          for (let index = 0; index < 100; index++) {
            produced++;
            yield Buffer.alloc(64, 98);
          }
        } finally {
          closed = true;
        }
      })(),
      { objectMode: false, highWaterMark: 1 },
    ),
    { statusCode: 200 },
  );
  const outgoing = new PassThrough();
  const client = createDockerClient('/owned/docker.sock', (_options, receive) => {
    queueMicrotask(() => {
      receive(response);
    });
    return outgoing;
  });
  const logs = client.logs('/logs');

  expect(await logs.next()).toMatchObject({
    done: false,
    value: { stream: 'stdout', data: Buffer.from('a') },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(produced).toBeLessThanOrEqual(1);
  expect(closed).toBe(false);
  await logs.return(undefined);

  expect(response.destroyed).toBe(true);
  expect(outgoing.destroyed).toBe(true);
});

it.each([false, true])(
  'aborts a pending log read (already aborted: %s) without leaking the reason',
  async (before) => {
    const cancellation = new AbortController();
    const response = Object.assign(new PassThrough(), { statusCode: 200 });
    const outgoing = new PassThrough();
    const client = createDockerClient('/owned/docker.sock', (_options, receive) => {
      queueMicrotask(() => {
        receive(response);
        cancellation.abort('secret');
      });
      return outgoing;
    });
    if (before) cancellation.abort('secret');

    await expect(client.logs('/logs', cancellation.signal).next()).rejects.toThrow(
      'Docker socket /owned/docker.sock: ABORT_ERR',
    );
    if (!before) {
      expect(response.destroyed).toBe(true);
      expect(outgoing.destroyed).toBe(true);
    }
  },
);

it.each(['', 'relative.sock', '/secret\0socket'])(
  'rejects unsafe socket %j instead of falling back to TCP',
  (socket) => {
    expect(() => createDockerClient(socket)).toThrow(
      'Docker socket must be an absolute nonempty path without NUL',
    );
  },
);

it('retains HTTP status for log errors rather than parsing secret error text as frames', async () => {
  const wire = boundary(500, [Buffer.from('secret error body')]);

  await expect(wire.client.logs('/logs').next()).rejects.toMatchObject({
    statusCode: 500,
    message: 'Docker HTTP 500',
  });
});

it('does not trust a transport message or arbitrary code as a sanitized diagnostic', async () => {
  const client = createDockerClient('/owned/docker.sock', () => {
    throw Object.assign(new Error('Docker socket /owned/docker.sock: secret'), { code: 'secret' });
  });

  await expect(client.json('GET', '/version')).rejects.toThrow(
    'Docker socket /owned/docker.sock: UNKNOWN',
  );
});

it('stops buffered log delivery when cancellation follows the first coalesced frame', async () => {
  const wire = boundary(200, [Buffer.from('010000000000000161020000000000000162', 'hex')]);
  const cancellation = new AbortController();
  const logs = wire.client.logs('/logs', cancellation.signal);
  expect(await logs.next()).toMatchObject({ value: { stream: 'stdout', data: Buffer.from('a') } });

  cancellation.abort('secret');

  await expect(logs.next()).rejects.toThrow('ABORT_ERR');
  expect(wire.response.destroyed).toBe(true);
  expect(wire.request.destroyed).toBe(true);
});

it('bounds only opted-in JSON consumption and closes both resources on overflow', async () => {
  const wire = boundary(200, [Buffer.from('{"x":'), Buffer.from('"oversized"}')]);

  await expect(
    wire.client.json('GET', '/containers/json', undefined, undefined, 8),
  ).rejects.toThrow('Docker JSON response exceeds byte limit');

  expect(wire.response.destroyed).toBe(true);
  expect(wire.request.destroyed).toBe(true);
  expect(
    await boundary(200, [Buffer.from('{"x":"oversized"}')]).client.json('GET', '/version'),
  ).toEqual({
    x: 'oversized',
  });
  expect(
    await boundary(200, [Buffer.from('{}')]).client.json(
      'GET',
      '/containers/json',
      undefined,
      undefined,
      2,
    ),
  ).toEqual({});
});
