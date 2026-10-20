import { deepStrictEqual } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { liveProcessBirth, processBirth } from './probe-browser-native.mjs';
import { writeReceipt } from './probe-browser-receipt.mjs';
import { dockerProxyEnvironment } from './docker-proxy-environment.mjs';
import { capturePrivateOutput } from './trusted-docker-output.mjs';
import { assessTrustedDockerCleanup } from './trusted-docker-audit.mjs';
import {
  custodyPaths,
  FULL_DOCKER_COMMAND,
  ownerIsLive,
  privateDirectory,
  groupIsAbsent,
  processIdentity,
  hasPassingOutcome,
  readCustodyRecord,
  readInvocation,
  requirePathIdentity,
  requireReviewedCheckout,
  validateRequest,
  validateTerminal,
} from './trusted-docker-record.mjs';

function runtimeEnvironment(extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: 'C.UTF-8',
    XDG_RUNTIME_DIR: `/run/user/${process.getuid()}`,
    ...(process.env.CHROME_BIN === undefined ? {} : { CHROME_BIN: process.env.CHROME_BIN }),
    ...dockerProxyEnvironment(),
    ...extra,
  };
}

function outputSecrets() {
  const values = Object.values(dockerProxyEnvironment()).filter((value) => value.length > 0);
  const secrets = [...values];
  for (const value of values) {
    try {
      const url = new URL(value);
      const username = decodeURIComponent(url.username);
      const password = decodeURIComponent(url.password);
      secrets.push(url.username, url.password, username, password);
      if (username || password)
        secrets.push(Buffer.from(`${username}:${password}`).toString('base64'));
    } catch {
      // Non-URL proxy inputs still retain their exact transport semantics and whole-value exclusion.
    }
  }
  return secrets;
}

async function waitForPublication(read, ended = () => false) {
  // This bounds only launch observation; it neither cancels work nor changes a test/SSH deadline.
  const until = Date.now() + 10_000;
  while (true) {
    try {
      return await read();
    } catch (error) {
      if (error.code !== 'ENOENT' || ended() || Date.now() >= until) throw error;
    }
    await delay(25);
  }
}

export async function startTrustedDocker(root, head) {
  if (!/^[a-f0-9]{40}$/.test(head ?? '') || process.getuid() === 0)
    throw new Error('Invalid trusted Docker admission');
  root = await realpath(root);
  requireReviewedCheckout(root, head);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.uid !== process.getuid())
    throw new Error('Trusted Docker checkout authority unavailable');
  const invocation = randomUUID();
  const paths = custodyPaths(invocation);
  await mkdir(paths.base, { recursive: true, mode: 0o700 });
  await privateDirectory(paths.base);
  await mkdir(paths.directory, { mode: 0o700 });
  const temporary = await realpath(await mkdtemp('/tmp/dsh-team-docker-'));
  await chmod(temporary, 0o700);
  const temporaryInfo = await lstat(temporary);
  const request = {
    version: 1,
    invocation,
    head,
    root,
    rootDevice: String(rootInfo.dev),
    rootInode: String(rootInfo.ino),
    command: FULL_DOCKER_COMMAND,
    temporary,
    temporaryDevice: String(temporaryInfo.dev),
    temporaryInode: String(temporaryInfo.ino),
  };
  await writeReceipt(join(paths.directory, 'request.json'), request);
  await mkdir(join(paths.directory, 'docker'), { mode: 0o700 });
  await writeFile(join(paths.directory, 'resources.jsonl'), '', { mode: 0o600, flag: 'wx' });
  const log = await open(join(paths.directory, 'owner.log'), 'wx', 0o600);
  let ownerClosed = false;
  try {
    const child = spawn(
      process.execPath,
      [join(root, 'scripts/trusted-docker-run.mjs'), 'own', invocation],
      {
        cwd: root,
        env: runtimeEnvironment(),
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
      },
    );
    const started = Promise.withResolvers();
    child.once('spawn', started.resolve);
    child.once('error', started.reject);
    child.once('close', () => {
      ownerClosed = true;
    });
    child.unref();
    await started.promise;
    const owner = processIdentity({ pid: child.pid, birth: await processBirth(child.pid) });
    await writeReceipt(join(paths.directory, 'launch.json'), { version: 1, invocation, owner });
    const context = await waitForPublication(
      () => readInvocation(invocation),
      () => ownerClosed,
    );
    return { invocation, head, root, directory: paths.directory, owner: context.owner };
  } finally {
    await log.close();
  }
}

async function signalOwnedGroup(child, identity) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!(await ownerIsLive(identity))) throw new Error('Trusted Docker child identity changed');
  const group = spawnSync('/bin/ps', ['-p', String(identity.pid), '-o', 'pgid='], {
    encoding: 'utf8',
    timeout: 2000,
    maxBuffer: 65_536,
  });
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (
    group.error ||
    group.status !== 0 ||
    group.stdout.trim() !== String(identity.pid) ||
    !(await ownerIsLive(identity))
  )
    throw new Error('Trusted Docker child group identity changed');
  process.kill(-identity.pid, 'SIGINT');
}

async function executeOwnedCommand(context) {
  const { request, directory, owner, digest } = context;
  let child;
  let childIdentity;
  let closed = false;
  let signalled = false;
  let interruption = 'none';
  let failure = null;
  let cancellation = Promise.resolve();
  const cancel = (kind) => {
    if (closed && kind !== 'capture-failed') return;
    if (interruption === 'none') interruption = kind;
    cancellation = cancellation
      .then(async () => {
        if (!child || !childIdentity || signalled || closed) return;
        await signalOwnedGroup(child, childIdentity);
        signalled = true;
      })
      .catch(() => {
        failure = 'identity';
      });
  };
  const readCancellation = async () => {
    try {
      const value = (await readCustodyRecord(join(directory, 'cancel.json'))).value;
      if (
        value.version !== 1 ||
        value.invocation !== request.invocation ||
        value.manifestDigest !== digest
      )
        throw new Error('Trusted Docker cancellation authority changed');
      deepStrictEqual(processIdentity(value.owner), owner);
      cancel('cancelled');
    } catch (error) {
      if (error.code !== 'ENOENT') failure = 'control';
    }
  };
  const watcher = watch(directory, (_event, name) => {
    if (name?.toString() === 'cancel.json') void readCancellation();
  });
  watcher.on('error', () => {
    failure = 'control';
  });
  const onSignal = () => cancel('owner-signal');
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    await readCancellation();
    let command = { exitCode: null, signal: null, settled: true };
    let stdout;
    let stderr;
    if (interruption === 'none' && failure === null) {
      const finished = Promise.withResolvers();
      const spawned = Promise.withResolvers();
      let spawnFailed = false;
      child = spawn(FULL_DOCKER_COMMAND[0], FULL_DOCKER_COMMAND.slice(1), {
        cwd: request.root,
        env: runtimeEnvironment({
          TMPDIR: request.temporary,
          DSH_TEAM_CI_RESOURCE_JOURNAL: join(directory, 'resources.jsonl'),
          DSH_TEAM_REVIEWED_HEAD: request.head,
        }),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.once('spawn', () => spawned.resolve(true));
      child.once('error', () => {
        spawnFailed = true;
        spawned.resolve(false);
      });
      child.once('close', (exitCode, signal) => {
        closed = true;
        finished.resolve({
          exitCode: spawnFailed ? null : exitCode,
          signal,
          settled: groupIsAbsent(child.pid),
        });
      });
      const secrets = outputSecrets();
      const capture = (stream, name) =>
        capturePrivateOutput(stream, join(directory, `${name}.log`), secrets).catch(() => {
          cancel('capture-failed');
          return null;
        });
      const outputs = Promise.all([
        capture(child.stdout, 'stdout'),
        capture(child.stderr, 'stderr'),
      ]);
      if (await spawned.promise) {
        try {
          childIdentity = processIdentity({ pid: child.pid, birth: await processBirth(child.pid) });
          await writeReceipt(join(directory, 'child.json'), {
            version: 1,
            invocation: request.invocation,
            manifestDigest: digest,
            owner: childIdentity,
          });
          if (interruption !== 'none') cancel(interruption);
        } catch {
          failure = 'identity';
        }
      } else failure = 'launch';
      command = await finished.promise;
      [stdout, stderr] = await outputs;
      await cancellation;
    } else {
      [stdout, stderr] = await Promise.all(
        ['stdout', 'stderr'].map((name) =>
          capturePrivateOutput([], join(directory, `${name}.log`), []),
        ),
      );
    }
    const output = { complete: stdout !== null && stderr !== null, stdout, stderr };
    const cleanup = child
      ? await assessTrustedDockerCleanup(request, directory, command.settled)
      : { state: 'not-started' };
    try {
      const current = await readInvocation(request.invocation);
      if (current.digest !== digest) failure = 'identity';
    } catch {
      failure = 'identity';
    }
    const result = {
      version: 1,
      invocation: request.invocation,
      manifestDigest: digest,
      state: 'failed',
      command,
      interruption,
      failure,
      output,
      cleanup,
    };
    if (hasPassingOutcome(result)) result.state = 'passed';
    return result;
  } finally {
    watcher.close();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

export async function runTrustedDockerOwner(invocation) {
  const paths = custodyPaths(invocation);
  await privateDirectory(paths.base);
  await privateDirectory(paths.directory);
  await mkdir(join(paths.directory, 'claim'), { mode: 0o700 });
  const request = validateRequest(
    (await readCustodyRecord(join(paths.directory, 'request.json'))).value,
    invocation,
  );
  const launch = (
    await waitForPublication(() => readCustodyRecord(join(paths.directory, 'launch.json')))
  ).value;
  const owner = processIdentity({ pid: process.pid, birth: await processBirth(process.pid) });
  if (launch.version !== 1 || launch.invocation !== invocation)
    throw new Error('Trusted Docker launch identity changed');
  deepStrictEqual(processIdentity(launch.owner), owner);
  await requirePathIdentity(request.root, request.rootDevice, request.rootInode);
  await requirePathIdentity(
    request.temporary,
    request.temporaryDevice,
    request.temporaryInode,
    true,
  );
  requireReviewedCheckout(request.root, request.head);
  await writeReceipt(join(paths.directory, 'manifest.json'), { ...request, owner });
  const context = await readInvocation(invocation);
  const result = await executeOwnedCommand(context);
  await writeReceipt(join(paths.directory, 'result.json'), result);
  return result.state === 'passed' ? 0 : 1;
}

async function terminalStatus(context) {
  const invocation = context.request.invocation;
  try {
    const value = (await readCustodyRecord(join(context.directory, 'result.json'))).value;
    const result = validateTerminal(value, invocation, context.digest);
    return {
      invocation,
      head: context.request.head,
      root: context.request.root,
      state: result.command.settled ? result.state : 'unknown',
      command: result.command,
      interruption: result.interruption,
      failure: result.failure,
      output: result.output,
      cleanup: result.cleanup,
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  }
}

export async function trustedDockerStatus(invocation) {
  const context = await readInvocation(invocation);
  const terminal = await terminalStatus(context);
  if (terminal !== undefined) return terminal;
  const current = await liveProcessBirth(context.owner.pid);
  if (current === null) {
    // The owner publishes before exiting; observe that boundary after confirmed absence.
    const completed = await terminalStatus(context);
    if (completed !== undefined) return completed;
  }
  return {
    invocation,
    head: context.request.head,
    root: context.request.root,
    state: current === context.owner.birth ? 'running' : 'unknown',
  };
}

export async function cancelTrustedDocker(invocation) {
  const context = await readInvocation(invocation);
  const status = await trustedDockerStatus(invocation);
  if (status.state === 'passed' || status.state === 'failed') return status;
  if (status.state !== 'running') throw new Error('Trusted Docker cancellation owner unavailable');
  const current = await liveProcessBirth(context.owner.pid);
  if (current !== context.owner.birth) {
    if (current === null) {
      const completed = await terminalStatus(context);
      if (completed?.state === 'passed' || completed?.state === 'failed') return completed;
    }
    throw new Error('Trusted Docker cancellation owner unavailable');
  }
  await writeReceipt(join(context.directory, 'cancel.json'), {
    version: 1,
    invocation,
    manifestDigest: context.digest,
    owner: context.owner,
  });
  return { invocation, head: context.request.head, state: 'cancellation-requested' };
}
