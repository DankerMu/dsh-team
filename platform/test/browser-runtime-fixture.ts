import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { watch } from 'node:fs';
import { lstat, mkdtemp, readFile, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Server, Socket } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { dockerProxyEnvironment } from '../../scripts/docker-proxy-environment.mjs';
import { openMappedPage, mappedFlags, closeMapped } from '../../scripts/probe-mapped-host.mjs';
import {
  browserDocker,
  isolatedBrowserRuntime,
  rescueChrome,
} from '../../scripts/probe-browser-runtime.mjs';
import type { MappedPageHandle } from '../../scripts/probe-mapped-host.mjs';
import type { IsolatedBrowserReceipt } from '../../scripts/probe-browser-runtime.mjs';
import { captureBrowserExecAuthority } from '../../scripts/probe-browser-exec.mjs';
import type { BrowserExecTarget } from '../../scripts/probe-browser-exec.mjs';
import { record } from './container-start-docker-fixture.ts';
import { beginVerificationBrowserExec } from '../../scripts/verification-submissions.mjs';

function document(text: string): Record<string, unknown> {
  const rows: unknown = JSON.parse(text);
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error('Owned resource document missing');
  return record(rows[0]);
}

async function observeBridgeAddress(bridge: string): Promise<number> {
  const result = spawnSync('/usr/sbin/ip', ['-j', '-4', 'address', 'show', 'dev', bridge], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 65536,
  });
  if (result.error || result.status !== 0)
    throw new Error('Independent owned host address witness unavailable');
  const selectedInterface = document(result.stdout);
  const addresses = selectedInterface.addr_info;
  if (
    selectedInterface.ifname !== bridge ||
    !Array.isArray(addresses) ||
    !addresses.some((value: unknown) => {
      const address = record(value);
      return address.family === 'inet' && typeof address.local === 'string';
    })
  )
    throw new Error('Owned host IPv4 transition not witnessed');
  const ifindex = Number(await readFile(`/sys/class/net/${bridge}/ifindex`, 'utf8'));
  if (!Number.isInteger(ifindex) || ifindex < 1 || selectedInterface.ifindex !== ifindex)
    throw new Error('Owned host interface identity changed');
  return ifindex;
}
export interface BrowserNamespaceProof {
  readonly hostTag: string;
  readonly privateTag: string;
  readonly imageId: string;
  readonly chromeSha256: string;
  readonly uid: number;
}
export interface OwnedHostTransition {
  readonly ownedBridge: true;
  readonly ipv4AddressObserved: true;
  readonly primaryMembershipPreserved: true;
  readonly networkTag: string;
  readonly bridgeTag: string;
  readonly ifindex: number;
  readonly observedMs: number;
  readonly clock: 'host-node-performance-ms';
}

async function retireBrowserFixture(
  server: Server,
  sockets: ReadonlySet<Socket>,
  browser: MappedPageHandle | undefined,
  receiptFile: string,
): Promise<unknown[]> {
  const failures: unknown[] = [];
  try {
    await closeMapped(browser?.page, browser?.chrome);
  } catch (error) {
    failures.push(error);
  }
  try {
    await rescueChrome(receiptFile);
  } catch (error) {
    failures.push(error);
  }
  for (const socket of sockets) socket.destroy();
  if (server.listening) {
    const { promise, resolve, reject } = Promise.withResolvers<undefined>();
    server.close((error) => {
      if (error) reject(error);
      else resolve(undefined);
    });
    try {
      await promise;
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

export async function withIsolatedBrowser<T>(
  server: Server,
  run: (
    browser: MappedPageHandle,
    origin: string,
    receipt: IsolatedBrowserReceipt,
    namespace: BrowserNamespaceProof,
  ) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-browser-regression-'));
  const receiptFile = join(root, 'chrome.receipt.json');
  let browser: MappedPageHandle | undefined;
  let failure: { error: unknown } | undefined;
  let result: { value: T } | undefined;
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  try {
    if (!server.listening) {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
    }
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Browser fixture original port missing');
    const host = 'dsh-team-first-use.invalid';
    const origin = `http://${host}:${String(address.port)}`;
    browser = await openMappedPage({
      origin,
      cookie: 'owned=private-fixture-cookie',
      extraFlags: mappedFlags(host),
      composition: true,
      runtime: isolatedBrowserRuntime(),
      profile: join(root, 'profile'),
      receiptFile,
    });
    const receipt = JSON.parse(await readFile(receiptFile, 'utf8')) as IsolatedBrowserReceipt;
    if (!/^[a-f0-9]{64}$/.test(receipt.containerId))
      throw new Error('Browser fixture immutable container identity missing');
    const privateNamespace = browserDocker([
      'exec',
      receipt.containerId,
      'node',
      '-e',
      "process.stdout.write(require('node:fs').readlinkSync('/proc/self/ns/net'))",
    ]);
    const hostNamespace = await readlink('/proc/self/ns/net');
    if (privateNamespace === hostNamespace)
      throw new Error('Browser network namespace was not separated');
    result = {
      value: await run(browser, origin, receipt, {
        hostTag: createHash('sha256').update(hostNamespace).digest('hex').slice(0, 12),
        privateTag: createHash('sha256').update(privateNamespace).digest('hex').slice(0, 12),
        imageId: receipt.imageId,
        chromeSha256: receipt.chromeSha256,
        uid: receipt.privateUid,
      }),
    };
  } catch (error) {
    failure = { error };
  }
  const failures = await retireBrowserFixture(server, sockets, browser, receiptFile);
  if (failures.length === 0) {
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    const all = failure ? [failure.error, ...failures] : failures;
    throw new AggregateError(
      all,
      'Browser regression cleanup incomplete; private receipt retained',
      { cause: all[0] },
    );
  }
  if (failure) throw failure.error;
  if (!result) throw new Error('Browser fixture outcome missing');
  return result.value;
}

export class OwnedBrowserChurn {
  readonly runId = randomUUID();
  readonly networks: { name: string; id: string; bridge: string }[] = [];
  helper: { name: string; id: string; imageId: string } | undefined;
  async createNetwork(suffix: string): Promise<{ name: string; id: string; bridge: string }> {
    const name = `dsh-team-browser-${this.runId}-${suffix}`;
    const bridge = `d179${this.runId.replaceAll('-', '').slice(0, 9)}${suffix.charAt(0)}`;
    try {
      await lstat(`/sys/class/net/${bridge}`);
      throw new Error('Refusing an existing host bridge');
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    const network = { name, id: '', bridge };
    this.networks.push(network);
    network.id = browserDocker([
      'network',
      'create',
      '--driver',
      'bridge',
      '--label',
      `dsh-team.test-run=${this.runId}`,
      '--opt',
      `com.docker.network.bridge.name=${bridge}`,
      name,
    ]);
    if (!/^[a-f0-9]{64}$/.test(network.id)) throw new Error('Owned bridge ID missing');
    return network;
  }
  async prepare(): Promise<void> {
    const primary = await this.createNetwork('primary');
    const { getuid, getgid } = process;
    if (!getuid || !getgid) throw new Error('Trusted Linux browser UID/GID unavailable');
    const runtime = isolatedBrowserRuntime();
    const name = `dsh-team-browser-${this.runId}-control`;
    this.helper = { name, id: '', imageId: runtime.imageId };
    this.helper.id = browserDocker([
      'create',
      '--name',
      name,
      '--label',
      `dsh-team.test-run=${this.runId}`,
      '--network',
      primary.id,
      '--user',
      `${String(getuid())}:${String(getgid())}`,
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--entrypoint',
      'node',
      runtime.imageId,
      '-e',
      "require('node:net').createServer(()=>{}).listen(12345,'127.0.0.1')",
    ]);
    browserDocker(['start', this.helper.id]);
  }
  async transition(): Promise<OwnedHostTransition> {
    if (!this.helper) throw new Error('Owned churn helper missing');
    const selected = await this.createNetwork('transition');
    browserDocker(['network', 'connect', selected.id, this.helper.id]);
    const inspected = document(browserDocker(['network', 'inspect', selected.id]));
    if (
      inspected.Id !== selected.id ||
      inspected.Name !== selected.name ||
      record(inspected.Labels)['dsh-team.test-run'] !== this.runId ||
      record(inspected.Options)['com.docker.network.bridge.name'] !== selected.bridge
    )
      throw new Error('Owned bridge identity mismatch');
    const ifindex = await observeBridgeAddress(selected.bridge);
    const helper = document(browserDocker(['container', 'inspect', this.helper.id]));
    const networks = Object.values(record(record(helper.NetworkSettings).Networks)).map((value) =>
      record(value),
    );
    const primary = this.networks[0];
    if (
      !primary ||
      networks.length !== 2 ||
      !networks.some((network) => network.NetworkID === primary.id) ||
      !networks.some((network) => network.NetworkID === selected.id)
    )
      throw new Error('Owned helper primary membership changed');
    return {
      ownedBridge: true,
      ipv4AddressObserved: true,
      primaryMembershipPreserved: true,
      networkTag: createHash('sha256').update(selected.id).digest('hex').slice(0, 12),
      bridgeTag: createHash('sha256').update(selected.bridge).digest('hex').slice(0, 12),
      ifindex,
      observedMs: performance.now(),
      clock: 'host-node-performance-ms',
    };
  }
  private retireHelper(): void {
    if (!this.helper) return;
    if (!this.helper.id)
      throw new Error('Owned helper creation unsettled; retaining registered authority');
    const helper = document(browserDocker(['container', 'inspect', this.helper.id]));
    const id = helper.Id;
    if (
      typeof id !== 'string' ||
      (this.helper.id !== '' && id !== this.helper.id) ||
      helper.Name !== `/${this.helper.name}` ||
      record(record(helper.Config).Labels)['dsh-team.test-run'] !== this.runId ||
      helper.Image !== this.helper.imageId
    )
      throw new Error('Refusing foreign helper cleanup');
    browserDocker(['rm', '--force', id]);
  }
  private retireNetwork(network: { name: string; id: string }): void {
    if (!network.id)
      throw new Error('Owned bridge creation unsettled; retaining registered authority');
    const inspected = document(browserDocker(['network', 'inspect', network.id]));
    const id = inspected.Id;
    if (
      typeof id !== 'string' ||
      (network.id !== '' && id !== network.id) ||
      inspected.Name !== network.name ||
      record(inspected.Labels)['dsh-team.test-run'] !== this.runId ||
      Object.keys(record(inspected.Containers)).length !== 0
    )
      throw new Error('Refusing foreign or occupied bridge cleanup');
    browserDocker(['network', 'rm', id]);
  }
  cleanup(): void {
    const failures: unknown[] = [];
    try {
      this.retireHelper();
    } catch (error) {
      failures.push(error);
    }
    for (const network of this.networks.slice().reverse()) {
      try {
        this.retireNetwork(network);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Owned churn cleanup incomplete');
    if (
      browserDocker([
        'network',
        'ls',
        '--filter',
        `label=dsh-team.test-run=${this.runId}`,
        '--quiet',
        '--no-trunc',
      ]) !== '' ||
      browserDocker([
        'container',
        'ls',
        '--all',
        '--filter',
        `label=dsh-team.test-run=${this.runId}`,
        '--quiet',
        '--no-trunc',
      ]) !== ''
    )
      throw new Error('Owned churn inventory remains');
  }
}
export async function execBrowser(
  target: BrowserExecTarget,
  source: string,
  onProgress?: (line: string) => void,
): Promise<string> {
  const authority = await captureBrowserExecAuthority(target);
  const publish = beginVerificationBrowserExec(authority);
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const child = spawn('docker', ['exec', authority.browser.containerId, 'node', '-e', source], {
    env: {
      PATH: process.env.PATH,
      DOCKER_CONFIG: process.env.DSH_TEAM_BROWSER_DOCKER_CONFIG,
      ...dockerProxyEnvironment(),
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let output = '';
  let outputBytes = 0;
  let failed = false;
  let failure: unknown;
  type FailureReason = 'callback' | 'timeout' | 'output-limit' | 'spawn' | 'exit';
  let failureReason: FailureReason | null = null;
  const fail = (error: unknown, reason: FailureReason) => {
    if (failed) return;
    failed = true;
    failure = error;
    failureReason = reason;
    child.kill('SIGKILL');
  };
  // This is a real external-process deadline, not a sleep; fake time cannot bound Docker.
  const timer = setTimeout(() => {
    fail(new Error('Owned browser protocol client timeout'), 'timeout');
  }, 15000);
  child.stdout.on('data', (data: Buffer) => {
    if (failed) return;
    outputBytes += data.length;
    output += data.toString();
    if (outputBytes > 65536) {
      fail(new Error('Owned browser protocol client output limit'), 'output-limit');
      return;
    }
    if (onProgress) {
      let newline: number;
      while ((newline = output.indexOf('\n')) !== -1) {
        const line = output.slice(0, newline);
        output = output.slice(newline + 1);
        try {
          onProgress(line);
        } catch (error) {
          fail(error, 'callback');
          return;
        }
      }
    }
  });
  child.once('error', (error) => {
    if (!failed) {
      failed = true;
      failure = error;
      failureReason = 'spawn';
    }
  });
  child.once('close', (code, signal) => {
    clearTimeout(timer);
    if (!failed && code !== 0) {
      failed = true;
      failure = new Error('Owned browser protocol client failed');
      failureReason = 'exit';
    }
    try {
      publish({ exitCode: code, signal, failure: failureReason });
    } catch (error) {
      // Preserve the original operation error; its retained publication fence is independent.
      reject(failed ? failure : error);
      return;
    }
    if (failed) reject(failure);
    else resolve(output);
  });
  return promise;
}

export function browserPressureClient(
  port: number,
  payloadBytes: number,
  producerHighWaterMark: number,
): string {
  return `
const net = require('node:net');
const { createHash } = require('node:crypto');
const totalBytes = ${String(payloadBytes)};
const socket = net.connect({
  host: '127.0.0.1', port: ${String(port)}, allowHalfOpen: true,
  highWaterMark: ${String(producerHighWaterMark)},
});
const hash = createHash('sha256');
let sentBytes = 0;
let backpressure = false;
let pressureSentBytes = 0;
let pressurePendingBytes = 0;
let ready = false;
let reply = '';
function produce() {
  while (sentBytes < totalBytes) {
    const chunk = Buffer.allocUnsafe(Math.min(65536, totalBytes - sentBytes));
    for (let offset = 0; offset < chunk.length; offset += 4)
      chunk.writeUInt32LE((sentBytes + offset) / 4, offset);
    sentBytes += chunk.length;
    hash.update(chunk);
    if (!socket.write(chunk)) {
      // Never queue past pressure: drain resumes this same finite transfer.
      socket.once('drain', produce);
      if (!backpressure) {
        backpressure = true;
        pressureSentBytes = sentBytes;
        pressurePendingBytes = socket.writableLength;
        process.stdout.write('pressure\\n');
      }
      return;
    }
  }
  socket.end();
}
socket.on('data', chunk => {
  reply += chunk.toString();
  if (!ready) {
    const newline = reply.indexOf('\\n');
    if (newline === -1) return;
    if (reply.slice(0, newline) !== 'receiver-paused') process.exit(1);
    ready = true;
    reply = reply.slice(newline + 1);
    produce();
  }
});
socket.on('end', () => {
  if (!ready || sentBytes !== totalBytes || !socket.writableFinished) process.exit(1);
  process.stdout.write(JSON.stringify({
    backpressure, pressureSentBytes, pressurePendingBytes, sentBytes,
    sha256: hash.digest('hex'), reply,
  }));
});
socket.on('error', () => process.exit(1));
`;
}
export async function awaitFile(path: string, signal = AbortSignal.timeout(15000)): Promise<void> {
  if (signal.aborted) throw signal.reason;
  const { promise, resolve, reject } = Promise.withResolvers<undefined>();
  // Real filesystem/process completion is bounded; this signal is not a guessed sleep.
  const aborted = () => {
    reject(new Error('Owned creation fixture completion missing'));
  };
  signal.addEventListener('abort', aborted, { once: true });
  const watcher = watch(dirname(path), { signal }, (_event, name) => {
    if (name === basename(path)) resolve(undefined);
  });
  watcher.once('error', reject);
  try {
    void lstat(path).then(
      () => {
        resolve(undefined);
      },
      (error: unknown) => {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT')
          reject(error);
      },
    );
    await promise;
    await lstat(path);
  } finally {
    watcher.close();
    signal.removeEventListener('abort', aborted);
  }
}
