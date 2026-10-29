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
import { fileURLToPath } from 'node:url';

/** @typedef {{device: string, inode: string, owner: string, mode: number}} PrivateIdentity */
/** @typedef {{version: number, invocation: string, directory: PrivateIdentity, journal: PrivateIdentity, pending: PrivateIdentity, observers: PrivateIdentity, browserExec: PrivateIdentity}} SubmissionAuthority */
/** @typedef {{authority: SubmissionAuthority, anchorIdentity: PrivateIdentity, text: string}} CapturedAuthority */
/** @typedef {{id: string, captured: CapturedAuthority, markerIdentity: PrivateIdentity, markerText: string}} SubmissionReservation */
/** @typedef {'submitted' | 'settled' | 'client-closed-unknown'} SubmissionState */
/** @typedef {{exitCode: number | null, signal: string | null, failure: 'callback' | 'timeout' | 'output-limit' | 'spawn' | 'exit' | null}} BrowserExecClientOutcome */
/** @typedef {{transport: 'cli' | 'http', operation: string, caller: string}} SubmissionCall */

export const SUBMISSION_JOURNAL = 'submission-evidence/submissions.jsonl';
export const SUBMISSION_PENDING = 'submission-evidence/pending';
export const SUBMISSION_AUTHORITY = 'submission-authority.json';
export const SUBMISSION_OBSERVERS = 'observers';
export const BROWSER_EXEC_AUTHORITY = 'browser-execs';
export const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
// Shared by the unsettled-projection writer and the terminal parser.
export const UNSETTLED_LABEL_LIMIT = 32;

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

// Closed call vocabulary: one table each for CLI and HTTP, shared by derivation and validation.
const CLI_VERBS = new Set(
  (
    'attach bake build builder buildx commit compose config container context cp create diff ' +
    'events exec export history image images import info inspect kill load login logout logs ' +
    'manifest network node pause plugin port ps pull push rename restart rm rmi run save search ' +
    'secret service stack start stats stop swarm system tag top trust unpause update version ' +
    'volume wait'
  ).split(' '),
);
const CLI_SUBCOMMANDS = new Map(
  Object.entries({
    container:
      'attach commit cp create diff exec export inspect kill list logs ls pause port prune ' +
      'remove rename restart rm run start stats stop top unpause update wait',
    image: 'build history import inspect list load ls prune pull push remove rm save tag',
    network: 'connect create disconnect inspect list ls prune remove rm',
    volume: 'create inspect list ls prune remove rm update',
    compose:
      'attach build commit config cp create down events exec export images kill logs ls pause ' +
      'port ps pull push restart rm run scale start stats stop top unpause up version volumes ' +
      'wait watch',
    buildx: 'bake build create du history imagetools inspect ls prune rm stop use version',
  }).map(([group, names]) => [group, new Set(names.split(' '))]),
);
const CLI_OPERATIONS = new Set([
  'other',
  ...CLI_VERBS,
  ...[...CLI_SUBCOMMANDS].flatMap(([group, names]) => [...names].map((name) => `${group} ${name}`)),
]);
// `{id}` is the single resource-segment class of the qualified rejection matrix.
const RESOURCE_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const HTTP_OPERATIONS = new Set([
  'other',
  ...[
    'POST /containers/create',
    'POST /containers/prune',
    'DELETE /containers/{id}',
    ...'start stop restart kill pause unpause update rename resize attach exec'
      .split(' ')
      .map((action) => `POST /containers/{id}/${action}`),
    'PUT /containers/{id}/archive',
    'POST /exec/{id}/start',
    'POST /exec/{id}/resize',
    'POST /networks/create',
    'POST /networks/prune',
    'POST /networks/{id}/connect',
    'POST /networks/{id}/disconnect',
    'DELETE /networks/{id}',
    'POST /volumes/create',
    'POST /volumes/prune',
    'PUT /volumes/{id}',
    'DELETE /volumes/{id}',
    'POST /images/create',
    'POST /images/load',
    'POST /images/prune',
    'POST /images/{id}/tag',
    'POST /images/{id}/push',
    'DELETE /images/{id}',
    'POST /build',
    'POST /build/prune',
    'POST /commit',
  ],
]);
const HTTP_TEMPLATES = [...HTTP_OPERATIONS]
  .filter((operation) => operation !== 'other')
  .map((operation) => {
    const [method, template] = operation.split(' ');
    return { operation, method, segments: String(template).split('/') };
  });
const CALLER = /^[a-z0-9][a-z0-9.-]*\.(?:ts|mts|mjs)$/;
const CALLER_WRAPPERS = new Set(['docker-command.ts', 'docker-cleanup.ts']);
// The anchored location is `at name (<location>:line:column)` or `at <location>:line:column`;
// V8 prefixes a suspended async frame, including an anonymous one, with `async `.
const FRAME = /^\s*at (?:async )?(?:[^(]*\()?(.+?):\d+:\d+\)?$/;

function guarded(derive, fallback) {
  try {
    return derive();
  } catch {
    return fallback;
  }
}

function cliOperation(args) {
  const verb = args[0];
  if (typeof verb !== 'string' || !CLI_VERBS.has(verb)) return 'other';
  const subcommand = args[1];
  return typeof subcommand === 'string' && CLI_SUBCOMMANDS.get(verb)?.has(subcommand)
    ? `${verb} ${subcommand}`
    : verb;
}

function templateMatches(segments, endpoint) {
  return (
    segments.length === endpoint.length &&
    segments.every((segment, index) =>
      segment === '{id}'
        ? RESOURCE_SEGMENT.test(endpoint[index] ?? '')
        : segment === endpoint[index],
    )
  );
}

function httpOperation(method, path) {
  const query = path.indexOf('?');
  const endpoint = (query === -1 ? path : path.slice(0, query)).split('/');
  return (
    HTTP_TEMPLATES.find(
      (entry) => entry.method === method && templateMatches(entry.segments, endpoint),
    )?.operation ?? 'other'
  );
}

function frameName(line, prefixes) {
  const location = FRAME.exec(line)?.[1];
  const prefix = prefixes.find((candidate) => location?.startsWith(candidate));
  const name = prefix === undefined ? undefined : location?.slice(prefix.length);
  return name !== undefined && CALLER.test(name) ? name : undefined;
}

/**
 * The first issuing test file under this repository's `platform/test/`, else its first
 * non-wrapper module there; only a validated basename can leave this function.
 * @param {string} stack
 * @returns {string}
 */
export function submissionCallerFromStack(stack) {
  // Anchored from this module, never from the process or a filesystem lookup.
  const directory = new URL('../platform/test/', import.meta.url);
  const prefixes = [directory.href, fileURLToPath(directory)];
  const names = stack
    .split('\n')
    .map((line) => frameName(line, prefixes))
    .filter((name) => name !== undefined);
  return (
    names.find((name) => name.endsWith('.test.ts')) ??
    names.find((name) => !CALLER_WRAPPERS.has(name)) ??
    'unknown'
  );
}

/** @returns {string} */
export function submissionCaller() {
  // Test runners lower the stack limit; raise it only for this capture.
  const limit = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = 64;
    const stack = new Error().stack;
    return typeof stack === 'string' ? submissionCallerFromStack(stack) : 'unknown';
  } catch {
    return 'unknown';
  } finally {
    Error.stackTraceLimit = limit;
  }
}

/**
 * @param {readonly string[]} args
 * @returns {SubmissionCall}
 */
export function cliSubmissionCall(args) {
  return {
    transport: 'cli',
    operation: guarded(() => cliOperation(args), 'other'),
    caller: submissionCaller(),
  };
}

// An issuing test file wins, from the call-time stack first; fixture json wrappers dispatched
// through promise queues otherwise hide the test file captured at construction.
function preferredCaller(caller, constructionCaller) {
  if (caller.endsWith('.test.ts') || !constructionCaller.endsWith('.test.ts'))
    return caller === 'unknown' ? constructionCaller : caller;
  return constructionCaller;
}

/**
 * @param {string} method
 * @param {string} path
 * @param {string} [constructionCaller] the tracked client's construction-point caller
 * @returns {SubmissionCall}
 */
export function httpSubmissionCall(method, path, constructionCaller = 'unknown') {
  return {
    transport: 'http',
    operation: guarded(() => httpOperation(method, path), 'other'),
    caller: preferredCaller(submissionCaller(), constructionCaller),
  };
}

/**
 * Validates exactly three own keys, then their values read once into a fresh plain label, so
 * an accessor or inherited `toJSON` cannot change what is serialized after validation.
 * @param {unknown} call
 * @returns {SubmissionCall}
 */
export function requireSubmissionCall(call) {
  const label =
    typeof call === 'object' &&
    call !== null &&
    Object.keys(call).sort().join(',') === 'caller,operation,transport'
      ? { transport: call.transport, operation: call.operation, caller: call.caller }
      : null;
  const operations =
    label?.transport === 'cli'
      ? CLI_OPERATIONS
      : label?.transport === 'http'
        ? HTTP_OPERATIONS
        : null;
  if (
    operations === null ||
    !operations.has(label.operation) ||
    typeof label.caller !== 'string' ||
    (label.caller !== 'unknown' && !CALLER.test(label.caller))
  )
    throw new Error('Verification submission call label malformed');
  return label;
}
