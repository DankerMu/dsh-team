import { deepStrictEqual } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { constants as operatingSystemConstants } from 'node:os';
import { liveProcessBirth } from './probe-browser-native.mjs';

export const FULL_DOCKER_COMMAND = ['pnpm', 'test:docker'];
export const INVOCATION_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function custodyPaths(invocation) {
  if (!INVOCATION_PATTERN.test(invocation) || !process.env.HOME)
    throw new Error('Invalid trusted Docker invocation');
  const base = join(process.env.HOME, '.local/share/dsh-team/docker-verification');
  return { base, directory: join(base, invocation) };
}

export async function privateDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0)
    throw new Error('Trusted Docker directory authority unavailable');
  return info;
}

/** Read one bounded file descriptor; a symlink or concurrent replacement is not followed. */
export async function readCustodyRecord(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid() ||
      (info.mode & 0o077) !== 0 ||
      info.size > 16384
    )
      throw new Error('Invalid trusted Docker record');
    const buffer = Buffer.alloc(16385);
    let length = 0;
    while (length < buffer.length) {
      const result = await file.read(buffer, length, buffer.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > 16384) throw new Error('Trusted Docker record exceeds bound');
    const bytes = buffer.subarray(0, length);
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid trusted Docker record');
    return { value, digest: createHash('sha256').update(bytes).digest('hex') };
  } finally {
    await file.close();
  }
}

export function processIdentity(value) {
  if (
    !value ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    typeof value.birth !== 'string'
  )
    throw new Error('Invalid trusted Docker process identity');
  if (
    !new RegExp(`^(?:linux:${value.pid}:[0-9]+|darwin:${value.pid}:[a-f0-9]{64})$`).test(
      value.birth,
    )
  )
    throw new Error('Invalid trusted Docker process birth');
  return { pid: value.pid, birth: value.birth };
}

export function validateRequest(value, invocation) {
  const fields = [
    'version',
    'invocation',
    'head',
    'root',
    'rootDevice',
    'rootInode',
    'command',
    'temporary',
    'temporaryDevice',
    'temporaryInode',
  ];
  if (
    Object.keys(value).some((key) => !fields.includes(key)) ||
    value.version !== 1 ||
    value.invocation !== invocation ||
    !/^[a-f0-9]{40}$/.test(value.head ?? '')
  )
    throw new Error('Invalid trusted Docker launch authority');
  for (const key of ['root', 'temporary']) {
    if (typeof value[key] !== 'string' || !isAbsolute(value[key]))
      throw new Error('Invalid trusted Docker owned path');
  }
  for (const key of ['rootDevice', 'rootInode', 'temporaryDevice', 'temporaryInode']) {
    if (typeof value[key] !== 'string' || !/^[0-9]+$/.test(value[key]))
      throw new Error('Invalid trusted Docker filesystem identity');
  }
  deepStrictEqual(value.command, FULL_DOCKER_COMMAND);
  return value;
}

export async function requirePathIdentity(path, device, inode, privateMode = false) {
  const info = privateMode ? await privateDirectory(path) : await lstat(path);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid() ||
    String(info.dev) !== device ||
    String(info.ino) !== inode ||
    (await realpath(path)) !== path
  )
    throw new Error('Trusted Docker path identity changed');
}

export function requireReviewedCheckout(root, head) {
  const run = (args) =>
    spawnSync('git', ['-C', root, ...args], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 65_536,
    });
  const revision = run(['rev-parse', 'HEAD']);
  const dirty = run(['diff', '--quiet', 'HEAD', '--']);
  const untracked = run(['ls-files', '--others', '--exclude-standard']);
  if (
    revision.error ||
    revision.status !== 0 ||
    revision.stdout.trim() !== head ||
    dirty.error ||
    dirty.status !== 0 ||
    untracked.error ||
    untracked.status !== 0 ||
    untracked.stdout.trim()
  )
    throw new Error('Trusted Docker requires the frozen reviewed checkout');
}

export async function readInvocation(invocation) {
  const paths = custodyPaths(invocation);
  await privateDirectory(paths.base);
  await privateDirectory(paths.directory);
  const request = validateRequest(
    (await readCustodyRecord(join(paths.directory, 'request.json'))).value,
    invocation,
  );
  const launch = (await readCustodyRecord(join(paths.directory, 'launch.json'))).value;
  if (launch.version !== 1 || launch.invocation !== invocation)
    throw new Error('Trusted Docker launcher identity changed');
  const owner = processIdentity(launch.owner);
  const { value: manifest, digest } = await readCustodyRecord(
    join(paths.directory, 'manifest.json'),
  );
  const { owner: declaredOwner, ...declaredRequest } = manifest;
  deepStrictEqual(declaredRequest, request);
  deepStrictEqual(processIdentity(declaredOwner), owner);
  await requirePathIdentity(request.root, request.rootDevice, request.rootInode);
  await requirePathIdentity(
    request.temporary,
    request.temporaryDevice,
    request.temporaryInode,
    true,
  );
  return { ...paths, request, manifest, owner, digest };
}

export async function ownerIsLive(identity) {
  return (await liveProcessBirth(identity.pid)) === identity.birth;
}

function requireTerminalFields(value) {
  for (const [object, fields] of [
    [
      value,
      [
        'version',
        'invocation',
        'manifestDigest',
        'state',
        'command',
        'interruption',
        'failure',
        'output',
        'cleanup',
      ],
    ],
    [value.command, ['exitCode', 'signal', 'settled']],
    [value.output, ['complete', 'stdout', 'stderr']],
    [value.cleanup, ['state']],
  ]) {
    if (
      !object ||
      typeof object !== 'object' ||
      Array.isArray(object) ||
      Object.keys(object).some((key) => !fields.includes(key))
    )
      throw new Error('Invalid trusted Docker terminal fields');
  }
}

function validateCommandOutcome(command) {
  if (typeof command.settled !== 'boolean')
    throw new Error('Invalid trusted Docker settlement result');
  if (
    command.exitCode !== null &&
    (!Number.isInteger(command.exitCode) || command.exitCode < 0 || command.exitCode > 255)
  )
    throw new Error('Invalid trusted Docker command exit');
  if (command.signal !== null && !Object.hasOwn(operatingSystemConstants.signals, command.signal))
    throw new Error('Invalid trusted Docker command signal');
}

function validateOutputOutcome(output) {
  if (typeof output.complete !== 'boolean')
    throw new Error('Invalid trusted Docker output completion');
  for (const name of ['stdout', 'stderr']) {
    const log = output[name];
    if (log === null && !output.complete) continue;
    if (
      !log ||
      Object.keys(log).some((key) => !['bytes', 'sha256'].includes(key)) ||
      !Number.isSafeInteger(log.bytes) ||
      log.bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(log.sha256 ?? '')
    )
      throw new Error('Invalid trusted Docker output identity');
  }
}

export function hasPassingOutcome(value) {
  return (
    value.command.exitCode === 0 &&
    value.command.signal === null &&
    value.command.settled &&
    value.interruption === 'none' &&
    value.failure === null &&
    value.output.complete &&
    value.cleanup.state === 'confirmed'
  );
}

export function validateTerminal(value, invocation, digest) {
  requireTerminalFields(value);
  if (
    value.version !== 1 ||
    value.invocation !== invocation ||
    value.manifestDigest !== digest ||
    !['passed', 'failed'].includes(value.state)
  )
    throw new Error('Trusted Docker terminal identity changed');
  validateCommandOutcome(value.command);
  validateOutputOutcome(value.output);
  if (
    !['confirmed', 'unconfirmed', 'not-started'].includes(value.cleanup.state) ||
    !['none', 'cancelled', 'capture-failed', 'owner-signal'].includes(value.interruption) ||
    ![null, 'identity', 'control', 'launch'].includes(value.failure)
  )
    throw new Error('Invalid trusted Docker terminal outcome');
  if ((value.state === 'passed') !== hasPassingOutcome(value))
    throw new Error('Inconsistent trusted Docker terminal outcome');
  return value;
}
