/** Read-only confinement witnesses and owned reachability controls for the real image. */
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile, readlink } from 'node:fs/promises';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';
import {
  dockerEnvironment,
  inspectContainer,
  inspectNetwork,
  requireContainer,
  requireNetwork,
} from './probe-browser-network.mjs';
import { qualificationError } from './probe-browser-qualification.mjs';

function remainingControlMs(deadline) {
  const remaining = deadline.until - performance.now();
  if (deadline.signal.aborted || remaining <= 0)
    throw qualificationError('ETIMEDOUT', 'host-ipv6-control');
  return Math.max(1, Math.floor(remaining));
}
function linkLocalWitness(addresses, selected) {
  const address = addresses.find(
    (value) =>
      value.family === 'inet6' &&
      value.scope === 'link' &&
      (selected === undefined || value.local === selected),
  );
  if (!address) return { linkLocal: null, tentative: false, dadfailed: false };
  if (typeof address.local !== 'string' || !address.local)
    throw new Error('browser owned link-local identity unavailable');
  if (
    ['tentative', 'dadfailed'].some(
      (flag) => Object.hasOwn(address, flag) && typeof address[flag] !== 'boolean',
    )
  )
    throw new Error('browser owned link-local state unavailable');
  return {
    linkLocal: address.local,
    tentative: address.tentative === true,
    dadfailed: address.dadfailed === true,
  };
}
async function usableLinkLocal(receipt, original, deadline) {
  if (original.dadfailed) throw qualificationError('IPV6_DAD_FAILED', 'host-ipv6-control');
  for (;;) {
    const current = await bridgeWitness(receipt, deadline, original.linkLocal);
    if (current.bridge !== original.bridge || current.ifindex !== original.ifindex)
      throw qualificationError('BRIDGE_IDENTITY_CHANGED', 'host-ipv6-control');
    if (current.linkLocal !== original.linkLocal)
      throw qualificationError('IPV6_ADDRESS_DISAPPEARED', 'host-ipv6-control');
    if (current.dadfailed) throw qualificationError('IPV6_DAD_FAILED', 'host-ipv6-control');
    remainingControlMs(deadline);
    if (!current.tentative) return current;
    // The existing 50ms readiness cadence is conditional on this exact address's DAD.
    await wait(Math.min(50, remainingControlMs(deadline)), undefined, {
      signal: deadline.signal,
    });
  }
}
async function openIpv6Control(receipt, original) {
  const deadline = { until: performance.now() + 5000, signal: AbortSignal.timeout(5000) };
  const ready = await usableLinkLocal(receipt, original, deadline);
  return await openControl('::', `${ready.linkLocal}%${ready.bridge}`, deadline);
}

async function bridgeWitness(receipt, deadline, selected) {
  const bridge = receipt.networkConfig.options['com.docker.network.bridge.name'];
  const result = spawnSync('/usr/sbin/ip', ['-j', 'address', 'show', 'dev', bridge], {
    encoding: 'utf8',
    timeout: deadline ? remainingControlMs(deadline) : 5000,
    maxBuffer: 65536,
  });
  if (result.error || result.status !== 0)
    throw new Error('browser host bridge witness unavailable');
  const rows = JSON.parse(result.stdout);
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    rows[0].ifname !== bridge ||
    !Array.isArray(rows[0].addr_info) ||
    rows[0].addr_info.some((address) => address.family === 'inet')
  )
    throw new Error('browser isolated bridge has an IPv4 gateway address');
  const ifindex = Number(
    await readFile(
      `/sys/class/net/${bridge}/ifindex`,
      deadline ? { encoding: 'utf8', signal: deadline.signal } : 'utf8',
    ),
  );
  if (!Number.isInteger(ifindex) || ifindex < 1 || rows[0].ifindex !== ifindex)
    throw new Error('browser owned bridge identity changed');
  return { bridge, ifindex, ...linkLocalWitness(rows[0].addr_info, selected) };
}
async function hostIPv4() {
  const route = (await readFile('/proc/net/route', 'utf8'))
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .find((row) => row[1] === '00000000');
  const address = networkInterfaces()[route?.[0]]?.find(
    (value) => value.family === 'IPv4' && !value.internal,
  );
  if (!address) throw new Error('browser host IPv4 confinement control unavailable');
  return address.address;
}
async function listenControl(server, host, deadline) {
  if (!deadline) {
    server.listen(0, host);
    await once(server, 'listening');
    return;
  }
  const controller = new AbortController();
  const abort = () => controller.abort(deadline.signal.reason);
  const { promise: closed, resolve: closedResolve } = Promise.withResolvers();
  let listenerFailure;
  const listenerError = (error) => {
    listenerFailure ??= error;
  };
  // once(..., { signal }) relinquishes error ownership on abort; keep it until close.
  server.on('error', listenerError);
  server.once('close', closedResolve);
  deadline.signal.addEventListener('abort', abort, { once: true });
  let submitted = false;
  try {
    remainingControlMs(deadline);
    submitted = true;
    // Cancel the listen operation itself, not just the promise awaiting its readiness.
    server.listen({ port: 0, host, signal: controller.signal });
    await once(server, 'listening', { signal: deadline.signal });
  } catch (error) {
    let cleanupFailure;
    try {
      controller.abort();
      if (submitted) {
        // Also settle failed binds; close() without a callback permits already-unbound servers.
        server.close();
        await closed;
      } else {
        server.removeListener('close', closedResolve);
        closedResolve();
      }
    } catch (cleanup) {
      cleanupFailure = { error: cleanup };
    }
    const secondary = [];
    if (listenerFailure && listenerFailure !== error) secondary.push(listenerFailure);
    if (cleanupFailure) secondary.push(cleanupFailure.error);
    if (secondary.length)
      throw new AggregateError([error, ...secondary], 'browser listener setup and cleanup failed', {
        cause: error,
      });
    throw error;
  } finally {
    // A successful listener lives through the probes; the budget still bounds connect.
    deadline.signal.removeEventListener('abort', abort);
    server.removeListener('error', listenerError);
  }
}

async function openControl(host, controlHost, deadline) {
  const sockets = new Set();
  let controlFailure;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', (error) => {
      controlFailure ??= error;
      socket.destroy();
    });
    socket.once('close', () => sockets.delete(socket));
  });
  let port;
  let control;
  try {
    if (deadline) remainingControlMs(deadline);
    await listenControl(server, host, deadline);
    port = server.address().port;
    if (deadline) remainingControlMs(deadline);
    control = net.connect({ host: controlHost, port });
    control.on('error', (error) => {
      controlFailure ??= error;
    });
    await once(control, 'connect', {
      signal: deadline ? deadline.signal : AbortSignal.timeout(5000),
    });
    if (deadline) remainingControlMs(deadline);
  } catch (error) {
    control?.destroy();
    for (const socket of sockets) socket.destroy();
    let cleanupFailure;
    try {
      if (server.listening)
        await new Promise((done, reject) =>
          server.close((cleanup) => (cleanup ? reject(cleanup) : done())),
        );
    } catch (cleanup) {
      cleanupFailure = { error: cleanup };
    }
    if (cleanupFailure) {
      throw new AggregateError(
        [error, cleanupFailure.error],
        'browser reachability control and cleanup failed',
        { cause: error },
      );
    }
    throw error;
  }
  control.destroy();
  return {
    port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
      if (controlFailure) throw new Error('browser owned reachability control failed');
    },
  };
}
function reportedProbeFailure(result, envelope) {
  const error = qualificationError(
    envelope?.failure?.code ?? 'PRIVATE_PROCESS_FAILED',
    envelope?.failure?.phase ?? 'private-probe-execution',
  );
  error.qualificationOutcome = result.status === 0 ? 'successful-exit' : 'nonzero-exit';
  return error;
}
function probeEnvelope(result) {
  if (result.error) {
    const error = qualificationError(
      result.error.code === 'ETIMEDOUT' ? 'PRIVATE_PROCESS_TIMEOUT' : 'PRIVATE_PROCESS_FAILED',
      'private-probe-execution',
    );
    error.cause = result.error;
    error.qualificationOutcome = 'process-error';
    throw error;
  }
  if (result.signal) throw qualificationError('PRIVATE_PROCESS_SIGNAL', 'private-probe-execution');
  let envelope;
  try {
    envelope = JSON.parse(result.stdout);
  } catch {
    throw qualificationError(
      result.status === 0 ? 'PRIVATE_JSON_INVALID' : 'PRIVATE_PROCESS_FAILED',
      'private-probe-execution',
    );
  }
  if (result.status !== 0 || envelope?.failure) throw reportedProbeFailure(result, envelope);
  return envelope;
}
function privateWitness(receipt, targets, hostNamespace, diagnostic) {
  diagnostic.enter('private-probe-execution');
  const source = `
let phase = 'private-state';
(async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const net = require('node:net');
  const routes = fs.readFileSync('/proc/net/route','utf8').trim().split('\\n').slice(1);
  const interfaces = os.networkInterfaces();
  const proof = {
    namespaceDistinct: fs.readlinkSync('/proc/self/ns/net') !== ${JSON.stringify(hostNamespace)},
    noIPv4DefaultRoute: !routes.some(line => line.trim().split(/\\s+/)[1] === '00000000'),
    privateIPv4Present: (interfaces.eth0 || []).some(address => address.family === 'IPv4'),
    onlyLoopbackIPv6: Object.entries(interfaces).every(([name, addresses]) =>
      name === 'lo' || addresses.every(address => address.family !== 'IPv6')),
    eth0IPv6Disabled: fs.readFileSync('/proc/sys/net/ipv6/conf/eth0/disable_ipv6','utf8').trim() === '1',
  };
  async function blocked(target) {
    return await new Promise((resolve, reject) => {
      const socket = net.connect(target);
      socket.once('connect', () => {
        socket.destroy();
        const error = new Error('host reachable'); error.code = 'HOST_REACHABLE';
        reject(error);
      });
      socket.once('error', error => {
        socket.destroy();
        if (['ENETUNREACH','EHOSTUNREACH','EADDRNOTAVAIL'].includes(error.code)) resolve(true);
        else reject(error);
      });
      // Timeout remains failure, never a substitute for a witnessed unreachable path.
      socket.setTimeout(3000, () => {
        socket.destroy();
        const error = new Error('probe unsettled'); error.code = 'PROBE_TIMEOUT';
        reject(error);
      });
    });
  }
  phase = 'private-ipv4-probe';
  proof.hostIPv4Blocked = await blocked(${JSON.stringify(targets.ipv4)});
  phase = 'private-ipv6-probe';
  proof.linkScopeIPv6Blocked = await blocked(${JSON.stringify(targets.ipv6)});
  process.stdout.write(JSON.stringify({ proof }));
})().catch(error => {
  const allowed = ['EACCES','EPERM','ENOENT','EINVAL','ENODEV','ENETUNREACH','EHOSTUNREACH',
    'EADDRNOTAVAIL','ECONNREFUSED','ECONNRESET','EPIPE','EAFNOSUPPORT','EPROTONOSUPPORT',
    'ENOTFOUND','EAI_AGAIN','EAI_FAIL','HOST_REACHABLE','PROBE_TIMEOUT'];
  process.stdout.write(JSON.stringify({ failure: {
    phase, code: allowed.includes(error?.code) ? error.code : 'UNKNOWN',
  } }), () => process.exit(1));
});
`;
  const result = spawnSync('docker', ['exec', receipt.containerId, 'node', '-e', source], {
    env: dockerEnvironment(),
    encoding: 'utf8',
    timeout: 15000,
    killSignal: 'SIGKILL',
    maxBuffer: 65536,
  });
  const envelope = probeEnvelope(result);
  diagnostic.enter('private-proof-invariants');
  const proof = envelope?.proof;
  const fields = [
    'namespaceDistinct',
    'noIPv4DefaultRoute',
    'privateIPv4Present',
    'onlyLoopbackIPv6',
    'eth0IPv6Disabled',
    'hostIPv4Blocked',
    'linkScopeIPv6Blocked',
  ];
  const failed = fields.filter((field) => proof?.[field] !== true);
  if (failed.length || !proof || Object.keys(proof).length !== fields.length)
    throw qualificationError('PRIVATE_PROOF_INVALID', 'private-proof-invariants', failed);
  return proof;
}
async function probeConfinement(receipt, host, address, ipv4, ipv6, diagnostic) {
  const proof = privateWitness(
    receipt,
    {
      ipv4: { host: address, port: ipv4.port },
      ipv6: { host: `${host.linkLocal ?? 'fe80::1'}%eth0`, port: ipv6?.port ?? ipv4.port },
    },
    await readlink('/proc/self/ns/net'),
    diagnostic,
  );
  diagnostic.enter('final-resource-identity');
  const finalContainer = inspectContainer(receipt.containerId);
  const finalNetwork = inspectNetwork(receipt.networkId);
  if (!finalContainer || !finalNetwork) throw new Error('browser qualification identity changed');
  requireContainer(receipt, finalContainer);
  requireNetwork(receipt, finalNetwork, finalContainer);
  return {
    ...proof,
    hostBridgeNoIPv4: true,
    stableAttachment: true,
    linkLocalHostControlAvailable: Boolean(ipv6),
  };
}
export async function qualifyBrowserConfinement(
  receipt,
  diagnostic = {
    enter: () => undefined,
    fail: () => undefined,
    cleanup: () => undefined,
  },
) {
  diagnostic.enter('resource-identity');
  const container = inspectContainer(receipt.containerId);
  const network = inspectNetwork(receipt.networkId);
  if (!container || !network || !container.State?.Running)
    throw new Error('browser qualification resources unavailable');
  requireContainer(receipt, container);
  requireNetwork(receipt, network, container);
  if (Object.keys(network.Containers).length !== 1)
    throw new Error('browser isolated endpoint is not attached');
  diagnostic.enter('bridge-witness');
  const host = await bridgeWitness(receipt);
  diagnostic.enter('host-ipv4-control');
  const address = await hostIPv4();
  const ipv4 = await openControl('0.0.0.0', address);
  let ipv6;
  let result;
  let failure;
  try {
    if (host.linkLocal) {
      diagnostic.enter('host-ipv6-control');
      ipv6 = await openIpv6Control(receipt, host);
    }
    result = await probeConfinement(receipt, host, address, ipv4, ipv6, diagnostic);
  } catch (error) {
    diagnostic.fail(error);
    failure = { error };
  }
  const cleanupErrors = [];
  diagnostic.enter('control-cleanup');
  for (const control of [ipv4, ipv6]) {
    try {
      await control?.close();
    } catch (error) {
      cleanupErrors.push(error);
      diagnostic.cleanup(error, 'control-cleanup');
    }
  }
  if (failure) {
    if (cleanupErrors.length)
      throw new AggregateError(
        [failure.error, ...cleanupErrors],
        'browser confinement and cleanup failed',
        {
          cause: failure.error,
        },
      );
    throw failure.error;
  }
  if (cleanupErrors.length)
    throw new AggregateError(cleanupErrors, 'browser confinement cleanup failed');
  return result;
}
