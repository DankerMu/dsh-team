import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import type { DockerOutput } from './deployment-compose-fixture.ts';
import {
  commandReach,
  DOCUMENT_SERVER_NET,
  firewallReach,
  holderRead,
} from './document-server-net-fixture.ts';

async function listening(answer?: number) {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push(`${String(req.method)} ${String(req.url)} ${Buffer.concat(chunks).toString()}`);
      // Without `answer` the request stays unanswered: a peer that accepts and never replies.
      if (answer !== undefined) res.writeHead(answer).end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const close = () => {
    server.closeAllConnections();
    server.close();
  };
  return { port, seen, close };
}

/** Inspect answers the holder's networks; `exec` runs the probe in this Node, as the container would. */
function standIn(networks: object): { run: DockerOutput; calls: string[][] } {
  const calls: string[][] = [];
  const run: DockerOutput = async (args) => {
    calls.push(args);
    if (args[0] === 'container') return JSON.stringify(networks);
    return (await promisify(execFile)(process.execPath, args.slice(5))).stdout;
  };
  return { run, calls };
}

it('classifies answered, refused and unanswered requests from the holder and the instance', async () => {
  const inside = await listening(418);
  const open = await listening(201);
  const silent = await listening();
  const closed = await listening(200);
  closed.close();
  const { run, calls } = standIn({ 'dsh-team-net-1': { IPAddress: '127.0.0.1' }, other: {} });
  try {
    const seen = await firewallReach(
      run,
      'dsh-team-u-1',
      [{ host: '127.0.0.1', port: inside.port, path: '/healthcheck' }],
      [
        { port: open.port, path: '/command', method: 'POST' },
        { port: closed.port, path: '/' },
        { port: silent.port, path: '/' },
      ],
    );

    expect(seen).toEqual({
      inside: [{ outcome: 'answered', status: 418 }],
      outside: [
        { outcome: 'answered', status: 201 },
        { outcome: 'refused' },
        { outcome: 'timeout' },
      ],
    });
    expect([inside.seen, open.seen]).toEqual([['GET /healthcheck '], ['POST /command {}']]);
    expect(calls.map((args) => args.slice(0, 7))).toEqual([
      ['container', 'inspect', '-f', '{{json .NetworkSettings.Networks}}', DOCUMENT_SERVER_NET],
      ['exec', '--user', 'root', DOCUMENT_SERVER_NET, 'node', '--input-type=module', '-e'],
      ['exec', '--user', '1001', 'dsh-team-u-1', 'node', '--input-type=module', '-e'],
    ]);
  } finally {
    for (const listener of [inside, open, silent]) listener.close();
  }
}, 10_000);

it("fails before probing when the holder is not on the instance's network", async () => {
  const { run, calls } = standIn({ 'dsh-team-net-2': { IPAddress: '10.0.0.4' } });

  await expect(firewallReach(run, 'dsh-team-u-1', [], [])).rejects.toThrow(
    'Document Server holder has no address on dsh-team-net-1',
  );
  expect(calls).toHaveLength(1);
});

it('hands the JWT to the holder on stdin only and parses its JSON answer', async () => {
  const jwt = 'f'.repeat(64);
  const seen: unknown[][] = [];
  const read = holderRead((args, timeout, input) => {
    seen.push([args, timeout, input === jwt]);
    return Promise.resolve({ status: 0, stdout: '{"ok":true}', stderr: '' });
  }, jwt);

  expect(await read('script')).toEqual({ ok: true });
  expect(seen).toEqual([
    [
      ['exec', '-i', DOCUMENT_SERVER_NET, 'node', '--input-type=module', '-e', 'script'],
      30_000,
      true,
    ],
  ]);
});

it('needs the in-memory JWT before any exec', () => {
  expect(() => holderRead(() => Promise.reject(new Error('unused')), undefined)).toThrow(
    'Document Server JWT was not generated',
  );
});

const OK = { outcome: 'answered', status: 200 };
const TIMEOUT = { outcome: 'timeout' };
const FORBIDDEN = { outcome: 'answered', status: 403 };
// nginx decodes `%3F`/`%23` before matching; the image's version-prefix catch-all would pass them on.
const ENCODED = ['command%3F', 'command%23', 'coauthoring/CommandService.ashx%3F'];
const COMMAND_OK = [OK, TIMEOUT, ...Array<object>(4).fill(FORBIDDEN)];

/** The holder answers 404 on loopback 8000; the instance answers `outside`. */
const commandLane = (outside: object[], calls: string[][]) => (args: string[]) => {
  calls.push(args);
  if (args[0] === 'container')
    return Promise.resolve('{"dsh-team-net-1":{"IPAddress":"10.0.0.4"}}');
  const inside = [{ outcome: 'answered', status: 404 }];
  return Promise.resolve(JSON.stringify(args[3] === DOCUMENT_SERVER_NET ? inside : outside));
};

it('requires healthcheck 200, an unanswered 8000 and 403 on every Command Service path from the instance', async () => {
  const calls: string[][] = [];

  const seen = await commandReach(commandLane(COMMAND_OK, calls), 'dsh-team-u-1');

  expect(seen).toEqual({ inside: [{ outcome: 'answered', status: 404 }], outside: COMMAND_OK });
  const post = { path: '/command', method: 'POST' };
  expect(calls.slice(1).map((args) => JSON.parse(args.at(-1) ?? '') as unknown)).toEqual([
    [{ host: '127.0.0.1', port: 8000, ...post }],
    [
      { host: '10.0.0.4', port: 80, path: '/healthcheck' },
      { host: '10.0.0.4', port: 8000, ...post },
      { host: '10.0.0.4', port: 80, ...post },
      ...ENCODED.map((path) => ({ host: '10.0.0.4', port: 80, ...post, path: `/9.4.0-1/${path}` })),
    ],
  ]);
});

it.each([
  ['a refused 8000', [OK, { outcome: 'refused' }, ...COMMAND_OK.slice(2)], '"refused"'],
  [
    'an answered Command Service',
    [OK, TIMEOUT, OK, ...COMMAND_OK.slice(3)],
    '"timeout"},{"outcome":"answered","status":200}',
  ],
  [
    'an answered encoded suffix',
    [...COMMAND_OK.slice(0, 5), OK],
    '"status":403},{"outcome":"answered","status":200}]',
  ],
])('fails on %s, naming the outcomes', async (_case, outside, needle) => {
  await expect(commandReach(commandLane(outside, []), 'dsh-team-u-1')).rejects.toThrow(needle);
});
