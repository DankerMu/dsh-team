import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { constants as operatingSystemConstants } from 'node:os';

/** @typedef {{device: string, inode: string, owner: string, mode: number}} PrivateIdentity */
/** @typedef {{version: number, invocation: string, directory: PrivateIdentity, journal: PrivateIdentity, pending: PrivateIdentity, observers: PrivateIdentity, browserExec: PrivateIdentity}} SubmissionAuthority */
/** @typedef {{authority: SubmissionAuthority, anchorIdentity: PrivateIdentity, text: string}} CapturedAuthority */
/** @typedef {{id: string, captured: CapturedAuthority, markerIdentity: PrivateIdentity, markerText: string}} SubmissionReservation */
/** @typedef {'submitted' | 'settled' | 'client-closed-unknown'} SubmissionState */
/** @typedef {{exitCode: number | null, signal: string | null, failure: 'callback' | 'timeout' | 'output-limit' | 'spawn' | 'exit' | null}} BrowserExecClientOutcome */

export const SUBMISSION_JOURNAL = 'submission-evidence/submissions.jsonl';
export const SUBMISSION_PENDING = 'submission-evidence/pending';
export const SUBMISSION_AUTHORITY = 'submission-authority.json';
export const SUBMISSION_OBSERVERS = 'observers';
export const BROWSER_EXEC_AUTHORITY = 'browser-execs';
export const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function identity(info, directory, links = 1) {
  if (
    !(directory ? info.isDirectory() : info.isFile()) ||
    info.uid !== process.getuid() ||
    (info.mode & 0o077) !== 0 ||
    (!directory && info.nlink !== links)
  )
    throw new Error('Verification submission authority unavailable');
  return {
    device: String(info.dev),
    inode: String(info.ino),
    owner: String(info.uid),
    mode: info.mode & 0o777,
  };
}

export function sameIdentity(actual, expected) {
  if (
    actual.device !== expected.device ||
    actual.inode !== expected.inode ||
    actual.owner !== expected.owner ||
    actual.mode !== expected.mode
  )
    throw new Error('Verification submission authority changed');
}

export function openPrivate(path, flags, directory = false, expected, links = 1) {
  const descriptor = openSync(
    path,
    flags | constants.O_NOFOLLOW | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0),
    0o600,
  );
  try {
    const found = identity(fstatSync(descriptor), directory, links);
    if (expected !== undefined) sameIdentity(found, expected);
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

/** @returns {PrivateIdentity} */
export function pathIdentity(path, directory = false, links = 1) {
  const descriptor = openPrivate(path, constants.O_RDONLY, directory, undefined, links);
  try {
    return identity(fstatSync(descriptor), directory, links);
  } finally {
    closeSync(descriptor);
  }
}

export function syncDirectory(path) {
  const descriptor = openPrivate(path, constants.O_RDONLY, true);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeComplete(descriptor, text) {
  const bytes = Buffer.from(text);
  if (writeSync(descriptor, bytes) !== bytes.length)
    throw new Error('Verification submission evidence incomplete');
  fsyncSync(descriptor);
}

/** @returns {PrivateIdentity} */
export function createPrivate(path, text) {
  const descriptor = openPrivate(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
  try {
    const found = identity(fstatSync(descriptor), false);
    writeComplete(descriptor, typeof text === 'function' ? text(found) : text);
    sameIdentity(identity(fstatSync(descriptor), false), found);
    return found;
  } finally {
    closeSync(descriptor);
  }
}

/** @returns {string} */
export function readPrivate(path, expected, links = 1) {
  const descriptor = openPrivate(path, constants.O_RDONLY, false, expected, links);
  try {
    const size = fstatSync(descriptor).size;
    if (size > 4096) throw new Error('Verification submission authority exceeds bound');
    const bytes = Buffer.alloc(size + 1);
    const length = readSync(descriptor, bytes, 0, bytes.length, 0);
    if (length !== size) throw new Error('Verification submission authority changed');
    return bytes.subarray(0, length).toString('utf8');
  } finally {
    closeSync(descriptor);
  }
}

/** The anchor stays outside the independently mountable writable evidence directory. */
export function initializeVerificationSubmissions(directory) {
  pathIdentity(directory, true);
  const storage = join(directory, 'submission-evidence');
  mkdirSync(storage, { mode: 0o700 });
  mkdirSync(join(directory, SUBMISSION_PENDING), { mode: 0o700 });
  mkdirSync(join(directory, SUBMISSION_OBSERVERS), { mode: 0o700 });
  mkdirSync(join(directory, BROWSER_EXEC_AUTHORITY), { mode: 0o700 });
  createPrivate(join(directory, SUBMISSION_JOURNAL), '');
  const authority = {
    version: 1,
    invocation: randomUUID(),
    directory: pathIdentity(storage, true),
    journal: pathIdentity(join(directory, SUBMISSION_JOURNAL)),
    pending: pathIdentity(join(directory, SUBMISSION_PENDING), true),
    observers: pathIdentity(join(directory, SUBMISSION_OBSERVERS), true),
    browserExec: pathIdentity(join(directory, BROWSER_EXEC_AUTHORITY), true),
  };
  syncDirectory(join(directory, SUBMISSION_PENDING));
  syncDirectory(join(directory, SUBMISSION_OBSERVERS));
  syncDirectory(join(directory, BROWSER_EXEC_AUTHORITY));
  syncDirectory(storage);
  createPrivate(join(directory, SUBMISSION_AUTHORITY), `${JSON.stringify(authority)}\n`);
  syncDirectory(directory);
}

function requireStoredIdentity(value) {
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'device,inode,mode,owner' ||
    typeof value.device !== 'string' ||
    typeof value.inode !== 'string' ||
    typeof value.owner !== 'string' ||
    !Number.isInteger(value.mode) ||
    value.mode < 0 ||
    value.mode > 0o777 ||
    !/^\d+$/.test(value.owner) ||
    !/^\d+$/.test(value.device) ||
    !/^\d+$/.test(value.inode)
  )
    throw new Error('Malformed verification submission authority');
}

/** @returns {CapturedAuthority} */
export function captureAuthority(directory, captured) {
  const anchor = join(directory, SUBMISSION_AUTHORITY);
  const anchorIdentity = pathIdentity(anchor);
  if (captured !== undefined) sameIdentity(anchorIdentity, captured.anchorIdentity);
  const text = readPrivate(anchor, anchorIdentity);
  if (captured !== undefined && text !== captured.text)
    throw new Error('Verification submission authority changed');
  const authority = JSON.parse(text);
  if (
    authority?.version !== 1 ||
    !UUID.test(authority.invocation ?? '') ||
    Object.keys(authority).sort().join(',') !==
      'browserExec,directory,invocation,journal,observers,pending,version'
  )
    throw new Error('Malformed verification submission authority');
  for (const name of ['directory', 'journal', 'pending', 'observers', 'browserExec'])
    requireStoredIdentity(authority[name]);
  sameIdentity(pathIdentity(join(directory, 'submission-evidence'), true), authority.directory);
  sameIdentity(pathIdentity(join(directory, SUBMISSION_JOURNAL)), authority.journal);
  sameIdentity(pathIdentity(join(directory, SUBMISSION_PENDING), true), authority.pending);
  return { authority, anchorIdentity, text };
}

function append(path, id, state, expected, detail = {}) {
  const descriptor = openPrivate(path, constants.O_WRONLY | constants.O_APPEND, false, expected);
  try {
    writeComplete(descriptor, `${JSON.stringify({ version: 1, id, state, ...detail })}\n`);
  } finally {
    // A successful close, as well as fsync, must precede marker retirement.
    closeSync(descriptor);
  }
}

function submissionMarker(id, generation) {
  if (!UUID.test(id) || (generation !== undefined && !UUID.test(generation)))
    throw new Error('Verification submission marker scope malformed');
  return generation === undefined ? id : `${generation}.${id}`;
}

/** @returns {SubmissionReservation} */
export function reserveSubmission(directory, markerFields = {}, requestGeneration, detail = {}) {
  const captured = captureAuthority(directory);
  const id = randomUUID();
  if (requestGeneration !== undefined && markerFields.observer !== requestGeneration)
    throw new Error('Verification submission request generation changed');
  const marker = join(directory, SUBMISSION_PENDING, submissionMarker(id, requestGeneration));
  const markerText = `${JSON.stringify({ version: 1, id, invocation: captured.authority.invocation, ...markerFields })}\n`;
  const markerIdentity = createPrivate(marker, markerText);
  syncDirectory(join(directory, SUBMISSION_PENDING));
  captureAuthority(directory, captured);
  append(join(directory, SUBMISSION_JOURNAL), id, 'submitted', captured.authority.journal, detail);
  return { id, captured, markerIdentity, markerText };
}

export function submissionPublication(directory, reservation, requestGeneration) {
  const { id, captured, markerIdentity, markerText } = reservation;
  const path = join(directory, SUBMISSION_JOURNAL);
  const marker = join(directory, SUBMISSION_PENDING, submissionMarker(id, requestGeneration));
  let attempted = false;
  return (state, detail = {}) => {
    if (attempted) throw new Error('Verification submission completion already attempted');
    attempted = true;
    captureAuthority(directory, captured);
    if (readPrivate(marker, markerIdentity) !== markerText)
      throw new Error('Verification submission pending marker changed');
    append(path, id, state, captured.authority.journal, detail);
    captureAuthority(directory, captured);
    if (readPrivate(marker, markerIdentity) !== markerText)
      throw new Error('Verification submission pending marker changed');
    // All validation and descriptor closure precede this final positive publication step.
    unlinkSync(marker);
  };
}

export function submissionCompletion(directory, reservation, requestGeneration) {
  const publish = submissionPublication(directory, reservation, requestGeneration);
  return () => publish('settled');
}

export function requireBrowserExecClient(client) {
  if (
    !client ||
    Object.keys(client).sort().join(',') !== 'exitCode,failure,signal' ||
    (client.exitCode !== null &&
      (!Number.isSafeInteger(client.exitCode) ||
        client.exitCode > 255 ||
        (client.exitCode < 0 && client.failure !== 'spawn'))) ||
    (client.signal !== null && !Object.hasOwn(operatingSystemConstants.signals, client.signal)) ||
    ![null, 'callback', 'timeout', 'output-limit', 'spawn', 'exit'].includes(client.failure)
  )
    throw new Error('Browser exec client closure outcome malformed');
}
