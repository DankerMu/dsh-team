/** Verification-only browser ownership and two one-to-one byte paths. */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import net from 'node:net';
import { arch, platform, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  alive,
  liveProcessBirth,
  processBirth,
  retireNative,
  stopChild,
} from './probe-browser-native.mjs';
export { processBirth } from './probe-browser-native.mjs';
import { readReceipt, writeReceipt } from './probe-browser-receipt.mjs';
export { readReceipt, writeReceipt } from './probe-browser-receipt.mjs';
import {
  browserDocker,
  dockerEnvironment,
  inspectContainer,
  requireContainer,
  networkRegistration,
  networkCreateArgs,
  requireNetworkAuthority,
  preflightResources,
  retireNetwork,
  inspectNetwork,
  requireNetwork,
  OWNER,
  NONCE,
  ROLE,
} from './probe-browser-network.mjs';
export { browserDocker } from './probe-browser-network.mjs';

const modulePath = fileURLToPath(import.meta.url);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const isolatedOwners = new Map();

export async function chromeDigest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function requireProfileOwnership(profile, receiptFile) {
  if (receiptFile === profile || receiptFile.startsWith(`${profile}/`))
    throw new Error('browser receipt must be outside writable profile');
  const parent = await lstat(dirname(receiptFile));
  if (!parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o077) !== 0)
    throw new Error('browser receipt directory must be private and owned');
  if (
    !profile.startsWith(`${dirname(receiptFile)}/`) ||
    (await lstat(profile)).uid !== process.getuid()
  )
    throw new Error('browser profile must be an invocation-owned private child path');
}

export async function registerChrome(input) {
  const profile = await realpath(input.profile);
  const receiptFile = join(await realpath(dirname(input.receiptFile)), basename(input.receiptFile));
  await requireProfileOwnership(profile, receiptFile);
  try {
    const previous = await readReceipt(receiptFile);
    if (previous.state !== 'stopped' || previous.profile !== profile)
      throw new Error('browser receipt already owns an unsettled launch');
    await rescueChrome(receiptFile);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const receipt = {
    version: 1,
    nonce: randomUUID(),
    kind: input.runtime.kind,
    profile,
    state: input.runtime.kind === 'docker-isolated-network' ? 'pending-identity' : 'registered',
    native: null,
    containerId: null,
    driver: { pid: process.pid, birth: await processBirth(process.pid) },
    acquisition: { state: 'not-started' },
  };
  if (input.runtime.kind === 'docker-isolated-network') {
    Object.assign(receipt, {
      containerName: `dsh-team-browser-${receipt.nonce}`,
      imageId: input.runtime.imageId,
      chromeSha256: input.runtime.chromeSha256,
      runId: input.runtime.runId,
      ...networkRegistration(receipt.nonce),
    });
  }
  await writeReceipt(receiptFile, receipt);
  if (
    input.runtime.kind === 'docker-isolated-network' &&
    process.env.DSH_TEAM_BROWSER_RECEIPT_DIRECTORY
  ) {
    await writeReceipt(
      join(process.env.DSH_TEAM_BROWSER_RECEIPT_DIRECTORY, `${receipt.nonce}.launch.json`),
      { ...receipt, receiptFile },
    );
  }
  return receipt;
}

function byteListener(address, destination) {
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  const server = net.createServer({ allowHalfOpen: true }, (incoming) => {
    const left = track(incoming);
    const right = track(net.connect({ ...destination, allowHalfOpen: true }));
    const abort = () => {
      left.destroy();
      right.destroy();
    };
    left.on('error', abort);
    right.on('error', abort);
    for (const [socket, peer] of [
      [left, right],
      [right, left],
    ]) {
      socket.once('close', (hadError) => {
        if (hadError || !socket.readableEnded || !socket.writableFinished) peer.destroy();
      });
    }
    left.pipe(right);
    right.pipe(left);
  });
  const ready = new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(address, () => {
      server.off('error', reject);
      done();
    });
  });
  return {
    server,
    ready,
    close: async () => {
      const closed = new Promise((done, reject) =>
        server.close((error) => {
          if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
          else done();
        }),
      );
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}

export function isolatedBrowserRuntime(runId = randomUUID()) {
  if (
    process.env.DSH_TEAM_BROWSER_RUNTIME !== 'docker-isolated-network' ||
    platform() !== 'linux' ||
    arch() !== 'x64'
  )
    throw new Error('isolated browser requires explicitly provisioned Linux amd64 runtime');
  const imageId = process.env.DSH_TEAM_BROWSER_IMAGE_ID;
  const bin = process.env.CHROME_BIN;
  const chromeSha256 = process.env.DSH_TEAM_BROWSER_CHROME_SHA256;
  if (!IMAGE_ID.test(imageId ?? '') || !bin || !/^[a-f0-9]{64}$/.test(chromeSha256 ?? ''))
    throw new Error('isolated browser immutable image/Chrome identity missing');
  return {
    kind: 'docker-isolated-network',
    imageId,
    chromeDirectory: dirname(resolve(bin)),
    chromeSha256,
    runId,
  };
}

async function socketIdentity(path) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)
    throw new Error('browser socket directory identity mismatch');
  return { device: String(stat.dev), inode: String(stat.ino) };
}
async function removeSocketFiles(receipt) {
  if (!receipt.socketDirectory) return;
  let identity;
  try {
    identity = await socketIdentity(receipt.socketDirectory);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (
    identity.device !== receipt.socketIdentity.device ||
    identity.inode !== receipt.socketIdentity.inode
  )
    throw new Error('browser socket directory identity mismatch');
  await rm(receipt.socketDirectory, { recursive: true });
}

async function creationAuthorization(path) {
  try {
    return await readReceipt(`${path}.create-authorized`);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function completedAcquisition(path, nonce) {
  const latest = await readReceipt(path);
  if (latest.nonce !== nonce) throw new Error('browser creation authority identity changed');
  const authorization = await creationAuthorization(path);
  if (authorization && authorization.nonce !== nonce)
    throw new Error('browser creation authority identity changed');
  if (latest.acquisition.state === 'armed' && !authorization) {
    latest.acquisition.state = 'settled';
    await writeReceipt(path, latest);
  } else if (['armed', 'creating'].includes(latest.acquisition.state)) {
    latest.acquisition.state = 'uncertain';
    latest.acquisition.failure ??= 'producer-exited-before-settlement';
    await writeReceipt(path, latest);
  }
  if (latest.acquisition.state !== 'settled')
    throw new Error('browser creation unsettled; retain receipt');
  return latest;
}

async function waitForProducer(path, receipt, nonce) {
  const until = Date.now() + 40000;
  while (['armed', 'creating'].includes(receipt.acquisition.state)) {
    const producer = receipt.acquisition.producer;
    if (!producer) throw new Error('browser creation producer identity missing');
    if (!alive(producer.pid)) return await completedAcquisition(path, nonce);
    let birth;
    try {
      birth = await processBirth(producer.pid);
    } catch (error) {
      if (error.code === 'ENOENT') return await completedAcquisition(path, nonce);
      throw error;
    }
    if (birth !== producer.birth) throw new Error('browser creation producer identity mismatch');
    if (Date.now() >= until) throw new Error('browser creation unsettled; retain receipt');
    await pause(50);
    receipt = await readReceipt(path);
    if (receipt.nonce !== nonce) throw new Error('browser creation authority identity changed');
  }
  if (!['settled', 'not-started'].includes(receipt.acquisition.state))
    throw new Error('browser creation unsettled; retain receipt');
  return receipt;
}

async function settleAcquisition(path, receipt) {
  const nonce = receipt.nonce;
  const authorization = await creationAuthorization(path);
  receipt = await readReceipt(path);
  if (receipt.nonce !== nonce || (authorization && authorization.nonce !== nonce))
    throw new Error('browser creation authority identity mismatch');
  if (authorization && receipt.acquisition.state === 'not-started')
    throw new Error('browser creation unsettled; retain receipt');
  if (
    !['not-started', 'armed', 'creating', 'settled', 'uncertain'].includes(
      receipt.acquisition.state,
    )
  )
    throw new Error('browser acquisition authority invalid');
  return await waitForProducer(path, receipt, nonce);
}
function requireCleanupAuthority(receipt) {
  if (
    !IMAGE_ID.test(receipt.imageId ?? '') ||
    typeof receipt.runId !== 'string' ||
    !/^dsh-team-browser-[a-f0-9-]+$/.test(receipt.containerName ?? '')
  )
    throw new Error('browser cleanup authority missing');
  requireNetworkAuthority(receipt);
  if (
    !Object.hasOwn(receipt, 'containerId') ||
    (receipt.containerId !== null && !CONTAINER_ID.test(receipt.containerId))
  )
    throw new Error('browser immutable container identity missing');
  if (receipt.containerId === null && !['pending-identity', 'stopped'].includes(receipt.state))
    throw new Error('browser pending identity authority missing');
}

async function requireNeverStarted(path, receipt) {
  if (
    receipt.containerId !== null ||
    receipt.networkId !== null ||
    !['pending-identity', 'stopped'].includes(receipt.state) ||
    (await creationAuthorization(path))
  )
    throw new Error('browser never-started identity contradicts acquired resources');
}

async function retireIsolated(path, original) {
  const receipt = await settleAcquisition(path, original);
  requireCleanupAuthority(receipt);
  if (receipt.acquisition.state === 'not-started') {
    await requireNeverStarted(path, receipt);
    if (inspectContainer(receipt.containerName) || inspectNetwork(receipt.networkName))
      throw new Error('browser never-started identity contradicts acquired resources');
    return receipt;
  }
  const { container } = await preflightResources(path, receipt);
  if (container) {
    if (container.State?.Running) browserDocker(['stop', '--time', '8', container.Id]);
    browserDocker(['rm', container.Id]);
    if (inspectContainer(container.Id) !== null || inspectContainer(receipt.containerName) !== null)
      throw new Error('browser owned container remains');
  }
  retireNetwork(receipt);
  return receipt;
}

async function rescueMissingReceipt(path, expectedNonce) {
  const directory = process.env.DSH_TEAM_BROWSER_RECEIPT_DIRECTORY;
  if (!directory) return;
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.launch.json')) continue;
    const pointerPath = join(directory, name);
    const pointer = await readReceipt(pointerPath);
    if (pointer.receiptFile !== resolve(path) || (expectedNonce && pointer.nonce !== expectedNonce))
      continue;
    if (pointer.state !== 'stopped')
      throw new Error(
        'browser registered lifecycle authority missing; refusing cleanup completion',
      );
    await rescueChrome(pointerPath, pointer.nonce);
  }
}

async function requireStoppedDriver(receipt) {
  if (
    receipt.kind !== 'docker-isolated-network' ||
    receipt.state === 'stopped' ||
    receipt.driver?.pid === process.pid
  )
    return;
  if ((await liveProcessBirth(receipt.driver.pid)) === receipt.driver.birth)
    throw new Error('browser driver still owns relays; stop driver before external rescue');
}

async function recordStoppedReceipt(path, receipt) {
  const authorization = await creationAuthorization(path);
  if (authorization && authorization.nonce !== receipt.nonce)
    throw new Error('browser creation authority identity mismatch');
  await rm(`${path}.create-authorized`, { force: true });
  receipt.state = 'stopped';
  await writeReceipt(path, receipt);
  const directory = process.env.DSH_TEAM_BROWSER_RECEIPT_DIRECTORY;
  if (directory && receipt.kind === 'docker-isolated-network') {
    const registeredPath = join(directory, `${receipt.nonce}.launch.json`);
    if (registeredPath !== resolve(path))
      await writeReceipt(registeredPath, { ...receipt, receiptFile: resolve(path) });
  }
}

export async function rescueChrome(path, expectedNonce) {
  let receipt;
  try {
    receipt = await readReceipt(path);
  } catch (error) {
    if (error.code === 'ENOENT') return await rescueMissingReceipt(path, expectedNonce);
    throw error;
  }
  if (expectedNonce && receipt.nonce !== expectedNonce)
    throw new Error('browser launch receipt identity changed; refusing cleanup');
  await requireStoppedDriver(receipt);
  if (receipt.kind === 'docker-isolated-network') receipt = await retireIsolated(path, receipt);
  else if (receipt.kind === 'native') await retireNative(receipt);
  else throw new Error('browser receipt runtime invalid');
  await isolatedOwners.get(receipt.nonce)?.();
  await removeSocketFiles(receipt);
  await recordStoppedReceipt(path, receipt);
}

async function createWorker(path, args, canceled, nonce) {
  const worker = spawn(process.execPath, [modulePath, 'create', path], {
    env: {
      ...dockerEnvironment(),
      DSH_TEAM_BROWSER_DOCKER_CONFIG: process.env.DSH_TEAM_BROWSER_DOCKER_CONFIG,
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  let started = false;
  await new Promise((done, reject) => {
    const disconnect = () => {
      if (worker.connected) worker.disconnect();
    };
    const authorize = async (producer) => {
      if (canceled()) {
        disconnect();
        return;
      }
      const receipt = await readReceipt(path);
      if (receipt.nonce !== nonce) throw new Error('browser producer receipt identity changed');
      if (producer?.pid !== worker.pid || producer.birth !== (await processBirth(worker.pid)))
        throw new Error('browser producer identity mismatch');
      if (process.env.DSH_TEAM_CI_INVOCATION) {
        const { retainAcquisition } = await import('./ci-vps-units.mjs');
        await retainAcquisition(producer, nonce, process.env.DSH_TEAM_CI_INVOCATION);
      }
      receipt.acquisition = { state: 'armed', producer };
      await writeReceipt(path, receipt);
      await writeReceipt(`${path}.create-authorized`, { version: 1, nonce, producer });
      if (canceled()) {
        disconnect();
        return;
      }
      started = true;
      worker.send({ action: 'create', args }, (error) => {
        if (error) {
          disconnect();
          reject(new Error('browser creation producer failed'));
        }
      });
    };
    worker.once('error', () => reject(new Error('browser creation producer failed')));
    worker.on('message', (message) => {
      if (message?.action === 'ready')
        void authorize(message.producer).catch(() => {
          disconnect();
          reject(new Error('browser creation producer failed'));
        });
    });
    worker.once('exit', (code) => {
      if (code === 0 && started) done();
      else reject(new Error('browser creation producer failed'));
    });
  });
}

function requireIsolatedRuntime(runtime) {
  if (
    platform() !== 'linux' ||
    arch() !== 'x64' ||
    process.getuid() === 0 ||
    !IMAGE_ID.test(runtime.imageId ?? '') ||
    !/^[a-f0-9]{64}$/.test(runtime.chromeSha256 ?? '') ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runtime.runId ?? '')
  ) {
    throw new Error(
      'isolated browser requires nonroot Linux amd64 and immutable image/Chrome/run identities',
    );
  }
}

async function waitPrivateRuntime(socketDirectory, debugPort, uid, runtime) {
  const until = Date.now() + 15000;
  for (;;) {
    try {
      const ready = JSON.parse(await readFile(join(socketDirectory, 'ready.json'), 'utf8'));
      if (
        ready.debugPort !== debugPort ||
        ready.uid !== uid ||
        ready.chromeSha256 !== runtime.chromeSha256 ||
        ready.nodeVersion !== 'v24.13.1'
      )
        throw new Error('browser private runtime identity mismatch');
      return ready;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (Date.now() >= until) throw new Error('browser private startup timeout');
    await pause(50);
  }
}

export async function startIsolated(input, receipt) {
  const runtime = input.runtime;
  requireIsolatedRuntime(runtime);
  const chromeDirectory = await realpath(runtime.chromeDirectory);
  if (!chromeDirectory.endsWith('/chrome-headless-shell-linux64'))
    throw new Error(
      'isolated browser requires the complete pinned CfT distribution, not a host root/home/library mount',
    );
  await readFile(join(chromeDirectory, 'deb.deps'));
  const uid = process.getuid(),
    gid = process.getgid();
  const socketDirectory = await mkdtemp(join(tmpdir(), 'dsh-browser-'));
  await chmod(socketDirectory, 0o700);
  Object.assign(receipt, {
    socketDirectory,
    socketIdentity: await socketIdentity(socketDirectory),
    containerName: `dsh-team-browser-${receipt.nonce}`,
    imageId: runtime.imageId,
    chromeSha256: runtime.chromeSha256,
    runId: runtime.runId,
  });
  try {
    await writeReceipt(input.receiptFile, receipt);
  } catch (error) {
    await removeSocketFiles(receipt);
    throw error;
  }
  const appSocket = join(socketDirectory, 'app.sock');
  const cdpSocket = join(socketDirectory, 'cdp.sock');
  const appPort = Number(new URL(input.origin).port || '80');
  const app = byteListener(appSocket, { host: '127.0.0.1', port: appPort });
  let cdp;
  let debugPort;
  let canceled = false;
  const close = async () => {
    canceled = true;
    await Promise.all([app.close(), cdp?.close()]);
    isolatedOwners.delete(receipt.nonce);
  };
  isolatedOwners.set(receipt.nonce, close);
  try {
    await app.ready;
    await chmod(appSocket, 0o600);
    cdp = byteListener({ host: '127.0.0.1', port: 0 }, { path: cdpSocket });
    await cdp.ready;
    debugPort = cdp.server.address().port;
    if (appPort === debugPort) throw new Error('browser application/CDP port collision');
    receipt.debugPort = debugPort;
    const createArgs = [
      'create',
      '--pull=never',
      '--name',
      receipt.containerName,
      '--label',
      `${OWNER}=${runtime.runId}`,
      '--label',
      `${NONCE}=${receipt.nonce}`,
      '--label',
      `${ROLE}=verification-browser`,
      '--network',
      receipt.networkName,
      '--user',
      `${uid}:${gid}`,
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,mode=1777',
      '--env',
      'HOME=/profile',
      '--mount',
      `type=bind,src=${chromeDirectory},dst=/opt/chrome,readonly`,
      '--mount',
      `type=bind,src=${receipt.profile},dst=/profile`,
      '--mount',
      `type=bind,src=${socketDirectory},dst=/sockets`,
      runtime.imageId,
      'private',
      String(appPort),
      String(debugPort),
      JSON.stringify(input.extraFlags ?? []),
    ];
    await writeReceipt(input.receiptFile, receipt);
    await createWorker(input.receiptFile, createArgs, () => canceled, receipt.nonce);
    receipt = await readReceipt(input.receiptFile);
    const object = inspectContainer(receipt.containerId);
    if (!object) throw new Error('browser created container absent');
    requireContainer(receipt, object);
    const network = inspectNetwork(receipt.networkId);
    if (!network) throw new Error('browser created network absent');
    requireNetwork(receipt, network, object);
    browserDocker(['start', receipt.containerId]);
    const ready = await waitPrivateRuntime(socketDirectory, debugPort, uid, runtime);
    receipt.privateUid = ready.uid;
    receipt.privateNodeVersion = ready.nodeVersion;
    receipt.state = 'running';
    await writeReceipt(input.receiptFile, receipt);
    let stopping;
    return { debugPort, stop: () => (stopping ??= rescueChrome(input.receiptFile, receipt.nonce)) };
  } catch (error) {
    const cleanupErrors = [];
    try {
      await close();
    } catch (cleanup) {
      cleanupErrors.push(cleanup);
    }
    try {
      await rescueChrome(input.receiptFile, receipt.nonce);
    } catch (cleanup) {
      cleanupErrors.push(cleanup);
    }
    if (cleanupErrors.length)
      throw new AggregateError([error, ...cleanupErrors], 'browser startup and cleanup failed', {
        cause: error,
      });
    throw error;
  }
}

function creationResponded(result) {
  return (
    !result.error &&
    !result.signal &&
    (result.status === 0 || /^(?:docker: )?Error response from daemon:/.test(result.stderr ?? ''))
  );
}

function creationResult(result) {
  const neverSpawned = ['ENOENT', 'EACCES'].includes(result.error?.code);
  const responded = creationResponded(result);
  const id =
    !result.error && result.status === 0 && CONTAINER_ID.test(result.stdout.trim())
      ? result.stdout.trim()
      : null;
  const state =
    result.status === 0 && !id ? 'uncertain' : neverSpawned || responded ? 'settled' : 'uncertain';
  return { state, id };
}

function submitCreation(args, until) {
  const remaining = until - Date.now();
  if (remaining <= 0) return { state: 'settled', id: null };
  return creationResult(
    spawnSync('docker', args, {
      env: dockerEnvironment(),
      encoding: 'utf8',
      timeout: remaining,
      killSignal: 'SIGKILL',
      maxBuffer: 65536,
    }),
  );
}

async function acquireResources(path, receipt, args) {
  // Network and container share the original acquisition deadline and producer fence.
  const until = Date.now() + 30000;
  const network = submitCreation(networkCreateArgs(receipt), until);
  receipt.networkId = network.id;
  receipt.acquisition.resource = 'network';
  if (!network.id) {
    receipt.acquisition.state = network.state;
    receipt.acquisition.failure = 'network-create';
    await writeReceipt(path, receipt);
    return;
  }
  await writeReceipt(path, receipt);
  const object = inspectNetwork(network.id, Math.max(1, until - Date.now()));
  if (!object) throw new Error('browser acquired network absent');
  requireNetwork(receipt, object);
  const networkArgument = args.indexOf('--network') + 1;
  if (networkArgument === 0 || args[networkArgument] !== receipt.networkName)
    throw new Error('browser producer network argument mismatch');
  args[networkArgument] = network.id;
  receipt.acquisition.resource = 'container';
  await writeReceipt(path, receipt);
  const container = submitCreation(args, until);
  receipt.containerId = container.id;
  receipt.acquisition.state = container.state;
  if (!container.id) receipt.acquisition.failure = 'container-create';
  await writeReceipt(path, receipt);
}

async function acquireIsolated(path) {
  let launched = false;
  const receipt = await readReceipt(path);
  const producer = { pid: process.pid, birth: await processBirth(process.pid) };
  const abandoned = async () => {
    if (launched) return;
    const authorization = await creationAuthorization(path);
    if (authorization?.nonce === receipt.nonce && authorization.producer?.pid === process.pid) {
      const current = await readReceipt(path);
      if (current.nonce !== receipt.nonce)
        throw new Error('browser producer receipt identity changed');
      if (current.acquisition.state === 'armed') {
        current.acquisition.state = 'settled';
        await writeReceipt(path, current);
      }
    }
    process.exitCode = 1;
  };
  process.on('disconnect', () => {
    void abandoned().catch(() => {
      process.exitCode = 1;
    });
  });
  process.once('message', async (message) => {
    if (message?.action !== 'create') return;
    launched = true;
    const authorization = await creationAuthorization(path);
    if (
      !authorization ||
      authorization.nonce !== receipt.nonce ||
      authorization.producer?.pid !== process.pid ||
      authorization.producer?.birth !== producer.birth
    )
      throw new Error('browser creation authorization identity mismatch');
    receipt.acquisition = { state: 'creating', producer };
    await writeReceipt(path, receipt);
    await acquireResources(path, receipt, message.args);
    process.exitCode = receipt.containerId ? 0 : 1;
    if (process.connected) process.disconnect();
  });
  if (process.connected) process.send?.({ action: 'ready', producer });
  else process.exitCode = 1;
}

async function privateRuntime(appPort, debugPort, extraFlags) {
  const app = byteListener({ host: '127.0.0.1', port: appPort }, { path: '/sockets/app.sock' });
  const cdp = byteListener('/sockets/cdp.sock', { host: '127.0.0.1', port: debugPort });
  let child;
  let stopping;
  const stop = () =>
    (stopping ??= (async () => {
      await Promise.all([app.close(), cdp.close()]);
      if (child) await stopChild(child);
    })());
  process.once('SIGTERM', () => {
    void stop();
  });
  process.once('SIGINT', () => {
    void stop();
  });
  try {
    await Promise.all([app.ready, cdp.ready]);
    await chmod('/sockets/cdp.sock', 0o600);
    child = spawn(
      '/opt/chrome/chrome-headless-shell',
      chromeFlags('/profile', debugPort, extraFlags),
      { stdio: ['ignore', 'ignore', 'ignore'] },
    );
    const died = new Promise((done, reject) => {
      child.once('exit', done);
      child.once('error', reject);
    });
    const until = Date.now() + 15000;
    let ready = false;
    while (!ready) {
      if (child.exitCode !== null || child.signalCode || Date.now() >= until)
        throw new Error('browser private Chrome failed');
      ready = await new Promise((done) => {
        const socket = net.connect({ host: '127.0.0.1', port: debugPort }, () => {
          socket.end();
          done(true);
        });
        socket.once('error', () => done(false));
      });
      if (!ready) await pause(50);
    }
    const chromeSha256 = await chromeDigest('/opt/chrome/chrome-headless-shell');
    await writeReceipt('/sockets/ready.json', {
      debugPort,
      uid: process.getuid(),
      chromeSha256,
      nodeVersion: process.version,
    });
    await died;
  } finally {
    await stop();
  }
}
export function chromeFlags(profile, debugPort, extraFlags = []) {
  return [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${debugPort}`,
    '--remote-debugging-address=127.0.0.1',
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    ...extraFlags,
    'about:blank',
  ];
}

if (process.argv[1] && resolve(process.argv[1]) === modulePath) {
  const [command, first, second, third] = process.argv.slice(2);
  const run =
    command === 'rescue'
      ? rescueChrome(first)
      : command === 'create'
        ? acquireIsolated(first)
        : command === 'private'
          ? privateRuntime(Number(first), Number(second), JSON.parse(third))
          : Promise.reject(new Error('browser runtime command invalid'));
  run.catch(() => {
    process.stderr.write(
      'browser runtime failed; retained lifecycle receipt may require cleanup\n',
    );
    process.exitCode = 1;
  });
}
