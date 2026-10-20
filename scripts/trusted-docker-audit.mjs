import { lstat, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { createDockerCommands, isAbsentResource } from '../platform/test/docker-command.ts';
import { readCleanupJournal } from '../platform/test/docker-cleanup.ts';
import { readReceipt } from './probe-browser-receipt.mjs';
import { requireNetworkAuthority } from './probe-browser-network.mjs';
import { liveProcessBirth } from './probe-browser-native.mjs';
import {
  INVOCATION_PATTERN,
  privateDirectory,
  processIdentity,
  readCustodyRecord,
  requirePathIdentity,
} from './trusted-docker-record.mjs';

function requireAbsent(command, kind, target) {
  if (!isAbsentResource(command([kind, 'inspect', target], 30_000), kind, target))
    throw new Error('Trusted Docker resource retirement unconfirmed');
}

function requireEmptyOwnership(command, kind, ownership) {
  const args = [kind, 'ls', '--quiet'];
  if (kind === 'container' || kind === 'image') args.push('--all');
  for (const [name, value] of Object.entries(ownership))
    args.push('--filter', `label=${name}=${value}`);
  const result = command(args, 30_000);
  if (result.error || result.status !== 0 || result.stdout.trim())
    throw new Error('Trusted Docker owned inventory remains unconfirmed');
}

function requireContainedReceiptPath(temporary, path) {
  const location = relative(temporary, resolve(path));
  if (
    location === '' ||
    location === '..' ||
    location.startsWith('../') ||
    location.startsWith('/')
  )
    throw new Error('Trusted Docker browser authority escaped invocation');
}

function requireStoppedBrowserPointer(receipt, temporary) {
  if (
    receipt.kind !== 'docker-isolated-network' ||
    receipt.state !== 'stopped' ||
    typeof receipt.receiptFile !== 'string'
  )
    throw new Error('Trusted Docker browser retirement unconfirmed');
  requireContainedReceiptPath(temporary, receipt.receiptFile);
  requireNetworkAuthority(receipt);
  if (
    receipt.containerName !== `dsh-team-browser-${receipt.nonce}` ||
    (receipt.containerId !== null && !/^[a-f0-9]{64}$/.test(receipt.containerId ?? ''))
  )
    throw new Error('Trusted Docker browser container authority changed');
  if (!['not-started', 'settled'].includes(receipt.acquisition?.state))
    throw new Error('Trusted Docker browser creation settlement unconfirmed');
  if (
    receipt.acquisition.state === 'not-started' &&
    (receipt.containerId !== null || receipt.networkId !== null)
  )
    throw new Error('Trusted Docker browser creation state changed');
}

async function observeSocketAbsence(path, temporary) {
  if (typeof path !== 'string') throw new Error('Trusted Docker browser socket authority missing');
  requireContainedReceiptPath(temporary, path);
  try {
    await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Trusted Docker browser socket retirement unconfirmed');
}

async function observeBrowserPointer(command, path, temporary) {
  const receipt = await readReceipt(path);
  requireStoppedBrowserPointer(receipt, temporary);
  const identities = [processIdentity(receipt.driver)];
  if (receipt.acquisition.state === 'settled' || receipt.acquisition.producer !== undefined)
    identities.push(processIdentity(receipt.acquisition.producer));
  for (const identity of identities) {
    if ((await liveProcessBirth(identity.pid)) === identity.birth)
      throw new Error('Trusted Docker browser producer remains live');
  }
  if (receipt.acquisition.state === 'settled' || receipt.socketDirectory !== undefined)
    await observeSocketAbsence(receipt.socketDirectory, temporary);
  for (const [kind, name, id] of [
    ['container', receipt.containerName, receipt.containerId],
    ['network', receipt.networkName, receipt.networkId],
  ]) {
    requireAbsent(command, kind, name);
    if (id) requireAbsent(command, kind, id);
  }
}

async function observeBrowserDirectory(command, directory, temporary) {
  await privateDirectory(directory);
  const image = (await readCustodyRecord(join(directory, 'image.json'))).value;
  if (
    !INVOCATION_PATTERN.test(image.invocation ?? '') ||
    image.tag !== `dsh-team-browser-runtime-${image.invocation}` ||
    !/^sha256:[a-f0-9]{64}$/.test(image.imageId ?? '') ||
    image.cleanup?.image !== 'confirmed' ||
    image.cleanup?.browserResources !== 'confirmed'
  )
    throw new Error('Trusted Docker browser image retirement unconfirmed');
  for (const name of await readdir(directory)) {
    if (name.endsWith('.launch.json'))
      await observeBrowserPointer(command, join(directory, name), temporary);
  }
  requireAbsent(command, 'image', image.imageId);
  requireAbsent(command, 'image', image.tag);
  requireEmptyOwnership(command, 'image', { 'dsh-team.browser-invocation': image.invocation });
}

/** Read-only observation; the original root command remains the sole mutation/cleanup owner. */
export async function assessTrustedDockerCleanup(request, directory, settled, injectedCommand) {
  if (!settled) return { state: 'unconfirmed' };
  try {
    await requirePathIdentity(
      request.temporary,
      request.temporaryDevice,
      request.temporaryInode,
      true,
    );
    const journalPath = join(directory, 'resources.jsonl');
    const info = await lstat(journalPath);
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0)
      throw new Error('Trusted Docker journal authority unavailable');
    const command =
      injectedCommand ??
      createDockerCommands(request.root, join(directory, 'docker'), true).command;
    const entries = readCleanupJournal(journalPath);
    const observed = new Set();
    const inventories = new Set();
    for (const { target } of entries) {
      const identity = `${target.kind}:${target.name}`;
      if (!observed.has(identity)) {
        requireAbsent(command, target.kind, target.name);
        observed.add(identity);
      }
      const ownership = Object.fromEntries(Object.entries(target.ownership).sort());
      const query = `${target.kind}:${JSON.stringify(ownership)}`;
      if (!inventories.has(query)) {
        requireEmptyOwnership(command, target.kind, ownership);
        inventories.add(query);
      }
    }
    for (const name of await readdir(request.temporary)) {
      if (name.startsWith('dsh-browser-command-'))
        await observeBrowserDirectory(command, join(request.temporary, name), request.temporary);
    }
    return { state: 'confirmed' };
  } catch {
    return { state: 'unconfirmed' };
  }
}
