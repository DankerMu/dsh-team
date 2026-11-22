import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import type { DockerOutput } from './deployment-compose-fixture.ts';
import {
  commandReach,
  deliveredHealthcheck,
  DOCUMENT_SERVER,
  DOCUMENT_SERVER_NET,
  firewallReach,
  healthyWithinStartPeriod,
  holderIpv6Rules,
  holderProbeExit,
  holderRead,
  holderRestartSequence,
} from './document-server-net-fixture.ts';
import type { AsyncDockerCommand } from './docker-command.ts';

it('names the delivered Document Server container', () => {
  expect(DOCUMENT_SERVER).toBe('dsh-team-documentserver');
});

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

/** The holder's `docker exec` replayed by this host: the argv after the container name. */
function hostExec(calls: unknown[][]): AsyncDockerCommand {
  return async (args, timeout) => {
    calls.push([args, timeout]);
    const [file = '', ...rest] = args.slice(2);
    const { stdout, stderr } = await promisify(execFile)(file, rest);
    return { status: 0, stdout, stderr };
  };
}

it.each([
  ['exit 1', 1],
  ['exit 2', 2],
  ['exit 0', 0],
  // Quotes and `$` reach the delivered shell verbatim, never expanded by the outer one.
  ["x='a b'; test \"$x\" = 'a b' || exit 3; exit 2", 2],
])('runs the delivered argv %j in the holder and reads its exit %d', async (script, code) => {
  const calls: unknown[][] = [];

  expect(await holderProbeExit(hostExec(calls), ['CMD', 'sh', '-c', script])).toBe(code);
  const outer = ['sh', '-c', '"$@"; echo "$?"', 'sh'];
  expect(calls).toEqual([[['exec', DOCUMENT_SERVER_NET, ...outer, 'sh', '-c', script], 30_000]]);
});

it('fails on a failed docker exec rather than reading it as the probe exit', async () => {
  const missing: AsyncDockerCommand = () =>
    Promise.resolve({ status: 1, stdout: '', stderr: 'Error: No such container' });

  await expect(holderProbeExit(missing, ['CMD', 'sh', '-c', 'exit 1'])).rejects.toThrow(
    'failed (1)',
  );
  const silent: AsyncDockerCommand = () => Promise.resolve({ status: 0, stdout: '', stderr: '' });
  await expect(holderProbeExit(silent, ['CMD', 'true'])).rejects.toThrow(
    'Holder probe exit unreadable: ""',
  );
});

it.each([[['CMD-SHELL', 'exit 1']], [['NONE']], [['CMD']], [['CMD', 'sh', 1]]])(
  'refuses the healthcheck test %j before any exec',
  async (test) => {
    const calls: unknown[][] = [];

    await expect(holderProbeExit(hostExec(calls), test)).rejects.toThrow(
      'Healthcheck test is not an exec-form CMD',
    );
    expect(calls).toEqual([]);
  },
);

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

it('reads each delivered service healthcheck argv and start period from deploy/compose.yml', async () => {
  const holder = await deliveredHealthcheck(repositoryRoot, 'documentserver-net');
  const server = await deliveredHealthcheck(repositoryRoot, 'documentserver');

  expect(holder).toEqual({
    test: ['CMD', 'test', '-f', '/run/dsh-team/firewall-ready'],
    startPeriodMs: 30_000,
  });
  expect(server).toEqual({
    test: ['CMD', 'sh', '-c', "grep -qsaP '^xargs\\x00tail\\x00-F\\x00' /proc/*/cmdline"],
    startPeriodMs: 300_000,
  });
  await expect(deliveredHealthcheck(repositoryRoot, 'absent')).rejects.toThrow(
    'Delivered absent healthcheck unreadable',
  );
});

/** `container inspect` answering each state in turn, the last one repeated. */
function inspecting(states: object[], calls: unknown[][]): AsyncDockerCommand {
  return (args, timeout) => {
    calls.push([args, timeout]);
    const state = states[Math.min(calls.length, states.length) - 1];
    return Promise.resolve({ status: 0, stdout: JSON.stringify([{ State: state }]), stderr: '' });
  };
}

it('polls the named container until healthy', async () => {
  const now = new Date().toISOString();
  const calls: unknown[][] = [];
  const states = ['starting', 'healthy'].map((Status) => ({ StartedAt: now, Health: { Status } }));

  await healthyWithinStartPeriod(inspecting(states, calls), 'dsh-team-x', 30_000);

  expect(calls).toEqual(Array<unknown>(2).fill([['container', 'inspect', 'dsh-team-x'], 15_000]));
}, 10_000);

it.each([
  ['past its start period', new Date(Date.now() - 30_000).toISOString()],
  ['with an unreadable StartedAt', 'never'],
])('fails a container still starting %s, naming it and its status', async (_case, StartedAt) => {
  const calls: unknown[][] = [];
  const states = [{ StartedAt, Health: { Status: 'starting' } }];

  await expect(
    healthyWithinStartPeriod(inspecting(states, calls), 'dsh-team-x', 30_000),
  ).rejects.toThrow('dsh-team-x not healthy within its start period: starting');
  expect(calls).toHaveLength(1);
});

// The #654 measurement on giap-vps (task 0.1): the kernel prints conntrack states reordered.
const IPV6_RULES = [
  '-P INPUT DROP',
  '-A INPUT -i lo -j ACCEPT',
  '-A INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT',
  '-A INPUT -p tcp -m tcp --dport 80 -j ACCEPT',
  '-A INPUT -p ipv6-icmp -j ACCEPT',
];
const READBACK = ['exec', '--user', 'root', DOCUMENT_SERVER_NET, 'sh', '-c'];
const IF_INET6 = 'test -e /proc/net/if_inet6 && ip6tables -S INPUT';
const answering =
  (stdout: string, status = 0, calls: unknown[][] = []): AsyncDockerCommand =>
  (args, timeout) => {
    calls.push([args, timeout]);
    return Promise.resolve({ status, stdout, stderr: '' });
  };

it('reads the IPv6 INPUT rules back in the holder in one exec', async () => {
  const calls: unknown[][] = [];

  await holderIpv6Rules(answering(`${IPV6_RULES.join('\n')}\n`, 0, calls));

  expect(calls).toEqual([[[...READBACK, IF_INET6], 30_000]]);
});

it.each([
  ['a missing rule', IPV6_RULES.slice(0, 4)],
  ['an extra rule', [...IPV6_RULES, '-A INPUT -p tcp -m tcp --dport 8000 -j ACCEPT']],
  ['an ACCEPT policy', ['-P INPUT ACCEPT', ...IPV6_RULES.slice(1)]],
])('fails on %s, naming the observed rules', async (_case, rules) => {
  await expect(holderIpv6Rules(answering(`${rules.join('\n')}\n`))).rejects.toThrow(
    `Holder IPv6 INPUT rules differ: observed=${JSON.stringify([...rules, ''])}`,
  );
});

it('fails when the holder has no /proc/net/if_inet6', async () => {
  await expect(holderIpv6Rules(answering('', 1))).rejects.toThrow('failed (1)');
});

const INSTANCES = ['dsh-team-u-a', 'dsh-team-u-b'];
const NAMES = [...INSTANCES, 'dsh-team-platform', 'dsh-team-documentserver', DOCUMENT_SERVER_NET];
const IDS = NAMES.map((name) => `id-${name}`);
const REFUSED = { outcome: 'refused' };

/**
 * The deployment as Docker would answer it: a holder restart traps the Document Server, whose
 * own restart rejoins it unless `rejoin` is false; `up -d` changes nothing unless told to.
 */
function restartLane({
  traps = true,
  rejoin = true,
  upRestarts = false,
  holderId = IDS[4],
  serverMode = `container:${String(IDS[4])}`,
} = {}) {
  const calls: string[] = [];
  const bounds = new Set<number>();
  let trapped = false;
  const started = new Map(NAMES.map((name) => [name, '2026-11-21T00:00:00.000000001Z']));
  const container = (name: string, index: number) => ({
    Id: name === DOCUMENT_SERVER_NET && trapped ? holderId : IDS[index],
    State: { StartedAt: started.get(name), Health: { Status: 'healthy' } },
    HostConfig: { NetworkMode: name === NAMES[3] ? serverMode : 'bridge' },
    NetworkSettings: { Networks: { 'dsh-team-net-a': { IPAddress: '10.0.0.4', MacAddress: 'm' } } },
  });
  const inspect = (args: readonly string[]) => {
    if (args.length === 5) {
      calls.push('networks');
      const address = { IPAddress: '10.0.0.4' };
      return { 'dsh-team-net-a': address, 'dsh-team-net-b': address };
    }
    calls.push(`inspect ${String(args[2])}`);
    return [container(String(args[2]), NAMES.indexOf(String(args[2])))];
  };
  const answer = (args: readonly string[]) => {
    const [verb = '', , , name = ''] = args;
    if (verb === 'container') return inspect(args);
    calls.push(
      verb === 'compose'
        ? args.join(' ')
        : `${verb} ${verb === 'exec' ? name : String(args.at(-1))}`,
    );
    if (verb === 'restart') trapped = args[1] === DOCUMENT_SERVER_NET ? traps : !rejoin;
    if (verb === 'compose' && upRestarts) started.set(NAMES[2] ?? '', 'later');
    if (args[4] === 'sh') return `${IPV6_RULES.join('\n')}\n`;
    if (name === DOCUMENT_SERVER_NET) return trapped ? [REFUSED, REFUSED] : [OK, OK];
    return [trapped ? REFUSED : OK, TIMEOUT];
  };
  const commandAsync: AsyncDockerCommand = (args, timeout) => {
    bounds.add(timeout);
    const stdout = answer(args);
    return Promise.resolve({
      status: 0,
      stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout),
      stderr: '',
    });
  };
  const holder = {
    Id: IDS[4],
    NetworkSettings: { Networks: { 'dsh-team-net-a': { MacAddress: 'b' } } },
  };
  const sequence = () =>
    holderRestartSequence({ commandAsync, repositoryRoot }, ['compose'], holder, INSTANCES, IDS);
  return { calls, bounds, sequence };
}

it('restarts the holder, runs up -d and restarts the Document Server, probing each moment', async () => {
  const lane = restartLane();

  const macs = await lane.sequence();

  expect(macs).toEqual({ before: { 'dsh-team-net-a': 'b' }, after: { 'dsh-team-net-a': 'm' } });
  const reach = INSTANCES.flatMap((name) => [
    'networks',
    `exec ${DOCUMENT_SERVER_NET}`,
    `exec ${name}`,
  ]);
  const inspects = NAMES.map((name) => `inspect ${name}`);
  const readback = `exec ${DOCUMENT_SERVER_NET}`;
  expect(lane.calls).toEqual([
    readback,
    `restart ${DOCUMENT_SERVER_NET}`,
    `inspect ${DOCUMENT_SERVER_NET}`,
    ...inspects,
    readback,
    ...reach,
    'compose up -d --no-build --pull never',
    ...inspects,
    ...reach,
    'restart dsh-team-documentserver',
    'inspect dsh-team-documentserver',
    ...reach,
  ]);
  // Health polls at 15s, every other call at the 30s the case budget counts.
  expect([...lane.bounds].sort()).toEqual([15_000, 30_000]);
});

it.each([
  ['a holder restart that leaves the stand-in reachable', { traps: false }, 'trapped differs'],
  ['a Document Server restart that does not rejoin', { rejoin: false }, 'joined differs'],
  ['an up -d that restarts a container', { upRestarts: true }, 'up -d changed'],
  ['a holder restart that changes its ID', { holderId: 'id-other' }, 'IDs differ'],
  ['a Document Server outside the holder', { serverMode: 'bridge' }, 'left the holder: bridge'],
])('fails on %s', async (_case, options, message) => {
  await expect(restartLane(options).sequence()).rejects.toThrow(message);
});
