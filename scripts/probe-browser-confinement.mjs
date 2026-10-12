/** Read-only confinement witnesses and owned reachability controls for the real image. */
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile, readlink } from 'node:fs/promises';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import {
  browserDocker,
  inspectContainer,
  inspectNetwork,
  requireContainer,
  requireNetwork,
} from './probe-browser-network.mjs';

async function bridgeWitness(receipt) {
  const bridge = receipt.networkConfig.options['com.docker.network.bridge.name'];
  const result = spawnSync('/usr/sbin/ip', ['-j', 'address', 'show', 'dev', bridge], {
    encoding: 'utf8',
    timeout: 5000,
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
  const ifindex = Number(await readFile(`/sys/class/net/${bridge}/ifindex`, 'utf8'));
  if (!Number.isInteger(ifindex) || ifindex < 1 || rows[0].ifindex !== ifindex)
    throw new Error('browser owned bridge identity changed');
  return {
    bridge,
    linkLocal:
      rows[0].addr_info.find((address) => address.family === 'inet6' && address.scope === 'link')
        ?.local ?? null,
  };
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
async function openControl(host, controlHost) {
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
  server.listen(0, host);
  await once(server, 'listening');
  const port = server.address().port;
  const control = net.connect({ host: controlHost, port });
  control.on('error', (error) => {
    controlFailure ??= error;
  });
  try {
    await once(control, 'connect', { signal: AbortSignal.timeout(5000) });
  } catch (error) {
    control.destroy();
    for (const socket of sockets) socket.destroy();
    let cleanupFailure;
    try {
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
function privateWitness(receipt, targets, hostNamespace) {
  const source = `
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
    socket.once('connect', () => { socket.destroy(); reject(new Error('host reachable')); });
    socket.once('error', error => {
      socket.destroy();
      if (['ENETUNREACH','EHOSTUNREACH','EADDRNOTAVAIL'].includes(error.code)) resolve(true);
      else reject(error);
    });
    // Timeout is a failure, never a substitute for a witnessed unreachable path.
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('probe unsettled')); });
  });
}
(async () => {
  proof.hostIPv4Blocked = await blocked(${JSON.stringify(targets.ipv4)});
  proof.linkScopeIPv6Blocked = await blocked(${JSON.stringify(targets.ipv6)});
  process.stdout.write(JSON.stringify(proof));
})().catch(() => process.exit(1));
`;
  const proof = JSON.parse(
    browserDocker(['exec', receipt.containerId, 'node', '-e', source], 15000),
  );
  const fields = [
    'namespaceDistinct',
    'noIPv4DefaultRoute',
    'privateIPv4Present',
    'onlyLoopbackIPv6',
    'eth0IPv6Disabled',
    'hostIPv4Blocked',
    'linkScopeIPv6Blocked',
  ];
  if (fields.some((field) => proof[field] !== true) || Object.keys(proof).length !== fields.length)
    throw new Error('browser private confinement qualification failed');
  return proof;
}
async function probeConfinement(receipt, host, address, ipv4, ipv6) {
  const proof = privateWitness(
    receipt,
    {
      ipv4: { host: address, port: ipv4.port },
      ipv6: { host: `${host.linkLocal ?? 'fe80::1'}%eth0`, port: ipv6?.port ?? ipv4.port },
    },
    await readlink('/proc/self/ns/net'),
  );
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
export async function qualifyBrowserConfinement(receipt) {
  const container = inspectContainer(receipt.containerId);
  const network = inspectNetwork(receipt.networkId);
  if (!container || !network || !container.State?.Running)
    throw new Error('browser qualification resources unavailable');
  requireContainer(receipt, container);
  requireNetwork(receipt, network, container);
  if (Object.keys(network.Containers).length !== 1)
    throw new Error('browser isolated endpoint is not attached');
  const host = await bridgeWitness(receipt);
  const address = await hostIPv4();
  const ipv4 = await openControl('0.0.0.0', address);
  let ipv6;
  let result;
  let failure;
  try {
    if (host.linkLocal) ipv6 = await openControl('::', `${host.linkLocal}%${host.bridge}`);
    result = await probeConfinement(receipt, host, address, ipv4, ipv6);
  } catch (error) {
    failure = { error };
  }
  const cleanupErrors = [];
  for (const control of [ipv4, ipv6]) {
    try {
      await control?.close();
    } catch (error) {
      cleanupErrors.push(error);
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
