import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  BROWSER_EXEC_AUTHORITY,
  SUBMISSION_JOURNAL,
  SUBMISSION_PENDING,
  UUID,
  captureAuthority,
  openPrivate,
  pathIdentity,
  readPrivate,
  requireBrowserExecClient,
  requireSubmissionCall,
  sameIdentity,
} from './verification-submission-storage.mjs';
import { readVerificationDockerObserverWriters } from './verification-docker-generations.mjs';

/** @typedef {{id: string, authority: import('./probe-browser-exec.mjs').BrowserExecAuthority, client: import('./verification-submission-storage.mjs').BrowserExecClientOutcome}} BrowserExecSubmission */
/** @typedef {{writers: import('./verification-docker-generations.mjs').DockerObserverWitness[], browserExec: BrowserExecSubmission[]}} VerificationSubmissionAssessment */
/** @typedef {{operationOutcome: 'unknown', executionCapability: 'retired', submissions: number, sha256: string}} BrowserExecRetirementSummary */
/** @typedef {{state: 'confirmed' | 'unconfirmed' | 'not-started', browserExec: BrowserExecRetirementSummary | null}} CleanupAssessment */
/** @typedef {{states: Map<string, import('./verification-submission-storage.mjs').SubmissionState>, execDigests: Map<string, string>, execOutcomes: Map<string, import('./verification-submission-storage.mjs').BrowserExecClientOutcome>}} SubmissionRecords */

function readJournalText(descriptor) {
  // The complete ordinary suite may issue thousands of operations; evidence stays bounded.
  const limit = 8 * 1024 * 1024;
  if (fstatSync(descriptor).size > limit)
    throw new Error('Verification submission evidence exceeds bound');
  const buffer = Buffer.alloc(limit + 1);
  let length = 0;
  while (length < buffer.length) {
    const bytes = readSync(descriptor, buffer, length, buffer.length - length, length);
    if (bytes === 0) break;
    length += bytes;
  }
  if (length > limit) throw new Error('Verification submission evidence exceeds bound');
  const text = buffer.subarray(0, length).toString('utf8');
  if (text && !text.endsWith('\n')) throw new Error('Incomplete verification submission evidence');
  return text;
}

function submissionFields(value) {
  if (value.state === 'submitted' && Object.hasOwn(value, 'browserExec'))
    return 'browserExec,id,state,version';
  // Rows written before call labels existed omit `call` and remain valid.
  if (value.state === 'submitted' && Object.hasOwn(value, 'call')) return 'call,id,state,version';
  if (value.state === 'client-closed-unknown') return 'client,id,state,version';
  return 'id,state,version';
}

function requireSubmissionTransition(value, states) {
  if (
    !value ||
    Object.keys(value).sort().join(',') !== submissionFields(value) ||
    value.version !== 1 ||
    !UUID.test(value.id ?? '') ||
    !['submitted', 'settled', 'client-closed-unknown'].includes(value.state) ||
    (value.state === 'submitted' ? states.has(value.id) : states.get(value.id) !== 'submitted')
  )
    throw new Error('Malformed verification submission evidence');
}

function recordUnknownExec(value, records) {
  requireBrowserExecClient(value.client);
  if (
    !records.execDigests.has(value.id) ||
    (value.client.exitCode === 0 && value.client.signal === null && value.client.failure === null)
  )
    throw new Error('Unknown outcome is not a qualified browser exec');
  records.execOutcomes.set(value.id, value.client);
}

/** @returns {SubmissionRecords} */
function parseSubmissionRecords(text) {
  /** @type {SubmissionRecords} */
  const records = { states: new Map(), execDigests: new Map(), execOutcomes: new Map() };
  for (const line of text.split('\n').filter(Boolean)) {
    const value = JSON.parse(line);
    requireSubmissionTransition(value, records.states);
    if (Object.hasOwn(value, 'call')) requireSubmissionCall(value.call);
    if (value.state === 'submitted' && Object.hasOwn(value, 'browserExec')) {
      if (!/^[a-f0-9]{64}$/.test(value.browserExec ?? ''))
        throw new Error('Browser exec submission authority malformed');
      records.execDigests.set(value.id, value.browserExec);
    }
    if (value.state === 'client-closed-unknown') recordUnknownExec(value, records);
    records.states.set(value.id, value.state);
  }
  return records;
}

/** @returns {SubmissionRecords} */
function readSubmissionStates(directory, captured) {
  const descriptor = openPrivate(
    join(directory, SUBMISSION_JOURNAL),
    constants.O_RDONLY,
    false,
    captured.authority.journal,
  );
  try {
    return parseSubmissionRecords(readJournalText(descriptor));
  } finally {
    closeSync(descriptor);
  }
}

function readExecGrant(directory, name, captured, records) {
  const id = name.endsWith('.json') ? name.slice(0, -5) : '';
  if (!UUID.test(id) || !records.execDigests.has(id))
    throw new Error('Browser exec authority name changed');
  const grant = JSON.parse(readPrivate(join(directory, BROWSER_EXEC_AUTHORITY, name)));
  if (
    !grant ||
    Object.keys(grant).sort().join(',') !== 'authority,id,invocation,version' ||
    grant.version !== 1 ||
    grant.id !== id ||
    grant.invocation !== captured.authority.invocation ||
    createHash('sha256').update(JSON.stringify(grant.authority)).digest('hex') !==
      records.execDigests.get(id)
  )
    throw new Error('Browser exec immutable authority changed');
  return grant;
}

/** @returns {BrowserExecSubmission[]} */
function readUnknownExecs(directory, captured, records) {
  sameIdentity(
    pathIdentity(join(directory, BROWSER_EXEC_AUTHORITY), true),
    captured.authority.browserExec,
  );
  const grants = readdirSync(join(directory, BROWSER_EXEC_AUTHORITY));
  if (grants.length !== records.execDigests.size)
    throw new Error('Browser exec authority inventory changed');
  /** @type {BrowserExecSubmission[]} */
  const browserExec = [];
  for (const name of grants) {
    const grant = readExecGrant(directory, name, captured, records);
    const client = records.execOutcomes.get(grant.id);
    if (client !== undefined)
      browserExec.push({ id: grant.id, authority: grant.authority, client });
  }
  return browserExec;
}

function readCapturedSubmissions(directory) {
  const captured = captureAuthority(directory);
  return { captured, records: readSubmissionStates(directory, captured) };
}

/**
 * Writer inventory before post-cancellation retirement. Reservations may remain open; every
 * generation must be complete except a current initialized generation bound to an exempt
 * container, the caller's own exactly bound platform that it drains before any removal.
 * @param {string} directory
 * @param {ReadonlySet<string>} exempt
 * @returns {import('./verification-docker-generations.mjs').DockerObserverWitness[]}
 */
export function readVerificationWritersBeforeRetirement(directory, exempt) {
  const { captured, records } = readCapturedSubmissions(directory);
  captureAuthority(directory, captured);
  return readVerificationDockerObserverWriters(directory, records.states, captured, exempt);
}

/**
 * Validate every durable outcome without granting operation or capability settlement.
 * @param {string} directory
 * @returns {VerificationSubmissionAssessment}
 */
export function readVerificationSubmissionsForCleanup(directory) {
  const { captured, records } = readCapturedSubmissions(directory);
  if (
    [...records.states.values()].some(
      (state) => !['settled', 'client-closed-unknown'].includes(state),
    )
  )
    throw new Error('Verification submission settlement unconfirmed');
  captureAuthority(directory, captured);
  if (readdirSync(join(directory, SUBMISSION_PENDING)).length !== 0)
    throw new Error('Verification submission settlement unconfirmed');
  const browserExec = readUnknownExecs(directory, captured, records);
  const writers = readVerificationDockerObserverWriters(directory, records.states, captured);
  return { writers, browserExec };
}

/**
 * Generic settlement never treats retired capability as daemon acknowledgement.
 * @param {string} directory
 * @returns {import('./verification-docker-generations.mjs').DockerObserverWitness[]}
 */
export function requireVerificationSubmissionsSettled(directory) {
  const evidence = readVerificationSubmissionsForCleanup(directory);
  if (evidence.browserExec.length !== 0)
    throw new Error('Verification submission settlement unconfirmed');
  return evidence.writers;
}

/**
 * The terminal carries only a bounded projection, never a copy of submission records.
 * @param {string[]} ids
 * @returns {BrowserExecRetirementSummary}
 */
export function browserExecRetirementSummary(ids) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => !UUID.test(id)))
    throw new Error('Browser exec retirement identities malformed');
  const unique = [...new Set(ids)].sort();
  return {
    operationOutcome: 'unknown',
    executionCapability: 'retired',
    submissions: unique.length,
    sha256: createHash('sha256').update(JSON.stringify(unique)).digest('hex'),
  };
}
