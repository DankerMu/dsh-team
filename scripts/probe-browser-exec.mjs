import { deepStrictEqual } from 'node:assert';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { processIdentity } from './probe-browser-native.mjs';
import { readReceipt } from './probe-browser-receipt.mjs';
import {
  CONTAINER_ID,
  requireCleanupAuthority,
  requireProfileOwnership,
} from './probe-browser-runtime.mjs';

function requireExecIdentity(receipt) {
  if (
    receipt.kind !== 'docker-isolated-network' ||
    !['running', 'stopped'].includes(receipt.state) ||
    !CONTAINER_ID.test(receipt.containerId ?? '') ||
    !CONTAINER_ID.test(receipt.networkId ?? '') ||
    !/^[a-f0-9]{64}$/.test(receipt.chromeSha256 ?? '') ||
    receipt.acquisition?.state !== 'settled'
  )
    throw new Error('Browser exec authority is incomplete');
}

function requireExecSocket(receipt) {
  if (
    !isAbsolute(receipt.profile ?? '') ||
    !isAbsolute(receipt.socketDirectory ?? '') ||
    !receipt.socketIdentity ||
    Object.keys(receipt.socketIdentity).sort().join(',') !== 'device,inode' ||
    !/^[0-9]+$/.test(receipt.socketIdentity.device ?? '') ||
    !/^[0-9]+$/.test(receipt.socketIdentity.inode ?? '')
  )
    throw new Error('Browser exec authority is incomplete');
}

function requireExecRuntime(receipt) {
  if (
    !Number.isSafeInteger(receipt.privateUid) ||
    receipt.privateUid <= 0 ||
    receipt.privateNodeVersion !== 'v24.13.1'
  )
    throw new Error('Browser exec authority is incomplete');
}

function browserExecFields(receipt) {
  requireCleanupAuthority(receipt);
  requireExecIdentity(receipt);
  requireExecSocket(receipt);
  requireExecRuntime(receipt);
  return {
    nonce: receipt.nonce,
    containerId: receipt.containerId,
    containerName: receipt.containerName,
    networkId: receipt.networkId,
    networkName: receipt.networkName,
    networkConfig: receipt.networkConfig,
    imageId: receipt.imageId,
    chromeSha256: receipt.chromeSha256,
    runId: receipt.runId,
    profile: receipt.profile,
    socketDirectory: receipt.socketDirectory,
    socketIdentity: receipt.socketIdentity,
    privateUid: receipt.privateUid,
    privateNodeVersion: receipt.privateNodeVersion,
    driver: processIdentity(receipt.driver),
    producer: processIdentity(receipt.acquisition.producer),
  };
}

async function browserAuthorityDirectory(path) {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o777) !== 0o700 ||
    (await realpath(path)) !== path
  )
    throw new Error('Browser exec receipt directory authority changed');
  return {
    device: String(info.dev),
    inode: String(info.ino),
    owner: String(info.uid),
    mode: 0o700,
  };
}

/** Capture before exec dispatch; only immutable browser authority survives lifecycle updates. */
export async function captureBrowserExecAuthority(target) {
  if (
    !target ||
    Object.keys(target).sort().join(',') !== 'containerId,receiptFile' ||
    !CONTAINER_ID.test(target.containerId ?? '') ||
    !isAbsolute(target.receiptFile ?? '')
  )
    throw new Error('Browser exec requires canonical receipt and immutable container ID');
  if ((await realpath(target.receiptFile)) !== target.receiptFile)
    throw new Error('Browser exec receipt path is not canonical');
  const receipt = await readReceipt(target.receiptFile);
  await requireProfileOwnership(receipt.profile, target.receiptFile);
  const browser = browserExecFields(receipt);
  if (browser.containerId !== target.containerId)
    throw new Error('Browser exec target does not match captured receipt');
  const directory = process.env.DSH_TEAM_BROWSER_RECEIPT_DIRECTORY;
  let pointer = null;
  let directoryIdentity = null;
  if (directory !== undefined) {
    directoryIdentity = await browserAuthorityDirectory(directory);
    pointer = join(directory, `${receipt.nonce}.launch.json`);
    const registered = await readReceipt(pointer);
    if (registered.receiptFile !== target.receiptFile)
      throw new Error('Browser exec registration belongs to another receipt');
    for (const key of [
      'nonce',
      'kind',
      'profile',
      'imageId',
      'chromeSha256',
      'runId',
      'driver',
      'networkConfig',
    ])
      deepStrictEqual(registered[key], receipt[key], 'Browser exec registration authority changed');
  } else if (process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS) {
    throw new Error('Custodied browser exec registration is missing');
  }
  return { version: 1, receiptFile: target.receiptFile, pointer, directoryIdentity, browser };
}

/** Final read-only assessment uses the retained canonical pointer, not a deleted profile root. */
export async function readBrowserExecRetirementReceipt(authority) {
  if (
    authority?.version !== 1 ||
    typeof authority.pointer !== 'string' ||
    authority.pointer !==
      join(dirname(authority.pointer), `${authority.browser?.nonce}.launch.json`)
  )
    throw new Error('Browser exec retained authority unavailable');
  deepStrictEqual(
    await browserAuthorityDirectory(dirname(authority.pointer)),
    authority.directoryIdentity,
  );
  const receipt = await readReceipt(authority.pointer);
  if (receipt.receiptFile !== authority.receiptFile)
    throw new Error('Browser exec retained receipt changed');
  deepStrictEqual(
    browserExecFields(receipt),
    authority.browser,
    'Browser exec retained authority changed',
  );
  return receipt;
}
