import { createHash, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { writeReceipt } from './probe-browser-receipt.mjs';
import { processIdentity } from './probe-browser-native.mjs';
import {
  SUBMISSION_PENDING,
  SUBMISSION_OBSERVERS,
  UUID,
  captureAuthority,
  createPrivate,
  pathIdentity,
  readPrivate,
  reserveSubmission,
  sameIdentity,
  submissionCompletion,
  syncDirectory,
} from './verification-submission-storage.mjs';

/** @typedef {{kind: 'process', pid: number, birth: string, generation: string}} DockerProcessWitness */
/** @typedef {{kind: 'container', id: string, imageId: string, authority: string, startedAt: string, generation: string}} DockerContainerWitness */
/** @typedef {DockerProcessWitness | DockerContainerWitness} DockerObserverWitness */

/**
 * @typedef {{
 *   directory: string,
 *   authority: string,
 *   bootstrap: string,
 *   generation: string,
 *   participant: string,
 *   capabilityPath: string,
 *   capabilityIdentity: { device: string, inode: string, owner: string, mode: number },
 *   capabilityDigest: string,
 *   bindingApproval: import('./verification-submission-storage.mjs').SubmissionReservation
 * }} DockerObserverReservation
 */

/**
 * @typedef {{
 *   directory: string,
 *   authority: string,
 *   bootstrap: string,
 *   authorityIdentity: { device: string, inode: string, owner: string, mode: number },
 *   authorityDigest: string
 * }} DockerObserverAuthority
 */

function observerBindingDigest(capability) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        nonce: capability.nonce,
        approval: capability.approval ?? null,
        authority: capability.authority,
        authorityIdentity: capability.authorityIdentity,
        authorityDigest: capability.authorityDigest,
        previous: capability.previous,
        directory: capability.directory,
        moduleUrl: capability.moduleUrl,
        socketPath: capability.socketPath,
        imageId: capability.imageId,
      }),
    )
    .digest('hex');
}

function requireObserverModuleUrl(moduleUrl) {
  if (typeof moduleUrl !== 'string')
    throw new Error('Docker observer container authority unavailable');
  const parsed = new URL(moduleUrl);
  if (
    parsed.protocol !== 'file:' ||
    parsed.hostname !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  )
    throw new Error('Docker observer container authority unavailable');
}

function requireObserverLocation(value, bootstrap) {
  if (
    value?.version !== 1 ||
    !UUID.test(value.nonce ?? '') ||
    typeof value.directory !== 'string' ||
    !isAbsolute(value.directory) ||
    bootstrap !== join(value.directory, SUBMISSION_OBSERVERS, value.nonce)
  )
    throw new Error('Docker observer container authority unavailable');
}

function requireObserverRuntime(value) {
  requireObserverModuleUrl(value.moduleUrl);
  if (
    typeof value.socketPath !== 'string' ||
    !isAbsolute(value.socketPath) ||
    value.socketPath.includes('\0') ||
    (value.imageId !== null && !/^sha256:[a-f0-9]{64}$/.test(value.imageId ?? ''))
  )
    throw new Error('Docker observer container authority unavailable');
}

function readObserverAuthority(bootstrap, expectedIdentity, expectedDigest) {
  const path = join(bootstrap, 'authority.json');
  const found = pathIdentity(path);
  if (expectedIdentity !== undefined) sameIdentity(found, expectedIdentity);
  const text = readPrivate(path, found);
  const digest = createHash('sha256').update(text).digest('hex');
  if (expectedDigest !== undefined && digest !== expectedDigest)
    throw new Error('Docker observer container authority changed');
  const value = JSON.parse(text);
  requireObserverLocation(value, bootstrap);
  requireObserverRuntime(value);
  sameIdentity(pathIdentity(bootstrap, true), value.folderIdentity);
  const captured = captureAuthority(value.directory, value.captured);
  if (JSON.stringify(captured) !== JSON.stringify(value.captured))
    throw new Error('Docker observer container authority changed');
  return { value, identity: found, digest };
}

/**
 * Stable readonly bootstrap authority for one container; process generations never reuse grants.
 * @param {string} directory
 * @param {{ moduleUrl: string, socketPath: string, imageId?: string }} options
 * @returns {DockerObserverAuthority}
 */
export function createVerificationDockerObserverAuthority(directory, options) {
  const captured = captureAuthority(directory);
  sameIdentity(
    pathIdentity(join(directory, SUBMISSION_OBSERVERS), true),
    captured.authority.observers,
  );
  const authority = randomUUID();
  const bootstrap = join(directory, SUBMISSION_OBSERVERS, authority);
  mkdirSync(bootstrap, { mode: 0o700 });
  const value = {
    version: 1,
    nonce: authority,
    directory,
    moduleUrl: options.moduleUrl,
    socketPath: options.socketPath,
    imageId: options.imageId ?? null,
    folderIdentity: pathIdentity(bootstrap, true),
    captured,
  };
  const text = `${JSON.stringify(value)}\n`;
  const authorityIdentity = createPrivate(join(bootstrap, 'authority.json'), text);
  const authorityDigest = createHash('sha256').update(text).digest('hex');
  syncDirectory(bootstrap);
  syncDirectory(join(directory, SUBMISSION_OBSERVERS));
  readObserverAuthority(bootstrap, authorityIdentity, authorityDigest);
  return { directory, authority, bootstrap, authorityIdentity, authorityDigest };
}

function readObserverManifest(bootstrap, authority) {
  const manifest = JSON.parse(readPrivate(join(bootstrap, 'current.json')));
  if (
    manifest?.version !== 1 ||
    !UUID.test(manifest.nonce ?? '') ||
    manifest.authority !== authority ||
    Object.keys(manifest).sort().join(',') !== 'authority,nonce,version'
  )
    throw new Error('Docker observer process generation manifest unavailable');
  return manifest;
}

function requireCapabilityIdentifiers(capability) {
  if (
    !UUID.test(capability.nonce ?? '') ||
    !UUID.test(capability.approval ?? '') ||
    !UUID.test(capability.authority ?? '') ||
    (capability.previous !== null && !UUID.test(capability.previous ?? ''))
  )
    throw new Error('Docker observer capability unavailable');
}

function requireCapabilityLocation(path, capability, generation) {
  if (
    (generation !== undefined && capability.nonce !== generation) ||
    typeof capability.directory !== 'string' ||
    !isAbsolute(capability.directory) ||
    path !==
      join(
        capability.directory,
        SUBMISSION_OBSERVERS,
        capability.authority,
        `${capability.nonce}.json`,
      )
  )
    throw new Error('Docker observer capability unavailable');
}

function requireCapabilityRecord(capability) {
  if (
    capability?.version !== 1 ||
    Object.keys(capability).sort().join(',') !==
      'approval,authority,authorityDigest,authorityIdentity,directory,imageId,moduleUrl,nonce,previous,reservation,socketPath,version'
  )
    throw new Error('Docker observer capability unavailable');
  requireCapabilityIdentifiers(capability);
  if (
    !UUID.test(capability.reservation?.id ?? '') ||
    Object.keys(capability.reservation).sort().join(',') !== 'captured,id,markerIdentity,markerText'
  )
    throw new Error('Docker observer capability unavailable');
}

function readObserverCapability(path, generation, expectedIdentity, expectedDigest) {
  const capabilityIdentity = pathIdentity(path);
  if (expectedIdentity !== undefined) sameIdentity(capabilityIdentity, expectedIdentity);
  const text = readPrivate(path, capabilityIdentity);
  const capabilityDigest = createHash('sha256').update(text).digest('hex');
  if (expectedDigest !== undefined && capabilityDigest !== expectedDigest)
    throw new Error('Docker observer capability changed');
  const capability = JSON.parse(text);
  requireCapabilityRecord(capability);
  requireCapabilityLocation(path, capability, generation);
  const authority = readObserverAuthority(
    dirname(path),
    capability.authorityIdentity,
    capability.authorityDigest,
  ).value;
  if (
    authority.nonce !== capability.authority ||
    authority.moduleUrl !== capability.moduleUrl ||
    authority.socketPath !== capability.socketPath ||
    authority.imageId !== capability.imageId
  )
    throw new Error('Docker observer capability belongs to another container');
  const captured = captureAuthority(capability.directory, capability.reservation.captured);
  if (JSON.stringify(captured) !== JSON.stringify(capability.reservation.captured))
    throw new Error('Docker observer capability authority changed');
  const markerText = `${JSON.stringify({
    version: 1,
    id: capability.reservation.id,
    invocation: captured.authority.invocation,
    observer: capability.nonce,
    binding: observerBindingDigest(capability),
  })}\n`;
  if (capability.reservation.markerText !== markerText)
    throw new Error('Docker observer capability binding changed');
  return { capability, capabilityIdentity, capabilityDigest };
}

function observerEvidence(capability, suffix) {
  return join(
    capability.directory,
    'submission-evidence',
    `observer-${capability.nonce}.${suffix}`,
  );
}

function observerBindingPath(capability) {
  return join(
    capability.directory,
    SUBMISSION_OBSERVERS,
    capability.authority,
    `${capability.nonce}.binding.json`,
  );
}

function pendingObserverFence(directory, id) {
  try {
    pathIdentity(join(directory, SUBMISSION_PENDING, id));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function publishObserverEvidence(capability, suffix, value) {
  const found = createPrivate(observerEvidence(capability, suffix), `${JSON.stringify(value)}\n`);
  syncDirectory(join(capability.directory, 'submission-evidence'));
  return found;
}

function publishObserverInitialization(capability, value, validateClaim) {
  const target = observerEvidence(capability, 'initialized');
  try {
    pathIdentity(target);
    throw new Error('Docker observer initialization already published');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const prepared = observerEvidence(capability, 'initialized-prepared');
  const preparedIdentity = createPrivate(
    prepared,
    (found) => `${JSON.stringify({ ...value, preparedIdentity: found })}\n`,
  );
  syncDirectory(join(capability.directory, 'submission-evidence'));
  validateClaim();
  // Exclusive atomic visibility is last. The prepared name remains required proof, not debris.
  linkSync(prepared, target);
  return preparedIdentity;
}

function requireObserverInitializationEvidence(capability, claim, expectedIdentity) {
  // Only this exact generation-bound pair may have two links; all other private files require one.
  const prepared = pathIdentity(observerEvidence(capability, 'initialized-prepared'), false, 2);
  if (prepared.mode !== 0o600) throw new Error('Docker observer initialization mode changed');
  if (expectedIdentity !== undefined) sameIdentity(prepared, expectedIdentity);
  const text = readPrivate(observerEvidence(capability, 'initialized'), prepared, 2);
  if (
    text !==
    `${JSON.stringify({ ...claim, factory: 'createDockerClient', preparedIdentity: prepared })}\n`
  )
    throw new Error('Docker observer factory initialization unconfirmed');
}

/**
 * Reserve and atomically publish before the original start operation; no bootstrap wait is added.
 * @param {DockerObserverAuthority} authority
 * @returns {Promise<DockerObserverReservation>}
 */
export async function reserveVerificationDockerObserver(authority) {
  const { value } = readObserverAuthority(
    authority.bootstrap,
    authority.authorityIdentity,
    authority.authorityDigest,
  );
  let previous = null;
  try {
    previous = readObserverManifest(authority.bootstrap, authority.authority).nonce;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (previous !== null) {
    requireObserverCompletion(join(authority.bootstrap, `${previous}.json`), undefined, previous);
  }
  const nonce = randomUUID();
  const core = {
    version: 1,
    nonce,
    authority: authority.authority,
    authorityIdentity: authority.authorityIdentity,
    authorityDigest: authority.authorityDigest,
    previous,
    directory: authority.directory,
    moduleUrl: value.moduleUrl,
    socketPath: value.socketPath,
    imageId: value.imageId,
  };
  const bindingApproval = reserveSubmission(authority.directory, {
    observer: nonce,
    binding: observerBindingDigest(core),
  });
  const scoped = { ...core, approval: bindingApproval.id };
  const reservation = reserveSubmission(authority.directory, {
    observer: nonce,
    binding: observerBindingDigest(scoped),
  });
  const capabilityPath = join(authority.bootstrap, `${nonce}.json`);
  const text = `${JSON.stringify({ ...scoped, reservation })}\n`;
  const capabilityIdentity = createPrivate(capabilityPath, text);
  const capabilityDigest = createHash('sha256').update(text).digest('hex');
  syncDirectory(authority.bootstrap);
  readObserverCapability(capabilityPath, nonce, capabilityIdentity, capabilityDigest);
  await writeReceipt(join(authority.bootstrap, 'current.json'), {
    version: 1,
    nonce,
    authority: authority.authority,
  });
  return {
    directory: authority.directory,
    authority: authority.authority,
    bootstrap: authority.bootstrap,
    generation: nonce,
    participant: reservation.id,
    capabilityPath,
    capabilityIdentity,
    capabilityDigest,
    bindingApproval,
  };
}

function requireObserverWitness(capability, witness) {
  if (capability.imageId === null) {
    if (witness.kind !== 'process') throw new Error('Docker observer process binding unavailable');
    processIdentity(witness);
  } else if (
    witness.kind !== 'container' ||
    !/^[a-f0-9]{64}$/.test(witness.id ?? '') ||
    witness.imageId !== capability.imageId ||
    witness.authority !== capability.authority ||
    typeof witness.startedAt !== 'string' ||
    !Number.isFinite(Date.parse(witness.startedAt)) ||
    Date.parse(witness.startedAt) <= 0
  )
    throw new Error('Docker observer container incarnation binding unavailable');
}

function requireObserverBinding(capability, capabilityIdentity, capabilityDigest, binding) {
  if (
    binding?.version !== 1 ||
    binding.nonce !== capability.nonce ||
    binding.approval !== capability.approval ||
    binding.capabilityDigest !== capabilityDigest ||
    JSON.stringify(binding.capabilityIdentity) !== JSON.stringify(capabilityIdentity) ||
    binding.witness?.generation !== capability.nonce
  )
    throw new Error('Docker observer parent binding unavailable');
  requireObserverWitness(capability, binding.witness);
}

/**
 * The parent calls this only after independent exact generation/process inspection.
 * @param {DockerObserverReservation} reserved
 * @param {DockerObserverWitness} witness
 * @returns {void}
 */
export function bindVerificationDockerObserver(reserved, witness) {
  const { capability, capabilityIdentity, capabilityDigest } = readObserverCapability(
    reserved.capabilityPath,
    reserved.generation,
    reserved.capabilityIdentity,
    reserved.capabilityDigest,
  );
  if (
    capability.reservation.id !== reserved.participant ||
    reserved.bindingApproval?.id !== capability.approval
  )
    throw new Error('Docker observer participant or approval binding changed');
  const binding = {
    version: 1,
    nonce: capability.nonce,
    capabilityIdentity,
    capabilityDigest,
    approval: capability.approval,
    witness,
  };
  requireObserverBinding(capability, capabilityIdentity, capabilityDigest, binding);
  if (capability.previous !== null) {
    const predecessor = readObserverCapability(
      join(dirname(reserved.capabilityPath), `${capability.previous}.json`),
      capability.previous,
    );
    const old = JSON.parse(readPrivate(observerBindingPath(predecessor.capability)));
    requireObserverBinding(
      predecessor.capability,
      predecessor.capabilityIdentity,
      predecessor.capabilityDigest,
      old,
    );
    requireObserverApproval(predecessor.capability, old);
    if (
      witness.kind !== old.witness.kind ||
      (witness.kind === 'container'
        ? witness.id !== old.witness.id || witness.startedAt === old.witness.startedAt
        : witness.birth === old.witness.birth)
    )
      throw new Error('Docker observer did not capture a fresh process incarnation');
  }
  const bindingText = `${JSON.stringify(binding)}\n`;
  const bindingIdentity = createPrivate(observerBindingPath(capability), bindingText);
  createPrivate(
    join(dirname(reserved.capabilityPath), `${capability.nonce}.approval.json`),
    `${JSON.stringify({
      version: 1,
      nonce: capability.nonce,
      approval: capability.approval,
      bindingIdentity,
      bindingDigest: createHash('sha256').update(bindingText).digest('hex'),
    })}\n`,
  );
  syncDirectory(dirname(reserved.capabilityPath));
  submissionCompletion(capability.directory, reserved.bindingApproval)();
}

function requireObserverApproval(capability, binding, states) {
  const proof = JSON.parse(
    readPrivate(
      join(
        capability.directory,
        SUBMISSION_OBSERVERS,
        capability.authority,
        `${capability.nonce}.approval.json`,
      ),
    ),
  );
  if (
    proof?.version !== 1 ||
    proof.nonce !== capability.nonce ||
    proof.approval !== capability.approval
  )
    throw new Error('Docker observer binding approval scope changed');
  const text = readPrivate(observerBindingPath(capability), proof.bindingIdentity);
  if (
    createHash('sha256').update(text).digest('hex') !== proof.bindingDigest ||
    text !== `${JSON.stringify(binding)}\n`
  )
    throw new Error('Docker observer approved binding changed');
  if (
    (states !== undefined && states.get(binding.approval) !== 'settled') ||
    pendingObserverFence(capability.directory, binding.approval)
  )
    throw new Error('Docker observer parent binding publication unconfirmed');
}

/** Capture the current generation once; the running process never reads a successor manifest. */
export function claimVerificationDockerObserver(bootstrap, authorityId) {
  const authority = readObserverAuthority(bootstrap).value;
  if (authority.nonce !== authorityId)
    throw new Error('Docker observer bootstrap authority changed');
  const generation = readObserverManifest(bootstrap, authorityId).nonce;
  const path = join(bootstrap, `${generation}.json`);
  const { capability, capabilityIdentity, capabilityDigest } = readObserverCapability(
    path,
    generation,
  );
  const marker = join(capability.directory, SUBMISSION_PENDING, capability.reservation.id);
  if (
    readPrivate(marker, capability.reservation.markerIdentity) !== capability.reservation.markerText
  )
    throw new Error('Docker observer reservation unavailable');
  const claim = {
    version: 1,
    nonce: capability.nonce,
    participant: capability.reservation.id,
    capabilityIdentity,
    capabilityDigest,
    pid: process.pid,
  };
  const claimIdentity = publishObserverEvidence(capability, 'claim', claim);
  const complete = submissionCompletion(capability.directory, capability.reservation);
  let initialized = false;
  let initializedIdentity;
  let initializationAttempted = false;
  let finished = false;
  const requireClaim = () => {
    readObserverCapability(path, generation, capabilityIdentity, capabilityDigest);
    if (
      readPrivate(observerEvidence(capability, 'claim'), claimIdentity) !==
      `${JSON.stringify(claim)}\n`
    )
      throw new Error('Docker observer claim changed');
    if (initialized) requireObserverInitializationEvidence(capability, claim, initializedIdentity);
  };
  return {
    generation,
    moduleUrl: capability.moduleUrl,
    socketPath: capability.socketPath,
    initialize() {
      requireClaim();
      if (initialized) return;
      if (initializationAttempted)
        throw new Error('Docker observer initialization already attempted');
      initializationAttempted = true;
      initializedIdentity = publishObserverInitialization(
        capability,
        { ...claim, factory: 'createDockerClient' },
        requireClaim,
      );
      initialized = true;
    },
    submit() {
      requireClaim();
      if (!initialized || finished) throw new Error('Docker observer factory is not active');
      return submissionCompletion(
        capability.directory,
        reserveSubmission(
          capability.directory,
          {
            observer: generation,
            binding: observerBindingDigest(capability),
          },
          generation,
        ),
        generation,
      );
    },
    finish() {
      if (!initialized || finished) throw new Error('Docker observer generation cannot complete');
      finished = true;
      requireClaim();
      const binding = JSON.parse(readPrivate(observerBindingPath(capability)));
      requireObserverBinding(capability, capabilityIdentity, capabilityDigest, binding);
      requireObserverApproval(capability, binding);
      if (binding.witness.kind === 'process' && binding.witness.pid !== process.pid)
        throw new Error('Docker observer process binding changed');
      publishObserverEvidence(capability, 'completed', { ...claim, exitCode: 0 });
      complete();
    },
  };
}

function requireObserverInitialization(
  path,
  expectedGeneration,
  expectedIdentity,
  expectedDigest,
  states,
) {
  const { capability, capabilityIdentity, capabilityDigest } = readObserverCapability(
    path,
    expectedGeneration,
    expectedIdentity,
    expectedDigest,
  );
  const binding = JSON.parse(readPrivate(observerBindingPath(capability)));
  requireObserverBinding(capability, capabilityIdentity, capabilityDigest, binding);
  requireObserverApproval(capability, binding, states);
  const claim = JSON.parse(readPrivate(observerEvidence(capability, 'claim')));
  if (
    claim?.version !== 1 ||
    claim.nonce !== capability.nonce ||
    claim.participant !== capability.reservation.id ||
    claim.capabilityDigest !== capabilityDigest ||
    JSON.stringify(claim.capabilityIdentity) !== JSON.stringify(capabilityIdentity) ||
    !Number.isSafeInteger(claim.pid) ||
    claim.pid <= 0 ||
    (binding.witness.kind === 'process' && binding.witness.pid !== claim.pid)
  )
    throw new Error('Docker observer claim unavailable');
  requireObserverInitializationEvidence(capability, claim);
  return { capability, claim, binding };
}

/** @returns {DockerObserverWitness} */
function requireObserverCompletion(
  path,
  states,
  expectedGeneration,
  expectedIdentity,
  expectedDigest,
) {
  const { capability, claim, binding } = requireObserverInitialization(
    path,
    expectedGeneration,
    expectedIdentity,
    expectedDigest,
    states,
  );
  if (
    readPrivate(observerEvidence(capability, 'completed')) !==
      `${JSON.stringify({ ...claim, exitCode: 0 })}\n` ||
    (states !== undefined && states.get(capability.reservation.id) !== 'settled') ||
    pendingObserverFence(capability.directory, capability.reservation.id)
  )
    throw new Error('Docker observer generation settlement unconfirmed');
  return binding.witness;
}

/**
 * Initialization is required in addition to readiness.
 * @param {DockerObserverReservation} reserved
 * @returns {void}
 */
export function requireVerificationDockerObserverInitialized(reserved) {
  requireObserverInitialization(
    reserved.capabilityPath,
    reserved.generation,
    reserved.capabilityIdentity,
    reserved.capabilityDigest,
  );
}

/**
 * Call after observing this exact writer retire.
 * @param {DockerObserverReservation} reserved
 * @returns {void}
 */
export function requireVerificationDockerObserverSettled(reserved) {
  requireObserverCompletion(
    reserved.capabilityPath,
    undefined,
    reserved.generation,
    reserved.capabilityIdentity,
    reserved.capabilityDigest,
  );
}

/**
 * Uncertainty remains scoped to its generation.
 * @param {DockerObserverReservation} reserved
 * @returns {void}
 */
export function requireVerificationDockerObserverRequestsSettled(reserved) {
  const { capability } = readObserverCapability(
    reserved.capabilityPath,
    reserved.generation,
    reserved.capabilityIdentity,
    reserved.capabilityDigest,
  );
  const captured = capability.reservation.captured;
  for (const name of readdirSync(join(reserved.directory, SUBMISSION_PENDING))) {
    if (UUID.test(name)) {
      if (name === reserved.participant || name === reserved.bindingApproval.id)
        throw new Error('Docker observer participant or binding settlement unconfirmed');
      continue;
    }
    const parts = name.split('.');
    if (parts.length !== 2 || !UUID.test(parts[0]) || !UUID.test(parts[1]))
      throw new Error('Verification submission pending authority malformed');
    // Scope is established by the canonical pathname before touching concurrently published bytes.
    // Once enumerated, an own-generation marker remains uncertainty even if it then disappears.
    if (parts[0] === reserved.generation)
      throw new Error('Docker observer request settlement unconfirmed');
  }
  captureAuthority(reserved.directory, captured);
}

function observerGenerationName(name, names) {
  if (name === 'authority.json' || name === 'current.json') return null;
  if (name.endsWith('.binding.json') || name.endsWith('.approval.json')) {
    const suffix = name.endsWith('.binding.json') ? '.binding.json' : '.approval.json';
    const generation = name.slice(0, -suffix.length);
    if (!UUID.test(generation) || !names.has(`${generation}.json`))
      throw new Error('Docker observer orphaned binding');
    return null;
  }
  const generation = name.endsWith('.json') ? name.slice(0, -5) : '';
  if (!UUID.test(generation)) throw new Error('Docker observer generation authority malformed');
  return generation;
}

/**
 * Only a current, bound and initialized generation of an exempt container may still be live;
 * any other uncompleted generation, process or unbound reservation remains an unsettled writer.
 * @param {ReadonlySet<string>} exempt
 * @returns {DockerObserverWitness}
 */
function requireCurrentObserverWriter(path, states, generation, exempt) {
  try {
    return requireObserverCompletion(path, states, generation);
  } catch {
    const { binding } = requireObserverInitialization(
      path,
      generation,
      undefined,
      undefined,
      states,
    );
    if (binding.witness.kind !== 'container' || !exempt.has(binding.witness.id))
      throw new Error('Docker observer writer settlement unconfirmed');
    return binding.witness;
  }
}

/**
 * @param {ReadonlySet<string> | undefined} exempt
 * @returns {DockerObserverWitness[]}
 */
function readContainerWriters(directory, authority, states, exempt) {
  if (!UUID.test(authority)) throw new Error('Docker observer container authority malformed');
  const bootstrap = join(directory, SUBMISSION_OBSERVERS, authority);
  const descriptor = readObserverAuthority(bootstrap).value;
  if (descriptor.nonce !== authority)
    throw new Error('Docker observer container authority changed');
  const current = readObserverManifest(bootstrap, authority);
  const files = readdirSync(bootstrap);
  const names = new Set(files);
  let currentFound = false;
  /** @type {DockerObserverWitness[]} */
  const writers = [];
  for (const name of files) {
    const generation = observerGenerationName(name, names);
    if (generation === null) continue;
    if (generation === current.nonce) currentFound = true;
    writers.push(
      exempt !== undefined && generation === current.nonce
        ? requireCurrentObserverWriter(join(bootstrap, name), states, generation, exempt)
        : requireObserverCompletion(join(bootstrap, name), states, generation),
    );
  }
  if (!currentFound) throw new Error('Docker observer current generation unavailable');
  return writers;
}

/**
 * Host-only final enumeration after all writers retire; no live append-active journal scan.
 * `exempt` admits each authority's current initialized generation bound to one of those exact
 * container IDs before its drain; without it every generation must be complete.
 * @param {string} directory
 * @param {Map<string, import('./verification-submission-storage.mjs').SubmissionState>} states
 * @param {import('./verification-submission-storage.mjs').CapturedAuthority} captured
 * @param {ReadonlySet<string>} [exempt]
 * @returns {DockerObserverWitness[]}
 */
export function readVerificationDockerObserverWriters(directory, states, captured, exempt) {
  sameIdentity(
    pathIdentity(join(directory, SUBMISSION_OBSERVERS), true),
    captured.authority.observers,
  );
  /** @type {DockerObserverWitness[]} */
  const writers = [];
  for (const authority of readdirSync(join(directory, SUBMISSION_OBSERVERS)))
    writers.push(...readContainerWriters(directory, authority, states, exempt));
  return writers;
}
