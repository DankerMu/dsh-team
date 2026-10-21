import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { access, mkdir } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveProcessBirth, processBirth, processIdentity } from './probe-browser-native.mjs';
import { writeReceipt } from './probe-browser-receipt.mjs';
import { INVOCATION_PATTERN } from './trusted-docker-record.mjs';

function observeProducerExit(identity, invalidate) {
  const ready = Promise.withResolvers();
  const finished = Promise.withResolvers();
  let child;
  let acquired = false;
  let observed = false;
  let invalid = false;
  let cancelled = false;
  let pending = '';
  let observerStopIssued = false;
  const terminateObserver = () => {
    if (!child || observerStopIssued) return;
    observerStopIssued = true;
    child.kill('SIGTERM');
  };
  const fail = () => {
    if (!invalid) {
      invalid = true;
      invalidate();
    }
    ready.reject(new Error('Producer exit observation unavailable'));
  };
  const cancelAcquisition = () => {
    if (acquired || cancelled) return;
    cancelled = true;
    ready.reject(new Error('Producer exit acquisition cancelled'));
    if (child) terminateObserver();
    else finished.resolve(false);
  };
  void (async () => {
    try {
      if (process.platform !== 'linux') throw new Error('Producer exit observation requires Linux');
      await access('/usr/bin/python3', constants.X_OK);
      if (cancelled) return;
      child = spawn(
        '/usr/bin/python3',
        [
          fileURLToPath(new URL('./verification-producer-exit.py', import.meta.url)),
          String(identity.pid),
        ],
        { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      child.once('error', fail);
      child.once('close', (code) => {
        const confirmed =
          code === 0 && observed && acquired && !invalid && !cancelled && pending === '';
        if (!confirmed) fail();
        finished.resolve(confirmed);
      });
      child.stdout.on('data', (chunk) => {
        pending += chunk.toString('utf8');
        if (pending.length > 128) {
          fail();
          terminateObserver();
          return;
        }
        for (;;) {
          const end = pending.indexOf('\n');
          if (end < 0) break;
          const row = pending.slice(0, end);
          pending = pending.slice(end + 1);
          if (row === 'ready' && !acquired && !observed && !cancelled) {
            acquired = true;
            ready.resolve();
          } else if (row === 'producer-exit-observed' && acquired && !observed) observed = true;
          else {
            fail();
            terminateObserver();
          }
        }
      });
    } catch {
      fail();
      if (child) terminateObserver();
      else finished.resolve(false);
    }
  })();
  return { ready: ready.promise, closed: finished.promise, cancelAcquisition };
}

function messages(socket, receive, reject) {
  let pending = '';
  socket.on('data', (chunk) => {
    pending += chunk.toString('utf8');
    if (Buffer.byteLength(pending) > 4096) return reject();
    for (;;) {
      const end = pending.indexOf('\n');
      if (end < 0) break;
      const row = pending.slice(0, end);
      pending = pending.slice(end + 1);
      try {
        receive(JSON.parse(row));
      } catch {
        reject();
        return;
      }
    }
  });
}

function send(socket, value) {
  socket.write(`${JSON.stringify(value)}\n`);
}

function publishProducer(owner, entry, state, extra = {}) {
  return writeReceipt(join(owner.directory, `${entry.nonce}.json`), {
    version: 1,
    invocation: owner.invocation,
    nonce: entry.nonce,
    worker: entry.worker,
    root: entry.root?.identity ?? null,
    producer: entry.producer?.identity ?? null,
    state,
    ...extra,
  });
}

function cancelProducerEntry(entry) {
  entry.cancelled = true;
  entry.rootReady.resolve(false);
  entry.root?.observer?.cancelAcquisition();
  entry.producer?.observer?.cancelAcquisition();
  if (entry.workClosed !== null) return;
  for (const control of entry.controls) {
    if (!control.socket.destroyed && !control.socket.writableEnded)
      send(control.socket, { state: 'cancel' });
  }
}

function requireProducerAdmission(owner, entry, socket) {
  if (!owner.admitting || entry.cancelled || socket.destroyed)
    throw new Error('Producer admission closed');
}

async function reserveOwnedProducer(owner, control, value) {
  if (!owner.admitting || owner.reservations.has(value.nonce))
    throw new Error('Producer reservation unavailable');
  const entry = {
    nonce: value.nonce,
    worker: processIdentity(value.worker),
    root: null,
    producer: null,
    rootReady: Promise.withResolvers(),
    controls: new Set([control]),
    cancelled: false,
    released: false,
    admitted: false,
    workClosed: null,
  };
  // Retain the reservation even if the worker dies before spawn or root binding.
  owner.reservations.set(value.nonce, entry);
  control.entry = entry;
  control.kind = 'worker';
  if ((await liveProcessBirth(entry.worker.pid)) !== entry.worker.birth)
    throw new Error('Invoking worker generation unavailable');
  await publishProducer(owner, entry, 'reserved');
  requireProducerAdmission(owner, entry, control.socket);
  send(control.socket, { state: 'reserved', nonce: entry.nonce });
}

async function registerOwnedProducer(owner, control, value, reject) {
  const entry = owner.reservations.get(value.nonce);
  if (!entry || entry.producer !== null)
    throw new Error('Producer reservation missing or already bound');
  requireProducerAdmission(owner, entry, control.socket);
  control.entry = entry;
  control.kind = 'producer';
  entry.controls.add(control);
  const identity = processIdentity(value.producer);
  entry.producer = { identity, observer: null };
  if ((await liveProcessBirth(identity.pid)) !== identity.birth)
    throw new Error('Producer generation unavailable');
  await publishProducer(owner, entry, 'producer-binding');
  if (!(await entry.rootReady.promise)) throw new Error('Detached root not bound');
  requireProducerAdmission(owner, entry, control.socket);
  entry.producer.observer = observeProducerExit(identity, reject);
  await entry.producer.observer.ready;
  if ((await liveProcessBirth(identity.pid)) !== identity.birth)
    throw new Error('Producer generation changed before admission');
  requireProducerAdmission(owner, entry, control.socket);
  await publishProducer(owner, entry, 'admitted');
  requireProducerAdmission(owner, entry, control.socket);
  entry.admitted = true;
  send(control.socket, { state: 'admitted', nonce: entry.nonce });
}

async function bindProducerRoot(owner, control, value, reject) {
  const entry = control.entry;
  requireProducerAdmission(owner, entry, control.socket);
  const identity = processIdentity(value.root);
  entry.root = { identity, observer: null };
  if ((await liveProcessBirth(identity.pid)) !== identity.birth)
    throw new Error('Detached root generation unavailable');
  await publishProducer(owner, entry, 'root-binding');
  requireProducerAdmission(owner, entry, control.socket);
  entry.root.observer = observeProducerExit(identity, reject);
  await entry.root.observer.ready;
  if ((await liveProcessBirth(identity.pid)) !== identity.birth)
    throw new Error('Detached root generation changed before admission');
  requireProducerAdmission(owner, entry, control.socket);
  await publishProducer(owner, entry, 'root-bound');
  requireProducerAdmission(owner, entry, control.socket);
  entry.rootReady.resolve(true);
  send(control.socket, { state: 'root-bound', nonce: entry.nonce });
}

async function receiveBoundProducerEvidence(owner, control, value, reject) {
  const entry = control.entry;
  if (value.nonce !== entry.nonce) throw new Error('Producer binding changed');
  if (control.kind === 'worker' && value.state === 'bind-root' && entry.root === null) {
    await bindProducerRoot(owner, control, value, reject);
  } else if (control.kind === 'worker' && value.state === 'release' && !entry.released) {
    entry.released = true;
  } else if (
    control.kind === 'producer' &&
    value.state === 'work-closed' &&
    entry.admitted &&
    entry.workClosed === null &&
    typeof value.cleanupConfirmed === 'boolean'
  ) {
    entry.workClosed = { cleanupConfirmed: value.cleanupConfirmed };
    await publishProducer(owner, entry, 'work-closed', entry.workClosed);
  } else throw new Error('Producer lifecycle evidence changed');
}

async function receiveProducerMessage(owner, control, value, reject) {
  if (
    !value ||
    value.version !== 1 ||
    value.invocation !== owner.invocation ||
    !INVOCATION_PATTERN.test(value.nonce ?? '')
  )
    throw new Error('Producer invocation changed');
  if (control.kind !== null) {
    await receiveBoundProducerEvidence(owner, control, value, reject);
  } else if (value.state === 'reserve') {
    await reserveOwnedProducer(owner, control, value);
  } else if (value.state === 'register') {
    await registerOwnedProducer(owner, control, value, reject);
  } else throw new Error('Producer reservation required');
}

function acceptProducerControl(owner, socket) {
  if (!owner.admitting) {
    owner.uncertain = true;
    socket.destroy();
    return;
  }
  const closed = Promise.withResolvers();
  const control = {
    socket,
    closed: closed.promise,
    kind: null,
    entry: null,
    work: Promise.resolve(),
  };
  owner.controls.add(control);
  const reject = () => {
    owner.uncertain = true;
    if (control.entry) cancelProducerEntry(control.entry);
    socket.destroy();
  };
  socket.on('error', reject);
  socket.once('close', () => {
    closed.resolve();
    // Drain already-received release before distinguishing normal return from worker loss.
    void control.work.then(() => {
      if (control.kind === 'worker' && !control.entry.released) cancelProducerEntry(control.entry);
    });
  });
  messages(
    socket,
    (value) => {
      control.work = control.work
        .then(() => receiveProducerMessage(owner, control, value, reject))
        .catch(reject);
    },
    reject,
  );
}

async function stopProducerAdmission(owner, server) {
  owner.admitting = false;
  const stopped = new Promise((resolve) => server.close(resolve));
  for (const entry of owner.reservations.values()) cancelProducerEntry(entry);
  for (const control of owner.controls) {
    if (control.kind === 'worker' && !control.socket.destroyed && !control.socket.writableEnded)
      control.socket.end();
    else if (control.kind === null) {
      owner.uncertain = true;
      control.socket.destroy();
    }
  }
  await stopped;
  for (const control of owner.controls) {
    await control.closed;
    await control.work;
  }
}

async function observeProducerRetirement(owner, entry) {
  // EOF is cancellation only. Both kernel subscriptions and direct observer closes
  // are required, independently of the supervisor's canonical cleanup marker.
  const rootExited = entry.root?.observer && (await entry.root.observer.closed);
  const producerExited = entry.producer?.observer && (await entry.producer.observer.closed);
  const joined = rootExited && producerExited && entry.admitted && entry.workClosed !== null;
  let settled = Boolean(joined);
  if (joined) {
    try {
      await publishProducer(owner, entry, 'retired', {
        ...entry.workClosed,
        exitObservations: { root: 'producer-exit-observed', producer: 'producer-exit-observed' },
        observerExitCode: 0,
      });
    } catch {
      settled = false;
    }
  }
  return { settled, cleanupConfirmed: Boolean(joined && entry.workClosed?.cleanupConfirmed) };
}

async function finishOwnedProducers(owner, server) {
  await stopProducerAdmission(owner, server);
  let settled = !owner.uncertain;
  let cleanupConfirmed = !owner.uncertain;
  for (const entry of owner.reservations.values()) {
    const result = await observeProducerRetirement(owner, entry);
    if (!result.settled) settled = false;
    if (!result.cleanupConfirmed) cleanupConfirmed = false;
  }
  return {
    settled: settled && !owner.uncertain,
    cleanupConfirmed: cleanupConfirmed && !owner.uncertain,
  };
}

/** A private admission/lifetime channel, not a process-discovery or cleanup owner. */
export async function ownVerificationProducers(temporary, invocation) {
  const directory = join(temporary, 'producers');
  await mkdir(directory, { mode: 0o700 });
  const path = join(temporary, 'producer.sock');
  const owner = {
    directory,
    invocation,
    admitting: true,
    uncertain: false,
    reservations: new Map(),
    controls: new Set(),
  };
  let finishing;
  const server = createServer((socket) => acceptProducerControl(owner, socket));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  return {
    environment: {
      DSH_TEAM_VERIFICATION_PRODUCERS: path,
      DSH_TEAM_VERIFICATION_INVOCATION: invocation,
    },
    finish() {
      finishing ??= finishOwnedProducers(owner, server);
      return finishing;
    },
  };
}

function producerContext() {
  const path = process.env.DSH_TEAM_VERIFICATION_PRODUCERS;
  if (!path) return undefined;
  const invocation = process.env.DSH_TEAM_VERIFICATION_INVOCATION;
  if (!INVOCATION_PATTERN.test(invocation ?? ''))
    throw new Error('Producer invocation unavailable');
  return { path, invocation };
}

async function producerCapability(context, nonce, cancel) {
  const socket = createConnection(context.path);
  const connected = Promise.withResolvers();
  const waiting = new Map();
  let cancelled = false;
  let completed = false;
  const lose = () => {
    cancelled = true;
    cancel();
    connected.reject(new Error('Producer lifetime unavailable'));
    for (const ready of waiting.values()) ready.reject(new Error('Producer admission unavailable'));
    waiting.clear();
  };
  socket.once('connect', connected.resolve);
  socket.on('error', lose);
  socket.once('end', () => {
    if (!completed) lose();
    socket.end();
  });
  socket.once('close', () => {
    if (!completed) lose();
  });
  messages(
    socket,
    (value) => {
      if (value?.state === 'cancel') {
        lose();
        return;
      }
      const ready = waiting.get(value?.state);
      if (!ready || value.nonce !== nonce) throw new Error('Producer admission changed');
      waiting.delete(value.state);
      ready.resolve();
    },
    () => {
      lose();
      socket.destroy();
    },
  );
  await connected.promise;
  const envelope = (value) => ({ version: 1, invocation: context.invocation, nonce, ...value });
  return {
    get cancelled() {
      return cancelled;
    },
    abort: () => socket.destroy(),
    async request(value, state) {
      if (cancelled) throw new Error('Producer admission closed');
      const ready = Promise.withResolvers();
      waiting.set(state, ready);
      send(socket, envelope(value));
      await ready.promise;
    },
    release() {
      completed = true;
      socket.end(`${JSON.stringify(envelope({ state: 'release' }))}\n`);
    },
    complete(cleanupConfirmed) {
      completed = true;
      socket.write(
        `${JSON.stringify(envelope({ state: 'work-closed', cleanupConfirmed }))}\n`,
        () => socket.unref(),
      );
      // Do not end the producer channel: process exit supplies EOF, not this message.
    },
  };
}

/** Durable reservation precedes detached spawn; the caller binds its actual ChildProcess birth. */
export async function reserveVerificationProducer(cancel) {
  const context = producerContext();
  if (!context) return undefined;
  const nonce = randomUUID();
  const capability = await producerCapability(context, nonce, cancel);
  try {
    await capability.request(
      {
        state: 'reserve',
        worker: { pid: process.pid, birth: await processBirth(process.pid) },
      },
      'reserved',
    );
  } catch (error) {
    capability.abort();
    throw error;
  }
  return {
    environment: { DSH_TEAM_VERIFICATION_PRODUCER_NONCE: nonce },
    get cancelled() {
      return capability.cancelled;
    },
    bind: (root) => capability.request({ state: 'bind-root', root }, 'root-bound'),
    release: capability.release,
  };
}

/** Bind to the pre-spawn reservation before privileged work; stay open until actual process exit. */
export async function joinVerificationProducer(cancel) {
  const context = producerContext();
  if (!context) return undefined;
  const nonce = process.env.DSH_TEAM_VERIFICATION_PRODUCER_NONCE;
  if (!INVOCATION_PATTERN.test(nonce ?? '')) throw new Error('Producer reservation unavailable');
  const capability = await producerCapability(context, nonce, cancel);
  try {
    await capability.request(
      {
        state: 'register',
        producer: { pid: process.pid, birth: await processBirth(process.pid) },
      },
      'admitted',
    );
  } catch (error) {
    capability.abort();
    throw error;
  }
  return { nonce, complete: capability.complete };
}
