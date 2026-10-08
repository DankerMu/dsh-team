import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { createDockerClient } from './index.ts';
import { startupLogTail } from './readiness-logs.ts';
import { startupDaemon, START_CONTAINER } from '../../test/container-start-fixture.ts';

function frame(stream: 1 | 2, bytes: string | Buffer): Buffer {
  const body = typeof bytes === 'string' ? Buffer.from(bytes) : bytes;
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

async function tail(frames: Buffer[], cookies: string[] = []) {
  const daemon = startupDaemon();
  daemon.overrides.set(
    `GET /containers/${START_CONTAINER}/logs?stdout=true&stderr=true&follow=false&tail=1000`,
    { status: 200, bytes: Buffer.concat(frames) },
  );
  return startupLogTail(
    createDockerClient('/fixture/docker.sock', daemon.transport),
    START_CONTAINER,
    new AbortController().signal,
    cookies,
  );
}

it('retains exactly the final fifty noncredential lines including stderr and a final partial harmless line', async () => {
  const output = await tail([
    frame(1, Array.from({ length: 60 }, (_, index) => `boot ${String(index + 1)}\n`).join('')),
    frame(2, 'stderr neighboring line\n'),
    frame(1, 'final partial line'),
  ]);

  expect(output).toEqual([
    ...Array.from({ length: 48 }, (_, index) => `boot ${String(index + 13)}`),
    'stderr neighboring line',
    'final partial line',
  ]);
});

it('reassembles split UTF8 and CRLF independently across stdout and stderr frames', async () => {
  const chinese = Buffer.from('中文 startup\r\n');

  const output = await tail([
    frame(1, chinese.subarray(0, 2)),
    frame(2, 'separate stderr\r'),
    frame(1, chinese.subarray(2, chinese.length - 1)),
    frame(2, '\n'),
    frame(1, chinese.subarray(chinese.length - 1)),
  ]);

  expect(output).toEqual(['separate stderr', '中文 startup']);
});

it('removes malformed, partial, interleaved and oversized token announcements without retaining a credential suffix', async () => {
  const token = randomBytes(32).toString('base64url');
  const cookieValue = randomBytes(32).toString('base64url');

  const output = await tail([
    frame(1, 'before failure\n'),
    frame(1, 'dsh web: http://127.0.0.1:3080/?to'),
    frame(2, `Authorization: Bearer ${token}\n`),
    frame(1, `ken=${token.slice(0, 7)}`),
    frame(1, `${token.slice(7)}\n`),
    frame(2, `dsh web: malformed ${token}\n`),
    frame(1, `${'x'.repeat(1024)}${token}\n`),
    frame(1, `Set-Cookie: other=${cookieValue}\n`),
    frame(2, `${token}\n`),
    frame(1, 'after failure\n'),
    frame(1, `dsh web: http://127.0.0.1:3080/?token=${token}`),
  ]);

  expect(output).toEqual(['before failure', 'after failure']);
  expect(output.join('\n').includes(token)).toBe(false);
  expect(output.join('\n').includes(cookieValue)).toBe(false);
});

it('redacts known cookie values, secret URL forms and unknown released cookie payloads while preserving harmless context', async () => {
  const value = randomBytes(32).toString('base64url');
  const cookie = `session=${value}`;
  const unknown = `v1.${randomBytes(12).toString('base64url')}.${randomBytes(32).toString('base64url')}`;

  const output = await tail(
    [
      frame(1, `neighbor ${value} remains\n`),
      frame(2, `upstream https://host.test/?access_token=${value} failed\n`),
      frame(1, `unexpected ${unknown} rejected\n`),
      frame(1, 'control\u0000 character\n'),
    ],
    [cookie],
  );

  expect(output).toEqual([
    'neighbor [redacted] remains',
    'unexpected [redacted] rejected',
    'control character',
  ]);
  expect(output.join('\n').includes(value)).toBe(false);
  expect(output.join('\n').includes(unknown)).toBe(false);
});

it('keeps a line at the byte bound, discards an overlong line entirely and resumes on its next newline', async () => {
  const boundary = `startup ${'x'.repeat(1016)}`;

  const output = await tail([
    frame(1, `${boundary}\n`),
    frame(1, `startup ${'x'.repeat(1017)}`),
    frame(1, '\nnext startup line\n'),
  ]);

  expect(output).toEqual([boundary, 'next startup line']);
});

it('reports missing logs explicitly and never invents evidence from a truncated Docker frame', async () => {
  const empty = await tail([]);
  const truncated = frame(1, 'raw partial line');
  const incomplete = await tail([
    frame(1, 'complete startup line\n'),
    truncated.subarray(0, truncated.length - 2),
  ]);

  expect(empty).toEqual(['Startup logs unavailable: no retained safe lines']);
  expect(incomplete).toEqual([
    'complete startup line',
    'Startup logs unavailable: incomplete or unreadable Docker tail',
  ]);
});

it('does not exceed the retained byte bound when malformed UTF8 expands during decoding', async () => {
  const malformed = Buffer.concat([Buffer.from('startup '), Buffer.alloc(1016, 0xff)]);

  const output = await tail([frame(1, malformed), frame(1, '\nharmless next line\n')]);

  expect(output).toEqual(['harmless next line']);
});

it.each(['token', 'known-cookie', 'released-cookie'])(
  'excludes a %s reconstructed by control removal across independent Docker streams',
  async (kind) => {
    const token = randomBytes(32).toString('base64url');
    const value = randomBytes(32).toString('base64url');
    const cookie = `session=${value}`;
    const released = `v1.${randomBytes(12).toString('base64url')}.${randomBytes(32).toString('base64url')}`;
    const secret = kind === 'known-cookie' ? value : released;
    const prefix = kind === 'token' ? 'boot to' : `neighbor ${secret.slice(0, 9)}`;
    const suffix = kind === 'token' ? `ken=${token}\n` : `${secret.slice(9)} remains\n`;

    const output = await tail(
      [
        frame(1, 'before failure\n'),
        frame(2, prefix),
        frame(1, 'harmless interleaved line\n'),
        frame(2, '\u0000'),
        frame(2, suffix),
        frame(1, 'after failure\n'),
      ],
      [cookie],
    );

    for (const credential of [token, cookie, value, released])
      expect(output.join('\n').includes(credential)).toBe(false);
    expect(output).toEqual([
      'before failure',
      'harmless interleaved line',
      ...(kind === 'token' ? [] : ['neighbor [redacted] remains']),
      'after failure',
    ]);
  },
);
