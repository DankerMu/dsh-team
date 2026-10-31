import { deepStrictEqual } from 'node:assert';
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { setTimeout } from 'node:timers/promises';
import type { DockerCommand } from './docker-command.ts';
import {
  allocateSubnet,
  instanceAddressLayout,
  launchTokenPresent,
} from '../src/orchestrator/index.ts';

const configuredHost = 'dsh-team.test:3080';
const patchTarget = '/managed/patch.yml';
// RFC2544 benchmarking range: never a LAN or the platform's own instance pool.
const TEST_SUBNET_POOL = '198.18.0.0/15';

/** An invocation-owned /28 bridge holding exactly one Web container at its base+2 address. */
export interface WebNetwork {
  readonly name: string;
  readonly subnet: string;
}

/** The address DSH 0.2.1 binds: it accepts only the concrete host its overlay names. */
export function webAddress(network: WebNetwork): string {
  return instanceAddressLayout(network.subnet).container;
}

/**
 * Create one labelled /28 bridge from a fresh IPAM snapshot of every Docker network, so stale or
 * concurrent networks are excluded. The caller's registration precedes creation; a creation
 * conflict fails explicitly rather than retrying another subnet.
 */
export function createWebNetwork(
  command: DockerCommand,
  runId: string,
  suffix: string,
  register: (name: string, ownership: Readonly<Record<string, string>>) => void,
): WebNetwork {
  const docker = (args: string[]): string => webDocker(command, args);
  const ids = docker(['network', 'ls', '--quiet', '--no-trunc']).split('\n').filter(Boolean);
  const occupied =
    ids.length === 0
      ? []
      : docker([
          'network',
          'inspect',
          '--format',
          '{{range .IPAM.Config}}{{println .Subnet}}{{end}}',
          ...ids,
        ])
          .split('\n')
          .map((subnet) => subnet.trim())
          .filter(Boolean);
  const network = {
    name: `dsh-team-test-net-${runId}-${suffix}`,
    subnet: allocateSubnet(TEST_SUBNET_POOL, occupied),
  };
  const ownership = { 'dsh-team.test-run': runId };
  register(network.name, ownership);
  docker([
    'network',
    'create',
    '--driver',
    'bridge',
    '--subnet',
    network.subnet,
    '--label',
    `dsh-team.test-run=${runId}`,
    network.name,
  ]);
  return network;
}

export interface WebStartupBoundary {
  now: () => number;
  pause: (milliseconds: number) => Promise<void>;
  httpStatus: (port: number, authority: string, timeout: number) => Promise<number | null>;
}

/** GET only: no credentials, redirects, response body or error text enter evidence. */
function httpStatus(port: number, authority: string, timeout: number): Promise<number | null> {
  const { promise, resolve } = Promise.withResolvers<number | null>();
  const req = request(
    { hostname: '127.0.0.1', port, path: '/', method: 'GET', headers: { Host: authority } },
    (response) => {
      globalThis.clearTimeout(timer);
      resolve(response.statusCode ?? null);
      response.destroy();
    },
  );
  // An absolute timer also bounds a connection that never reaches socket inactivity timeout.
  const timer = globalThis.setTimeout(() => {
    resolve(null);
    req.destroy();
  }, timeout);
  req.once('close', () => {
    globalThis.clearTimeout(timer);
    resolve(null);
  });
  req.once('error', () => {
    globalThis.clearTimeout(timer);
    resolve(null);
  });
  req.end();
  return promise;
}

/** Observes the endpoint of an already-created container; never creates or starts it. */
export async function observeWebEndpoint(
  command: DockerCommand,
  container: string,
  inspectPort: () => number,
  authority: string,
  announced: (logs: string) => boolean,
  boundary: Partial<WebStartupBoundary> = {},
  deadline?: number,
): Promise<number> {
  const {
    now = () => performance.now(),
    pause = setTimeout,
    httpStatus: observeHttp = httpStatus,
  } = boundary;
  const endsAt = deadline ?? now() + 60_000;
  function remaining(): number {
    const left = endsAt - now();
    if (left <= 0) throw new Error('Web startup deadline exceeded (60s)');
    return Math.max(1, Math.floor(left));
  }
  for (;;) {
    remaining();
    const port = inspectPort();
    // Tail/output caps bound memory; genuine released launch lines never leave this scope.
    const logs = webDocker(command, ['logs', '--tail', '50', container], remaining());
    remaining();
    // HTTP routes may still be assembling before the released readiness announcement.
    if (!announced(logs)) {
      await pause(Math.min(250, remaining()));
      continue;
    }
    let status: number | null;
    try {
      status = await observeHttp(port, authority, Math.min(2_000, remaining()));
    } catch {
      throw new Error('Web HTTP observation failed');
    }
    remaining();
    if (status !== null && status !== 401)
      throw new Error('Unauthenticated DSH homepage must return 401');
    if (status === 401) return port;
    await pause(Math.min(250, remaining()));
  }
}

function processScript(trustedHost: string): string {
  return `
import json, os, pathlib, shutil
cli = os.path.realpath(shutil.which("dsh"))
expected = ["--profile", "web", "--patch", "/managed/patch.yml", "--no-open", "--trusted-host", ${JSON.stringify(trustedHost)}]
found = []
for entry in pathlib.Path("/proc").iterdir():
    if not entry.name.isdigit():
        continue
    try:
        argv = (entry / "cmdline").read_bytes().split(b"\\0")
        args = [part.decode() for part in argv if part]
        if len(args) < 2 or os.path.realpath(args[1]) != cli or args[2:] != expected:
            continue
        if pathlib.Path(os.readlink(entry / "exe")).name != "node":
            continue
        status = dict(line.split(":", 1) for line in (entry / "status").read_text().splitlines() if ":" in line)
        parent = int(status["PPid"])
        ancestor = int(entry.name)
        seen = set()
        while ancestor != 1:
            if ancestor in seen or ancestor <= 0:
                raise RuntimeError("not descended from container init")
            seen.add(ancestor)
            ancestor_status = dict(line.split(":", 1) for line in pathlib.Path(f"/proc/{ancestor}/status").read_text().splitlines() if ":" in line)
            ancestor = int(ancestor_status["PPid"])
        environment = (entry / "environ").read_bytes().split(b"\\0")
        # Confirm live CLI provenance before accepting any process metadata.
        if (entry / "cmdline").read_bytes().split(b"\\0") != argv:
            raise RuntimeError("process changed")
        found.append({"pid": int(entry.name), "parentPid": parent, "effectiveUid": int(status["Uid"].split()[1]), "telemetryDisabled": b"DSH_TELEMETRY_DISABLED=1" in environment})
    except FileNotFoundError:
        continue
print(json.dumps(found))
`;
}

export interface WebContainer {
  container: string;
  imageId: string;
  runId: string;
  stateVolume: string;
  workVolume: string;
  overlay: string;
  seccomp: string;
  /** Owned bridge; the caller's overlay names its base+2 address (or a legacy wildcard). */
  network: WebNetwork;
  trustedHost?: string;
  env?: Readonly<Record<string, string>>;
  /** Launch-line readiness; defaults to the released 0.2.1 line naming the base+2 address. */
  announced?: (logs: string) => boolean;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Malformed Web observation');
  }
  // The runtime check establishes an object with unknown-valued fields.
  return value as Record<string, unknown>;
}

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // JSON parse errors can contain raw input, including a launch token.
    throw new Error('Malformed Web observation JSON');
  }
}

function assertSecurity(host: Record<string, unknown>, seccomp: string): void {
  const security = host.SecurityOpt;
  // Docker versions normalize the supplied path into seccomp=<policy JSON> in inspect.
  if (!Array.isArray(security) || security.length !== 1 || typeof security[0] !== 'string') {
    throw new Error('Unexpected security options');
  }
  const option = security[0];
  if (!/^seccomp[=:]/.test(option)) throw new Error('Missing explicit seccomp');
  if (option !== `seccomp=${seccomp}`) {
    deepStrictEqual(json(option.replace(/^seccomp[=:]/, '')), json(readFileSync(seccomp, 'utf8')));
  }
  deepStrictEqual(host.CapAdd ?? [], []);
  if (host.Privileged !== false) throw new Error('Privileged container');
  for (const paths of [host.MaskedPaths, host.ReadonlyPaths]) {
    if (!Array.isArray(paths) || paths.length === 0) throw new Error('System paths relaxed');
  }
}

function assertMounts(value: unknown, expected: WebContainer): void {
  if (!Array.isArray(value) || value.length !== 3 || expected.stateVolume === expected.workVolume) {
    throw new Error('Wrong mounts');
  }
  const mounts = value.map(record);
  const volumes = [
    [expected.stateVolume, '/data/home'],
    [expected.workVolume, '/data/work'],
  ];
  for (const [name, destination] of volumes) {
    const mount = mounts.find((item) => item.Destination === destination);
    if (mount?.Type !== 'volume' || mount.Name !== name || mount.RW !== true) {
      throw new Error('Wrong volume');
    }
  }
  const overlay = mounts.find((item) => item.Destination === patchTarget);
  if (overlay?.Type !== 'bind' || overlay.Source !== expected.overlay || overlay.RW !== false) {
    throw new Error('Wrong overlay');
  }
}

function assertPublication(value: unknown, port: number): void {
  const publication = record(value);
  const published = publication['3080/tcp'];
  if (
    Object.keys(publication).length !== 1 ||
    !Array.isArray(published) ||
    published.length !== 1
  ) {
    throw new Error('Unexpected publication');
  }
  const configured = record(published[0]);
  if (
    configured.HostIp !== '127.0.0.1' ||
    !['', '0', String(port)].includes(String(configured.HostPort))
  ) {
    throw new Error('Unexpected publication');
  }
}

/** The container's single endpoint must be its owned network at the fixed base+2 address. */
function assertFixedAddress(value: unknown, expected: WebContainer): void {
  const networks = record(record(record(value).NetworkSettings).Networks);
  const endpoint: unknown = networks[expected.network.name];
  if (
    Object.keys(networks).length !== 1 ||
    typeof endpoint !== 'object' ||
    endpoint === null ||
    record(endpoint).IPAddress !== webAddress(expected.network)
  )
    throw new Error('Web requires its owned network at the base+2 address');
}

function portAndSettings(value: unknown, expected: WebContainer): number {
  const observed = record(value);
  const labels = record(record(observed.Config).Labels);
  if (observed.Image !== expected.imageId || labels['dsh-team.test-run'] !== expected.runId) {
    throw new Error('Web container image/ownership mismatch');
  }
  const ports = record(record(observed.NetworkSettings).Ports);
  const bindings = ports['3080/tcp'];
  if (!Array.isArray(bindings) || bindings.length !== 1 || Object.keys(ports).length !== 1) {
    throw new Error('Web requires a single loopback publication');
  }
  const binding = record(bindings[0]);
  const port = typeof binding.HostPort === 'string' ? Number(binding.HostPort) : NaN;
  if (binding.HostIp !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Web requires a valid loopback port');
  }
  assertFixedAddress(observed, expected);
  try {
    const host = record(observed.HostConfig);
    assertSecurity(host, expected.seccomp);
    assertPublication(host.PortBindings, port);
    assertMounts(observed.Mounts, expected);
  } catch {
    // Assertion diffs of boundary data must never escape into test reports.
    throw new Error('Web security, publication or distinct writable mounts mismatch');
  }
  return port;
}

function selectedProcess(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1)
    throw new Error('Actual DSH process missing or ambiguous');
  const process = record(value[0]);
  if (
    !Number.isSafeInteger(process.pid) ||
    Number(process.pid) < 1 ||
    !Number.isSafeInteger(process.parentPid) ||
    Number(process.parentPid) < 0 ||
    (process.pid === 1) !== (process.parentPid === 0)
  ) {
    throw new Error('Actual DSH process provenance missing');
  }
  if (!Number.isSafeInteger(process.effectiveUid) || Number(process.effectiveUid) <= 0) {
    throw new Error('Actual DSH process must be nonroot');
  }
  if (process.telemetryDisabled !== true)
    throw new Error('Actual DSH process telemetry must be disabled');
  return {
    pid: process.pid,
    parentPid: process.parentPid,
    effectiveUid: process.effectiveUid,
    telemetryDisabled: true,
  };
}

function webDocker(command: DockerCommand, args: string[], timeout = 30_000): string {
  let result;
  try {
    result = command(args, timeout);
  } catch {
    throw new Error(`Web Docker ${args[0] ?? 'operation'} failed`);
  }
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`Web Docker ${args[0] ?? 'operation'} failed`);
  }
  return result.stdout;
}

function createWebContainer(
  docker: (args: string[], timeout?: number) => string,
  expected: WebContainer,
  trustedHost: string,
): void {
  const envFlags = Object.entries(expected.env ?? {}).flatMap(([name, value]) => [
    '--env',
    `${name}=${value}`,
  ]);
  docker([
    'create',
    '--name',
    expected.container,
    '--label',
    `dsh-team.test-run=${expected.runId}`,
    '--security-opt',
    `seccomp=${expected.seccomp}`,
    '--network',
    expected.network.name,
    '--ip',
    webAddress(expected.network),
    '--publish',
    '127.0.0.1::3080',
    '--mount',
    `type=volume,source=${expected.stateVolume},target=/data/home`,
    '--mount',
    `type=volume,source=${expected.workVolume},target=/data/work`,
    '--mount',
    `type=bind,source=${expected.overlay},target=${patchTarget},readonly`,
    ...envFlags,
    expected.imageId,
    'dsh',
    '--profile',
    'web',
    '--patch',
    patchTarget,
    '--no-open',
    '--trusted-host',
    trustedHost,
  ]);
}

function assertOwnedVolumes(
  docker: (args: string[], timeout?: number) => string,
  expected: WebContainer,
): void {
  for (const volume of [expected.stateVolume, expected.workVolume]) {
    if (
      docker([
        'volume',
        'inspect',
        '--format',
        '{{ index .Labels "dsh-team.test-run" }}',
        volume,
      ]).trim() !== expected.runId
    ) {
      throw new Error('Web volume ownership mismatch');
    }
  }
}

/** The single host the accepted launch line(s) name; the token never leaves this scope. */
function launchHost(logs: string): string {
  const hosts = new Set(
    [...logs.matchAll(/^dsh web: http:\/\/([^\s/]+):3080\/\?token=/gm)].map((match) => match[1]),
  );
  const [host] = hosts;
  if (hosts.size !== 1 || host === undefined) throw new Error('Ambiguous Web launch announcement');
  return host;
}

/**
 * Starts an overlay DSH must refuse and requires a nonzero exit within 60s with no launch URL.
 * Logs are judged in memory only; called after the owner registers container/volumes/network.
 */
export async function runWebRejection(
  command: DockerCommand,
  expected: WebContainer,
  boundary: Partial<WebStartupBoundary> = {},
): Promise<string> {
  const { now = () => performance.now(), pause = setTimeout } = boundary;
  const docker = (args: string[], timeout = 30_000): string => webDocker(command, args, timeout);
  assertOwnedVolumes(docker, expected);
  createWebContainer(docker, expected, expected.trustedHost ?? configuredHost);
  const deadline = now() + 60_000;
  function remaining(): number {
    const left = deadline - now();
    if (left <= 0) throw new Error('Web rejection deadline exceeded (60s)');
    return Math.max(1, Math.floor(left));
  }
  docker(['start', expected.container], remaining());
  let state: Record<string, unknown>;
  for (;;) {
    const observed = record(
      json(
        docker(['container', 'inspect', '--format', '{{json .}}', expected.container], remaining()),
      ),
    );
    if (
      observed.Image !== expected.imageId ||
      record(record(observed.Config).Labels)['dsh-team.test-run'] !== expected.runId
    )
      throw new Error('Web container image/ownership mismatch');
    state = record(observed.State);
    if (state.Running === false && state.Status === 'exited') break;
    await pause(Math.min(250, remaining()));
  }
  const elapsedMs = 60_000 - remaining();
  if (typeof state.ExitCode !== 'number' || state.ExitCode === 0)
    throw new Error('Refused Web overlay must exit nonzero');
  const logs = command(['logs', '--tail', '50', expected.container], remaining());
  if (logs.error !== undefined || logs.status !== 0) throw new Error('Web Docker logs failed');
  if ([logs.stdout, logs.stderr].some((text) => /^dsh web: http/m.test(text)))
    throw new Error('Refused Web overlay announced a launch URL');
  return JSON.stringify({ exited: true, exitCode: state.ExitCode, launchLine: false, elapsedMs });
}

/** Read-only fixture probes retain the startup identity, security and mount guards. */
export function execWebScript(
  command: DockerCommand,
  expected: WebContainer,
  script: string,
): string {
  const docker = (args: string[], timeout = 30_000): string => webDocker(command, args, timeout);
  assertOwnedVolumes(docker, expected);
  const inspect = (): number => {
    const snapshot = record(
      json(docker(['container', 'inspect', '--format', '{{json .}}', expected.container])),
    );
    if (record(snapshot.State).Running !== true) throw new Error('DSH Web exited during probe');
    return portAndSettings(snapshot, expected);
  };
  const port = inspect();
  const result = docker(
    ['exec', '--user', '1001', expected.container, 'node', '--input-type=module', '-e', script],
    15_000,
  );
  if (inspect() !== port) throw new Error('Web publication changed during probe');
  return result;
}

/** Called only after the canonical owner registers container/volumes; returns sanitized facts. */
export async function runWebStartup(
  command: DockerCommand,
  expected: WebContainer,
  boundary: Partial<WebStartupBoundary> = {},
): Promise<string> {
  const now = boundary.now ?? (() => performance.now());
  const trustedHost = expected.trustedHost ?? configuredHost;
  const docker = (args: string[], timeout = 30_000): string => webDocker(command, args, timeout);
  assertOwnedVolumes(docker, expected);
  createWebContainer(docker, expected, trustedHost);
  const started = now();
  const deadline = started + 60_000;
  function remaining(): number {
    const left = deadline - now();
    if (left <= 0) throw new Error('Web startup deadline exceeded (60s)');
    return Math.max(1, Math.floor(left));
  }
  function bounded(args: string[]): string {
    const text = docker(args, remaining());
    remaining();
    return text;
  }
  bounded(['start', expected.container]);
  const address = webAddress(expected.network);
  const inspect = () => {
    const snapshot = record(
      json(bounded(['container', 'inspect', '--format', '{{json .}}', expected.container])),
    );
    if (record(snapshot.State).Running !== true)
      throw new Error('DSH Web exited before acceptance');
    return portAndSettings(snapshot, expected);
  };
  const announced = expected.announced ?? ((logs) => launchTokenPresent(logs, address));
  let announcement = '';
  const port = await observeWebEndpoint(
    command,
    expected.container,
    inspect,
    trustedHost,
    (logs) => {
      const seen = announced(logs);
      if (seen) announcement = logs;
      return seen;
    },
    { ...boundary, now },
    deadline,
  );
  const announcedHost = launchHost(announcement);
  const process = selectedProcess(
    json(bounded(['exec', expected.container, 'python3', '-c', processScript(trustedHost)])),
  );
  if (inspect() !== port) throw new Error('Web publication changed during acceptance');
  const elapsedMs = 60_000 - remaining();
  return JSON.stringify({
    tokenSeen: true,
    elapsedMs,
    httpStatus: 401,
    configuredHost: trustedHost,
    hostPort: port,
    announcedHost,
    subnet: expected.network.subnet,
    ...process,
  });
}
