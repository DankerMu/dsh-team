import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { awaitFile } from './browser-runtime-fixture.ts';
import { record } from './container-start-docker-fixture.ts';
import { dockerProxyEnvironment } from '../../scripts/docker-proxy-environment.mjs';
import {
  browserDocker,
  isolatedBrowserRuntime,
  readReceipt,
} from '../../scripts/probe-browser-runtime.mjs';

// Reserve short handshakes and the existing scoped rescue budget inside Docker's 900s case.
const fixtureHandshakeMs = 15000;
const fixtureRescueMs = 147000;
const firstBoundaryMs = 900000 - fixtureRescueMs - 2 * fixtureHandshakeMs;

export interface WrapperInterruptionCase {
  readonly boundary: 'publication' | 'running-child' | 'help-child';
  readonly mode: 'docker' | 'dsh-api' | 'first-run';
  readonly signal: 'SIGTERM' | 'SIGINT';
}
interface WrapperExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}
interface WrapperInventory {
  readonly containers: readonly string[];
  readonly networks: readonly string[];
  readonly images: readonly string[];
  readonly sockets: readonly string[];
}
export interface WrapperInterruptionResult extends WrapperExit {
  readonly childStarted: boolean;
  readonly childSignal: string | undefined;
  readonly childExitCode: number | undefined;
  readonly inventory: WrapperInventory;
  readonly publicationObserved: boolean;
}
interface RunningWrapper {
  readonly process: ChildProcessByStdio<Writable, Readable, Readable>;
  readonly closed: Promise<WrapperExit>;
}

async function startWrapper(
  root: string,
  options: WrapperInterruptionCase,
): Promise<RunningWrapper> {
  const temporary = join(root, 'tmp');
  const binaries = join(root, 'bin');
  await mkdir(temporary, { mode: 0o700 });
  await mkdir(binaries, { mode: 0o700 });
  const preload = join(root, 'publication.mjs');
  const preloadCode = `
import promises from 'node:fs/promises';
import fs from 'node:fs';
import { basename } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const root = ${JSON.stringify(root)};
function publish(name, value) {
  const path = root + '/' + name;
  fs.writeFileSync(path + '.pending', JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(path + '.pending', path);
}
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => publish('wrapper-signal.json', { signal, pid: process.pid }));
const write = promises.writeFile;
promises.writeFile = async (...args) => {
  const result = await write(...args);
  const path = args[0];
  if (typeof path === 'string' && path.startsWith(${JSON.stringify(temporary + '/')}) && basename(path) === 'runtime.json') {
    publish('publication.json', { path });
    if (${JSON.stringify(options.boundary === 'publication')}) {
      const { promise, resolve, reject } = Promise.withResolvers();
      const watcher = fs.watch(root, (_event, name) => { if (name === 'release') resolve(); });
      watcher.once('error', reject);
      try {
        if (!fs.existsSync(root + '/release')) await promise;
      } finally {
        watcher.close();
      }
    }
  }
  return result;
};
syncBuiltinESMExports();
`;
  await writeFile(preload, preloadCode, { mode: 0o600 });
  const child = `#!/usr/bin/env node
const fs = require('node:fs');
const root = ${JSON.stringify(root)};
function publish(name, value) {
  const path = root + '/' + name;
  fs.writeFileSync(path + '.pending', JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(path + '.pending', path);
}
process.on('exit', code => publish('child-exit.json', { code, pid: process.pid }));
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    publish('child-signal.json', { signal, pid: process.pid });
    process.exit(0);
  });
}
process.stdin.resume();
publish('child-ready.json', { pid: process.pid });
if (${JSON.stringify(options.boundary === 'publication')}) process.exit(0);
`;
  await writeFile(join(binaries, 'pnpm'), child, { mode: 0o700 });
  await writeFile(join(binaries, 'bash'), child, { mode: 0o700 });
  const wrapper = fileURLToPath(
    new URL('../../scripts/verify-browser-runtime.mjs', import.meta.url),
  );
  const args = ['--import', preload, wrapper, options.mode];
  if (options.boundary === 'help-child') args.push('--help');
  const processHandle = spawn(process.execPath, args, {
    env: {
      PATH: `${binaries}:${process.env.PATH ?? ''}`,
      HOME: process.env.HOME,
      CHROME_BIN: process.env.CHROME_BIN,
      TMPDIR: temporary,
      ...(process.env.DSH_TEAM_VERIFICATION_IMAGES === undefined
        ? {}
        : { DSH_TEAM_VERIFICATION_IMAGES: process.env.DSH_TEAM_VERIFICATION_IMAGES }),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  const capture = (chunk: Buffer) => {
    const text = chunk.toString();
    if (output.length + text.length > 65536) processHandle.kill('SIGKILL');
    output += text.slice(0, Math.max(0, 65536 - output.length));
  };
  processHandle.stdout.on('data', capture);
  processHandle.stderr.on('data', capture);
  processHandle.once('exit', () => {
    processHandle.stdin.destroy();
  });
  const closed = new Promise<WrapperExit>((resolve, reject) => {
    processHandle.once('error', reject);
    processHandle.once('close', (code, signal) => {
      void writeFile(join(root, 'wrapper.log'), output.slice(0, 65536), { mode: 0o600 }).then(
        () => {
          resolve({ code, signal });
        },
        reject,
      );
    });
  });
  return { process: processHandle, closed };
}
async function marker(
  root: string,
  name: string,
  wrapper: RunningWrapper,
  timeout = fixtureHandshakeMs,
): Promise<Record<string, unknown>> {
  const cancel = new AbortController();
  try {
    await Promise.race([
      awaitFile(join(root, name), AbortSignal.any([cancel.signal, AbortSignal.timeout(timeout)])),
      wrapper.closed.then(async (result) => {
        if (await optionalRecord(join(root, name))) return;
        throw new Error(
          `Wrapper exited before ${name}: code=${String(result.code)}; private log=${join(root, 'wrapper.log')}`,
        );
      }),
    ]);
    return record(JSON.parse(await readFile(join(root, name), 'utf8')));
  } finally {
    cancel.abort();
  }
}
async function optionalRecord(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return record(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    return undefined;
  }
}
async function socketPaths(root: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...(await socketPaths(path)));
    else if (entry.isSocket()) paths.push(path);
  }
  return paths;
}
function ownedInventory(invocation: string): Omit<WrapperInventory, 'sockets'> {
  const selected = (kind: 'container' | 'network' | 'image', label: string) =>
    browserDocker([
      kind,
      'ls',
      ...(kind === 'container' ? ['--all'] : []),
      '--filter',
      `label=${label}=${invocation}`,
      '--quiet',
      '--no-trunc',
    ])
      .split('\n')
      .filter(Boolean);
  return {
    containers: selected('container', 'dsh-team.test-run'),
    networks: selected('network', 'dsh-team.test-run'),
    images: selected('image', 'dsh-team.browser-invocation'),
  };
}
async function invocationDirectory(root: string): Promise<string | undefined> {
  const names = (await readdir(join(root, 'tmp'))).filter((name) =>
    name.startsWith('dsh-browser-command-'),
  );
  if (names.length > 1) throw new Error('Wrapper fixture invocation identity ambiguous');
  return names[0] ? join(root, 'tmp', names[0]) : undefined;
}
function retireFixtureImage(image: Record<string, unknown>): void {
  if (
    typeof image.invocation !== 'string' ||
    typeof image.imageId !== 'string' ||
    typeof image.tag !== 'string' ||
    image.state !== 'built'
  )
    throw new Error('Wrapper fixture image acquisition remains unsettled');
  const remaining = ownedInventory(image.invocation);
  if (remaining.containers.length || remaining.networks.length)
    throw new Error('Wrapper fixture owned runtime cleanup incomplete');
  if (!remaining.images.length) return;
  if (remaining.images.length !== 1 || remaining.images[0] !== image.imageId)
    throw new Error('Wrapper fixture immutable image cleanup authority missing');
  if (
    browserDocker([
      'image',
      'inspect',
      '--format',
      '{{index .Config.Labels "dsh-team.browser-invocation"}}',
      image.imageId,
    ]) !== image.invocation ||
    browserDocker(['image', 'inspect', '--format', '{{.Id}}', image.tag]) !== image.imageId
  )
    throw new Error('Wrapper fixture image identity changed');
  browserDocker(['image', 'rm', image.imageId]);
}
async function repairOwnedCleanup(root: string): Promise<void> {
  const directory = await invocationDirectory(root);
  if (!directory) return;
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.launch.json')) continue;
    const path = join(directory, name);
    const pointer = await readReceipt(path);
    if (typeof pointer.receiptFile !== 'string' || typeof pointer.nonce !== 'string')
      throw new Error('Wrapper fixture lifecycle authority missing');
    const runtime = fileURLToPath(
      new URL('../../scripts/probe-browser-runtime.mjs', import.meta.url),
    );
    // Scope rescue publication to this nested invocation, never the parent suite's registry.
    const cleanup = spawnSync(
      process.execPath,
      [runtime, 'rescue', pointer.state === 'stopped' ? path : pointer.receiptFile],
      {
        env: {
          PATH: process.env.PATH,
          DOCKER_CONFIG: process.env.DSH_TEAM_BROWSER_DOCKER_CONFIG,
          DSH_TEAM_BROWSER_DOCKER_CONFIG: process.env.DSH_TEAM_BROWSER_DOCKER_CONFIG,
          DSH_TEAM_BROWSER_RECEIPT_DIRECTORY: directory,
          ...dockerProxyEnvironment(),
        },
        // Same scoped rescue budget as the existing probe shell: 12 + 3*30 + 45 seconds.
        timeout: fixtureRescueMs,
        killSignal: 'SIGKILL',
        maxBuffer: 65536,
        encoding: 'utf8',
      },
    );
    if (cleanup.error || cleanup.status !== 0)
      throw new Error('Wrapper fixture canonical rescue incomplete');
  }
  const image = await optionalRecord(join(directory, 'image.json'));
  if (image) retireFixtureImage(image);
  if ((await socketPaths(join(root, 'tmp'))).length)
    throw new Error('Wrapper fixture socket cleanup incomplete');
}
async function wrapperExit(wrapper: RunningWrapper): Promise<WrapperExit> {
  const cancel = new AbortController();
  try {
    return await Promise.race([
      wrapper.closed,
      once(AbortSignal.any([cancel.signal, AbortSignal.timeout(fixtureHandshakeMs)]), 'abort').then(
        () => {
          throw new Error('Owned wrapper fixture process completion missing');
        },
      ),
    ]);
  } finally {
    cancel.abort();
  }
}
async function exerciseInterruption(
  root: string,
  options: WrapperInterruptionCase,
  wrapper: RunningWrapper,
): Promise<WrapperExit> {
  const boundary = options.boundary === 'publication' ? 'publication.json' : 'child-ready.json';
  await marker(root, boundary, wrapper, firstBoundaryMs);
  if (!wrapper.process.kill(options.signal))
    throw new Error('Wrapper fixture signal was not delivered');
  const acknowledged = await marker(root, 'wrapper-signal.json', wrapper);
  if (acknowledged.pid !== wrapper.process.pid || acknowledged.signal !== options.signal)
    throw new Error('Wrapper fixture signal acknowledgment identity changed');
  if (options.boundary === 'publication') await writeFile(join(root, 'release'), 'release');
  return await wrapperExit(wrapper);
}
async function interruptionResult(
  root: string,
  options: WrapperInterruptionCase,
  exit: WrapperExit,
): Promise<WrapperInterruptionResult> {
  const directory = await invocationDirectory(root);
  const image = directory ? await optionalRecord(join(directory, 'image.json')) : undefined;
  if (options.boundary !== 'help-child' && (!image || typeof image.invocation !== 'string'))
    throw new Error('Wrapper fixture real acquisition evidence missing');
  const inventory =
    image && typeof image.invocation === 'string'
      ? ownedInventory(image.invocation)
      : { containers: [], networks: [], images: [] };
  const ready = await optionalRecord(join(root, 'child-ready.json'));
  const childSignal = await optionalRecord(join(root, 'child-signal.json'));
  const childExit = await optionalRecord(join(root, 'child-exit.json'));
  const publication = await optionalRecord(join(root, 'publication.json'));
  return {
    ...exit,
    childStarted: ready !== undefined,
    childSignal: typeof childSignal?.signal === 'string' ? childSignal.signal : undefined,
    childExitCode: typeof childExit?.code === 'number' ? childExit.code : undefined,
    inventory: { ...inventory, sockets: await socketPaths(join(root, 'tmp')) },
    publicationObserved: typeof publication?.path === 'string',
  };
}

async function settleFixture(
  root: string,
  wrapper: RunningWrapper | undefined,
): Promise<unknown[]> {
  const errors: unknown[] = [];
  try {
    await writeFile(join(root, 'release'), 'release');
  } catch (error) {
    errors.push(error);
  }
  try {
    if (wrapper?.process.exitCode === null && !wrapper.process.signalCode)
      wrapper.process.kill('SIGKILL');
    if (wrapper) await wrapperExit(wrapper);
  } catch (error) {
    errors.push(error);
  }
  try {
    // Canonical rescue refuses a still-live driver; an exit failure must not skip this attempt.
    await repairOwnedCleanup(root);
  } catch (error) {
    errors.push(error);
  }
  return errors;
}

export async function interruptWrapper(
  options: WrapperInterruptionCase,
): Promise<WrapperInterruptionResult> {
  isolatedBrowserRuntime();
  const root = await mkdtemp(join(tmpdir(), 'dsh-team-browser-wrapper-'));
  let wrapper: RunningWrapper | undefined;
  let result: WrapperInterruptionResult | undefined;
  let failure: { error: unknown } | undefined;
  try {
    wrapper = await startWrapper(root, options);
    const exit = await exerciseInterruption(root, options, wrapper);
    result = await interruptionResult(root, options, exit);
  } catch (error) {
    failure = { error };
  }
  const cleanupErrors = await settleFixture(root, wrapper);
  if (!failure && !cleanupErrors.length) {
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (failure) {
    if (cleanupErrors.length)
      throw new AggregateError(
        [failure.error, ...cleanupErrors],
        `Wrapper fixture cleanup incomplete; private root=${root}`,
        { cause: failure.error },
      );
    throw failure.error;
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      cleanupErrors,
      `Wrapper fixture cleanup incomplete; private root=${root}`,
    );
  if (!result) throw new Error('Wrapper fixture outcome missing');
  return result;
}
