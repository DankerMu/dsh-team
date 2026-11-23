import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';
import type { DockerOutput } from './deployment-compose-fixture.ts';
import { containerDocument, output, record } from './docker-cleanup.ts';
import { isAbsentResource } from './docker-command.ts';
import type { AsyncDockerCommand } from './docker-command.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

/** The firewall holder owning the bundled Document Server's network namespace (#624). */
export const DOCUMENT_SERVER_NET = 'dsh-team-documentserver-net';
/** The delivered Document Server container (deploy/compose.yml). */
export const DOCUMENT_SERVER = 'dsh-team-documentserver';
const NODE = ['node', '--input-type=module', '-e'];

/** One HTTP request; `POST` sends `{}`. */
export interface ReachTarget {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly method?: 'GET' | 'POST';
}

/** `timeout`: no answer within 3s, what the holder's DROP gives; `refused` means nothing listens. */
type ReachOutcome =
  | { readonly outcome: 'answered'; readonly status: number }
  | { readonly outcome: 'timeout' | 'refused' }
  | { readonly outcome: 'failed'; readonly code: string };

/** Classifies each of argv[1]'s targets; prints only outcomes and statuses. */
const REACH = `import { request } from 'node:http';
const reach = ({ host, port, path, method = 'GET' }) => new Promise((resolve) => {
  const req = request({ host, port, path, method, timeout: 3000 }, (res) => { res.resume(); resolve({ outcome: 'answered', status: res.statusCode }); });
  req.on('timeout', () => { resolve({ outcome: 'timeout' }); req.destroy(); });
  req.on('error', (error) => resolve(error.code === 'ECONNREFUSED' ? { outcome: 'refused' } : { outcome: 'failed', code: String(error.code) }));
  req.end(method === 'POST' ? '{}' : undefined);
});
process.stdout.write(JSON.stringify(await Promise.all(JSON.parse(process.argv[1]).map(reach))));`;

/** The holder's network endpoints only: its full inspect also carries the JWT in `Config.Env`. */
async function holderNetworks(run: DockerOutput) {
  const format = '{{json .NetworkSettings.Networks}}';
  return record(JSON.parse(await run(['container', 'inspect', '-f', format, DOCUMENT_SERVER_NET])));
}

async function reach(
  run: DockerOutput,
  container: string,
  user: string,
  targets: readonly ReachTarget[],
) {
  const args = ['exec', '--user', user, container, ...NODE, REACH, JSON.stringify(targets)];
  // The script above prints exactly one outcome per target.
  return JSON.parse(await run(args)) as ReachOutcome[];
}

/**
 * 55.3 (#624): `inside` from the holder's own namespace (root), then `outside` from `instance`
 * (uid 1001) to the holder's address on that instance's bridge (+4).
 */
export async function firewallReach(
  run: DockerOutput,
  instance: string,
  inside: readonly ReachTarget[],
  outside: readonly Omit<ReachTarget, 'host'>[],
) {
  const networks = await holderNetworks(run);
  const network = instance.replace('dsh-team-u-', 'dsh-team-net-');
  const host = networks[network] === undefined ? undefined : record(networks[network]).IPAddress;
  if (typeof host !== 'string' || host === '')
    throw new Error(`Document Server holder has no address on ${network}`);
  return {
    inside: await reach(run, DOCUMENT_SERVER_NET, 'root', inside),
    outside: await reach(
      run,
      instance,
      '1001',
      outside.map((target) => ({ host, ...target })),
    ),
  };
}

export type NamespaceRead = (script: string) => Promise<Record<string, unknown>>;

/** JSON-printing scripts in the holder, which shares the Document Server's loopback; the JWT
 * reaches them only on stdin, never argv, logs or evidence. */
export function holderRead(command: AsyncDockerCommand, jwt: string | undefined): NamespaceRead {
  if (jwt === undefined) throw new Error('Document Server JWT was not generated');
  return async (script) => {
    const args = ['exec', '-i', DOCUMENT_SERVER_NET, ...NODE, script];
    return record(JSON.parse(output(await command(args, 30_000, jwt), args)));
  };
}

/**
 * The exit of a Docker exec-form healthcheck `test` run unchanged in the holder (#648), printed by
 * an outer sh so `docker exec` itself exits 0: its custody submission settles, and a daemon
 * failure such as a missing container throws instead of reading as the probe's own answer.
 */
export async function holderProbeExit(command: AsyncDockerCommand, test: readonly unknown[]) {
  const [kind, ...argv] = test;
  if (kind !== 'CMD' || argv.length === 0 || !argv.every((arg) => typeof arg === 'string'))
    throw new Error('Healthcheck test is not an exec-form CMD');
  const args = ['exec', DOCUMENT_SERVER_NET, 'sh', '-c', '"$@"; echo "$?"', 'sh', ...argv];
  const code = output(await command(args, 30_000), args);
  if (!/^\d+\n$/.test(code))
    throw new Error(`Holder probe exit unreadable: ${JSON.stringify(code)}`);
  return Number(code);
}

const COMMAND = { path: '/command', method: 'POST' } as const;
const ANSWERED = (status: number) => ({ outcome: 'answered', status });
// nginx matches the decoded path: these reached docservice through the version-prefix catch-all.
const ENCODED = ['command%3F', 'command%23', 'coauthoring/CommandService.ashx%3F'];
const EXPECTED_COMMAND = {
  inside: ['answered'],
  outside: [ANSWERED(200), { outcome: 'timeout' }, ...Array<object>(4).fill(ANSWERED(403))],
};

/**
 * 55.3 (#624) on the real Document Server: docservice answers its own loopback 8000; from
 * `instance`, +4:80 serves `/healthcheck`, 8000 times out and nginx refuses `/command` and the
 * version-prefixed encoded-suffix variants with 403.
 * Vitest-free (the deployment fixture imports this module); fails with the outcomes only.
 */
export async function commandReach(run: DockerOutput, instance: string) {
  const inside = [{ host: '127.0.0.1', port: 8000, ...COMMAND }];
  const outside = [
    { port: 80, path: '/healthcheck' },
    { port: 8000, ...COMMAND },
    { port: 80, ...COMMAND },
    ...ENCODED.map((path) => ({ port: 80, ...COMMAND, path: `/9.4.0-1/${path}` })),
  ];
  const seen = await firewallReach(run, instance, inside, outside);
  const observed = { inside: seen.inside.map(({ outcome }) => outcome), outside: seen.outside };
  if (!isDeepStrictEqual(observed, EXPECTED_COMMAND))
    throw new Error(
      `Command Service reach differs: observed=${JSON.stringify(seen)} expected=${JSON.stringify(EXPECTED_COMMAND)}`,
    );
  return seen;
}

/** A delivered compose service's healthcheck: its argv and its start period in milliseconds. */
export async function deliveredHealthcheck(repositoryRoot: string, service: string) {
  // Compose YAML is untyped; both consumed fields are checked below.
  const delivered = parse(await readFile(join(repositoryRoot, 'deploy/compose.yml'), 'utf8')) as {
    services: Record<string, { healthcheck?: { test?: unknown; start_period?: unknown } }>;
  };
  const { test, start_period: period } = delivered.services[service]?.healthcheck ?? {};
  const seconds = typeof period === 'string' ? /^(\d+)s$/.exec(period)?.[1] : undefined;
  if (!Array.isArray(test) || seconds === undefined)
    throw new Error(`Delivered ${service} healthcheck unreadable`);
  const argv: unknown[] = test;
  return { test: argv, startPeriodMs: Number(seconds) * 1_000 };
}

/** Polls `State.Health` until `healthy`, failing once the start period since StartedAt is over. */
export async function healthyWithinStartPeriod(
  command: AsyncDockerCommand,
  container: string,
  startPeriodMs: number,
) {
  for (;;) {
    const inspected = await command(['container', 'inspect', container], 15_000);
    const state = record(containerDocument(inspected).State);
    const status = record(state.Health).Status;
    if (status === 'healthy') return;
    const startedAt = Date.parse(String(state.StartedAt));
    if (Number.isNaN(startedAt) || Date.now() - startedAt >= startPeriodMs)
      throw new Error(`${container} not healthy within its start period: ${String(status)}`);
    await delay(1_000);
  }
}

/** `ip6tables -S INPUT` after deploy/document-server-net.sh, measured on giap-vps (#654 0.1). */
const IPV6_INPUT_RULES = [
  '-P INPUT DROP',
  '-A INPUT -i lo -j ACCEPT',
  '-A INPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT',
  '-A INPUT -p tcp -m tcp --dport 80 -j ACCEPT',
  '-A INPUT -p ipv6-icmp -j ACCEPT',
];

/** #654: the holder has IPv6 and exactly the script's IPv6 INPUT rules; one exec as root. */
export async function holderIpv6Rules(command: AsyncDockerCommand) {
  const script = 'test -e /proc/net/if_inet6 && ip6tables -S INPUT';
  const args = ['exec', '--user', 'root', DOCUMENT_SERVER_NET, 'sh', '-c', script];
  const rules = output(await command(args, 30_000), args).split('\n');
  if (!isDeepStrictEqual(rules, [...IPV6_INPUT_RULES, '']))
    throw new Error(
      `Holder IPv6 INPUT rules differ: observed=${JSON.stringify(rules)} expected=${JSON.stringify(IPV6_INPUT_RULES)}`,
    );
}

const OK = { outcome: 'answered', status: 200 };
const TIMEOUT = { outcome: 'timeout' };
const REFUSED = { outcome: 'refused' };
/**
 * The deploy stand-in's ports from every instance (#654, inferred from the rules): `joined` is
 * the deployed topology; `trapped` a holder restarted alone, whose new namespace has the rules
 * but no listener: 80 accepted then reset, 8000 dropped.
 */
const STAND_IN_REACH = {
  joined: { inside: [OK, OK], outside: [OK, TIMEOUT] },
  trapped: { inside: [REFUSED, REFUSED], outside: [REFUSED, TIMEOUT] },
};
const INSIDE = [80, 8000].map((port) => ({ host: '127.0.0.1', port, path: '/' }));
const OUTSIDE = [80, 8000].map((port) => ({ port, path: '/' }));

async function standInReach(
  run: DockerOutput,
  instances: readonly string[],
  moment: keyof typeof STAND_IN_REACH,
  macs: object,
) {
  for (const instance of instances) {
    const seen = await firewallReach(run, instance, INSIDE, OUTSIDE);
    if (!isDeepStrictEqual(seen, STAND_IN_REACH[moment]))
      throw new Error(
        `Stand-in reach ${moment} differs from ${instance}: observed=${JSON.stringify(seen)} holder MACs=${JSON.stringify(macs)}`,
      );
  }
}

/** Only identities: inspect documents also carry the JWT in `Config.Env`. */
const identity = (container: Record<string, unknown>) => ({
  id: container.Id,
  startedAt: record(container.State).StartedAt,
});
const macAddresses = (container: Record<string, unknown> | undefined) =>
  Object.fromEntries(
    Object.entries(record(record(container?.NetworkSettings).Networks)).map(([name, network]) => [
      name,
      record(network).MacAddress,
    ]),
  );

/**
 * #654, after the initial reach: restart the holder alone, run `up -d`, then restart the Document
 * Server (docs/DEPLOY.md). `instances` are container names; `expectedIds` the IDs of those
 * instances, the platform, the Document Server and the holder, in that order; `holder` is its
 * inspect before the restart. Returns the holder's MACs before and after, for diagnosis.
 */
export async function holderRestartSequence(
  lifecycle: Pick<UserImageLifecycle, 'commandAsync' | 'repositoryRoot'>,
  compose: readonly string[],
  holder: Record<string, unknown>,
  instances: readonly string[],
  expectedIds: readonly unknown[],
) {
  const command = lifecycle.commandAsync;
  const run: DockerOutput = async (args) => output(await command(args, 30_000), args);
  const names = [...instances, 'dsh-team-platform', DOCUMENT_SERVER, DOCUMENT_SERVER_NET];
  const inspectAll = async () => {
    const documents = [];
    for (const name of names)
      documents.push(containerDocument(await command(['container', 'inspect', name], 30_000)));
    return documents;
  };
  const root = lifecycle.repositoryRoot;
  const net = await deliveredHealthcheck(root, 'documentserver-net');
  const server = await deliveredHealthcheck(root, 'documentserver');

  await holderIpv6Rules(command);
  await run(['restart', DOCUMENT_SERVER_NET]);
  await healthyWithinStartPeriod(command, DOCUMENT_SERVER_NET, net.startPeriodMs);
  const restarted = await inspectAll();
  const macs = { before: macAddresses(holder), after: macAddresses(restarted.at(-1)) };
  const ids = restarted.map(({ Id }) => Id);
  // The identity checks still pass on a trapped Document Server: the reach below tells them apart.
  if (!isDeepStrictEqual(ids, expectedIds))
    throw new Error(`Container IDs differ after the holder restart: ${JSON.stringify(ids)}`);
  const mode = record(restarted.at(-2)?.HostConfig).NetworkMode;
  if (mode !== `container:${String(holder.Id)}`)
    throw new Error(`Document Server left the holder: ${String(mode)}`);
  await holderIpv6Rules(command);
  await standInReach(run, instances, 'trapped', macs);

  await run([...compose, 'up', '-d', '--no-build', '--pull', 'never']);
  const before = restarted.map(identity);
  const after = (await inspectAll()).map(identity);
  if (!isDeepStrictEqual(after, before))
    throw new Error(`up -d changed containers: ${JSON.stringify({ before, after })}`);
  await standInReach(run, instances, 'trapped', macs);

  await run(['restart', DOCUMENT_SERVER]);
  await healthyWithinStartPeriod(command, DOCUMENT_SERVER, server.startPeriodMs);
  await standInReach(run, instances, 'joined', macs);
  return macs;
}

const V6_NET = 'dsh-team-v6-net';
const V6_PROBE = 'dsh-team-v6-probe';
const DOCKER_ID = /^[a-f0-9]{64}$/;
const DROP_POLICY = /^Chain INPUT \(policy DROP (\d+) packets, \d+ bytes\)$/;
const IPV6_REACH = { inside: [OK, OK], outside: [OK, TIMEOUT], dropped: true };
type Ipv6Lifecycle = Pick<
  UserImageLifecycle,
  'commandAsync' | 'registerResourceAsync' | 'removeNetwork'
>;
type Undo = () => Promise<void> | void;

/** The packet count of the holder's IPv6 INPUT DROP policy, read as root. */
async function dropCount(run: DockerOutput) {
  const list = ['ip6tables', '-L', 'INPUT', '-v', '-x', '-n'];
  const [first = ''] = (await run(['exec', '--user', 'root', DOCUMENT_SERVER_NET, ...list])).split(
    '\n',
  );
  const packets = DROP_POLICY.exec(first)?.[1];
  if (packets === undefined)
    throw new Error(`Holder IPv6 INPUT policy unreadable: ${JSON.stringify(first)}`);
  return Number(packets);
}

/** Failure context only: the temporary network's subnets, never masking the failure itself. */
async function ipv6Subnets(run: DockerOutput) {
  const args = ['network', 'inspect', '-f', '{{json .IPAM.Config}}', V6_NET];
  return run(args).then(
    (stdout) => stdout.trim(),
    (error: unknown) => `unreadable (${error instanceof Error ? error.message : String(error)})`,
  );
}

async function removeProbe(command: AsyncDockerCommand, id: string) {
  const args = ['rm', '-f', id];
  const result = await command(args, 30_000);
  if (!isAbsentResource(result, 'container', id)) output(result, args);
}

async function disconnectHolder(command: AsyncDockerCommand, run: DockerOutput) {
  const args = ['network', 'disconnect', '--force', V6_NET, DOCUMENT_SERVER_NET];
  const result = await command(args, 30_000);
  try {
    output(result, args);
  } catch (disconnect) {
    // A failed or timed-out disconnect is done once the holder no longer has the network.
    const networks = await holderNetworks(run).catch((inspect: unknown) => {
      throw new AggregateError([disconnect, inspect], 'Holder IPv6 disconnect unproven');
    });
    if (V6_NET in networks) throw disconnect;
  }
}

/**
 * Steps 1-10 of the probe (openspec holder-ipv6-probe). Each creating step pushes its undo onto
 * `undo` once attempted: the network once create returned its ID, the disconnect before the
 * connect, the probe container once run returned its ID.
 */
async function ipv6Probe(
  lifecycle: Ipv6Lifecycle,
  run: DockerOutput,
  image: string,
  ownership: Readonly<Record<string, string>>,
  undo: Undo[],
) {
  for (const [kind, name] of [
    ['network', V6_NET],
    ['container', V6_PROBE],
  ] as const)
    await lifecycle.registerResourceAsync(kind, name, ownership);
  const networks = Object.keys(await holderNetworks(run)).sort();
  const labels = Object.entries(ownership).flatMap(([key, value]) => [
    '--label',
    `${key}=${value}`,
  ]);
  // --internal: no gateway, so the holder's default route does not change.
  const networkId = (
    await run(['network', 'create', '--ipv6', '--internal', ...labels, V6_NET])
  ).trim();
  if (!DOCKER_ID.test(networkId))
    throw new Error(`IPv6 network create returned no ID: ${JSON.stringify(networkId)}`);
  undo.push(() => {
    lifecycle.removeNetwork(V6_NET, networkId);
  });
  undo.push(() => disconnectHolder(lifecycle.commandAsync, run));
  await run(['network', 'connect', V6_NET, DOCUMENT_SERVER_NET]);
  const endpoint = (await holderNetworks(run))[V6_NET];
  const address = endpoint === undefined ? undefined : record(endpoint).GlobalIPv6Address;
  if (typeof address !== 'string' || isIP(address) !== 6)
    throw new Error(
      `Document Server holder has no IPv6 address on ${V6_NET}: observed=${JSON.stringify(address)} family=${String(isIP(String(address)))} subnets=${await ipv6Subnets(run)}`,
    );
  const probe = ['--network', V6_NET, '--user', '1001', '--entrypoint', 'sleep', image, 'infinity'];
  const probeId = (await run(['run', '--detach', '--name', V6_PROBE, ...labels, ...probe])).trim();
  if (!DOCKER_ID.test(probeId))
    throw new Error(`IPv6 probe run returned no ID: ${JSON.stringify(probeId)}`);
  undo.push(() => removeProbe(lifecycle.commandAsync, probeId));
  const targets = [80, 8000].map((port) => ({ host: address, port, path: '/' }));
  const before = await dropCount(run);
  const inside = await reach(run, DOCUMENT_SERVER_NET, 'root', targets);
  const outside = await reach(run, V6_PROBE, '1001', targets);
  const after = await dropCount(run);
  const observed = { inside, outside, dropped: after > before };
  if (!isDeepStrictEqual(observed, IPV6_REACH))
    throw new Error(
      `Holder IPv6 reach differs: observed=${JSON.stringify(observed)} expected=${JSON.stringify(IPV6_REACH)} drops=${String(before)}->${String(after)} address=${address} family=6 subnets=${await ipv6Subnets(run)}`,
    );
  return { networks, seen: { address, inside, outside, dropped: { before, after } } };
}

/**
 * #654 AC4, once the Document Server has rejoined the holder: over an owned, internal IPv6
 * network, both ports answer inside the holder's namespace (root), while from an owned probe
 * container (uid 1001, `image`) 80 answers and 8000 times out as the holder's DROP counter rises.
 * The probe container, the connection and the network are removed in `finally` on every path;
 * the holder then has exactly its networks from before. Twenty docker calls at most, 30s each.
 */
export async function holderIpv6Reach(
  lifecycle: Ipv6Lifecycle,
  image: string,
  ownership: Readonly<Record<string, string>>,
) {
  const run: DockerOutput = async (args) =>
    output(await lifecycle.commandAsync(args, 30_000), args);
  const undo: Undo[] = [];
  const failures: unknown[] = [];
  let probed: Awaited<ReturnType<typeof ipv6Probe>> | undefined;
  try {
    probed = await ipv6Probe(lifecycle, run, image, ownership, undo);
  } catch (error) {
    failures.push(error);
  } finally {
    // Reverse order; each runs even after an earlier failure, and none masks the probe's own.
    for (const step of undo.reverse()) {
      try {
        await step();
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length > 1)
    throw new AggregateError(failures, 'Holder IPv6 probe and its cleanup failed');
  if (probed === undefined || failures.length === 1) throw failures[0];
  const networks = Object.keys(await holderNetworks(run)).sort();
  if (!isDeepStrictEqual(networks, probed.networks))
    throw new Error(
      `Holder networks differ after the IPv6 probe: before=${JSON.stringify(probed.networks)} after=${JSON.stringify(networks)}`,
    );
  return probed.seen;
}
