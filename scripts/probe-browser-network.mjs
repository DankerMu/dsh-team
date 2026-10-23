/** Exact Docker ownership for a dedicated verification-browser isolated bridge. */
import { spawnSync } from 'node:child_process';
import { writeReceipt } from './probe-browser-receipt.mjs';
import { dockerProxyEnvironment } from './docker-proxy-environment.mjs';
import { runDockerCommand, selectDockerExecution } from './docker-command.mjs';

const RESOURCE_ID = /^[a-f0-9]{64}$/;
export const OWNER = 'dsh-team.test-run';
export const NONCE = 'dsh-team.browser-nonce';
export const ROLE = 'dsh-team.role';
export const dockerEnvironment = () => ({
  PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
  DOCKER_CONFIG: process.env.DSH_TEAM_BROWSER_DOCKER_CONFIG ?? '/nonexistent-dsh-browser-config',
  ...dockerProxyEnvironment(),
});
export function browserDocker(args, ms = 30000) {
  const result = runDockerCommand(selectDockerExecution(args), (execution) =>
    spawnSync(execution.file, execution.args, {
      env: dockerEnvironment(),
      encoding: 'utf8',
      timeout: ms,
      killSignal: 'SIGKILL',
      maxBuffer: 65536,
    }),
  );
  if (result.error || result.status !== 0) throw new Error('browser Docker operation failed');
  return result.stdout.trim();
}
function inspectResource(kind, target, ms = 30000) {
  const result = runDockerCommand(selectDockerExecution([kind, 'inspect', target]), (execution) =>
    spawnSync(execution.file, execution.args, {
      env: dockerEnvironment(),
      encoding: 'utf8',
      timeout: ms,
      killSignal: 'SIGKILL',
      maxBuffer: 65536,
    }),
  );
  const diagnostic = result.stderr?.trim();
  const missing =
    kind === 'container'
      ? [
          `Error response from daemon: No such container: ${target}`,
          `Error: No such container: ${target}`,
          `Error response from daemon: No such object: ${target}`,
          `Error: No such object: ${target}`,
        ]
      : [
          `Error response from daemon: network ${target} not found`,
          `Error: No such network: ${target}`,
          `Error response from daemon: No such network: ${target}`,
        ];
  if (
    !result.error &&
    result.status === 1 &&
    ['', '[]'].includes(result.stdout.trim()) &&
    missing.includes(diagnostic)
  )
    return null;
  if (result.error || result.status !== 0) throw new Error('browser Docker inspection failed');
  const rows = JSON.parse(result.stdout);
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== 'object')
    throw new Error('browser Docker identity invalid');
  return rows[0];
}
export const inspectContainer = (target) => inspectResource('container', target);
export const inspectNetwork = (target, ms = 30000) => inspectResource('network', target, ms);

export function networkRegistration(nonce) {
  return {
    networkId: null,
    networkName: `dsh-team-browser-net-${nonce}`,
    networkConfig: {
      driver: 'bridge',
      internal: true,
      enableIPv6: false,
      options: {
        'com.docker.network.bridge.gateway_mode_ipv4': 'isolated',
        'com.docker.network.bridge.name': `d179${nonce.replaceAll('-', '').slice(0, 11)}`,
      },
    },
  };
}
export function requireNetworkAuthority(receipt) {
  const expected = networkRegistration(receipt.nonce);
  if (
    receipt.networkName !== expected.networkName ||
    !Object.hasOwn(receipt, 'networkId') ||
    (receipt.networkId !== null && !RESOURCE_ID.test(receipt.networkId))
  )
    throw new Error('browser isolated network authority missing or changed');
  requireConfiguration(receipt.networkConfig, expected.networkConfig);
}
export function networkCreateArgs(receipt) {
  requireNetworkAuthority(receipt);
  return [
    'network',
    'create',
    '--driver',
    'bridge',
    '--internal',
    '--ipv6=false',
    '--label',
    `${OWNER}=${receipt.runId}`,
    '--label',
    `${NONCE}=${receipt.nonce}`,
    '--label',
    `${ROLE}=verification-browser-network`,
    ...Object.entries(receipt.networkConfig.options).flatMap(([key, value]) => [
      '--opt',
      `${key}=${value}`,
    ]),
    receipt.networkName,
  ];
}
function requireConfiguration(actual, expected) {
  if (
    !actual ||
    actual.driver !== expected.driver ||
    actual.internal !== true ||
    actual.enableIPv6 !== false ||
    !actual.options ||
    Object.keys(actual.options).length !== Object.keys(expected.options).length ||
    Object.entries(expected.options).some(([key, value]) => actual.options[key] !== value)
  )
    throw new Error('browser isolated network configuration changed');
}
function attachmentDeclaration(receipt, container, networkId) {
  const networks = container.NetworkSettings?.Networks;
  if (!networks || typeof networks !== 'object' || Array.isArray(networks))
    throw new Error('browser isolated attachment inventory unavailable');
  if (container.HostConfig?.NetworkMode !== networkId)
    throw new Error('browser isolated attachment declaration mismatch');
  const attachments = Object.entries(networks);
  if (attachments.length === 0 && confirmedStopped(container)) return null;
  if (attachments.length !== 1) throw new Error('browser isolated attachment declaration mismatch');
  const key = attachments[0][0];
  const created = container.State?.Status === 'created';
  if (key !== receipt.networkName && (!created || key !== networkId))
    throw new Error('browser isolated attachment declaration mismatch');
  return attachments[0][1];
}
function confirmedStopped(container) {
  return container.State?.Running === false && container.State.Status === 'exited';
}
function requireAttachment(receipt, container, networkId) {
  const endpoint = attachmentDeclaration(receipt, container, networkId);
  if (endpoint === null) return;
  // Docker may not assign an endpoint ID until start; the configured network stays exact.
  const pending =
    ['created', 'exited'].includes(container.State?.Status) &&
    container.State.Running === false &&
    endpoint.NetworkID === '';
  if (
    (!pending && endpoint.NetworkID !== networkId) ||
    endpoint.Gateway ||
    endpoint.IPv6Gateway ||
    endpoint.GlobalIPv6Address
  )
    throw new Error('browser isolated attachment identity mismatch');
}
export function requireNetwork(receipt, object, container = null) {
  requireNetworkAuthority(receipt);
  const labels = object.Labels ?? {};
  const expected = receipt.networkConfig;
  if (
    !RESOURCE_ID.test(object.Id ?? '') ||
    (receipt.networkId !== null && object.Id !== receipt.networkId) ||
    object.Name !== receipt.networkName ||
    object.Scope !== 'local' ||
    labels[OWNER] !== receipt.runId ||
    labels[NONCE] !== receipt.nonce ||
    labels[ROLE] !== 'verification-browser-network'
  )
    throw new Error('browser isolated network identity mismatch; refusing cleanup');
  requireConfiguration(
    {
      driver: object.Driver,
      internal: object.Internal,
      enableIPv6: object.EnableIPv6,
      options: object.Options,
    },
    expected,
  );
  requireEndpoints(receipt, object, container);
  return object.Id;
}
function requireEndpoints(receipt, object, container) {
  if (
    !object.Containers ||
    typeof object.Containers !== 'object' ||
    Array.isArray(object.Containers)
  )
    throw new Error('browser network endpoints unavailable');
  const peers = Object.entries(object.Containers);
  if (
    peers.some(
      ([id, peer]) => !container || id !== container.Id || peer.Name !== receipt.containerName,
    )
  )
    throw new Error('browser isolated network has unexpected peers; refusing cleanup');
  if (container?.State?.Running && !Object.hasOwn(object.Containers, container.Id))
    throw new Error('browser running isolated endpoint is missing');
  if (container) requireAttachment(receipt, container, object.Id);
}
export function requireContainer(receipt, object) {
  const labels = object.Config?.Labels ?? {};
  if (
    !RESOURCE_ID.test(object.Id ?? '') ||
    object.Name !== `/${receipt.containerName}` ||
    labels[OWNER] !== receipt.runId ||
    labels[NONCE] !== receipt.nonce ||
    labels[ROLE] !== 'verification-browser' ||
    object.Image !== receipt.imageId ||
    object.Config?.Image !== receipt.imageId ||
    (receipt.containerId !== null && object.Id !== receipt.containerId)
  )
    throw new Error('browser container identity mismatch; refusing cleanup');
  return object.Id;
}
function inspectRecorded(receipt, kind) {
  const id = receipt[`${kind}Id`];
  const name = receipt[`${kind}Name`];
  const object = inspectResource(kind, id ?? name);
  if (object === null && id && inspectResource(kind, name) !== null)
    throw new Error(`browser recorded ${kind} identity mismatch`);
  if (object && id === null && receipt.state === 'stopped')
    throw new Error(`browser finalized absent ${kind} identity changed; refusing adoption`);
  return object;
}
export async function preflightResources(path, receipt) {
  requireNetworkAuthority(receipt);
  const container = inspectRecorded(receipt, 'container');
  const network = inspectRecorded(receipt, 'network');
  if (container) requireContainer(receipt, container);
  if (network) requireNetwork(receipt, network, container);
  else if (container) throw new Error('browser acquired container has no isolated network');
  // Validate both resources and every peer before recording adoption or mutating either.
  if ((container && receipt.containerId === null) || (network && receipt.networkId === null)) {
    if (receipt.state !== 'pending-identity')
      throw new Error('browser pending resource authority missing');
    if (container) receipt.containerId = container.Id;
    if (network) receipt.networkId = network.Id;
    await writeReceipt(path, receipt);
  }
  return { container, network };
}
export function retireNetwork(receipt) {
  const network = inspectRecorded(receipt, 'network');
  if (!network) return;
  requireNetwork(receipt, network);
  browserDocker(['network', 'rm', network.Id]);
  if (inspectNetwork(network.Id) !== null || inspectNetwork(receipt.networkName) !== null)
    throw new Error('browser owned network remains');
}
