import { once } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import { readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect } from 'vitest';
import {
  createVerificationDockerObserverAuthority,
  reserveVerificationDockerObserver,
} from '../../scripts/verification-docker-generations.mjs';
import type { DockerObserverReservation } from '../../scripts/verification-docker-generations.mjs';
import {
  initializeVerificationSubmissions,
  SUBMISSION_PENDING,
} from '../../scripts/verification-submission-storage.mjs';
import { writeCompiledClient } from './deployed-docker-observer-fixture.ts';
import type {
  CompiledDockerClient,
  ObserverChildOutput,
} from './deployed-docker-observer-fixture.ts';

interface PendingMarker {
  id: string;
  observer: string;
}
const CREATE_REQUEST = 'POST /networks/create';
const DELETE_REQUEST = 'DELETE /networks/owned-effect';

/**
 * Same-authority generation engine: each request records the pending markers first seen at its
 * arrival. With `stalls` the first create gets a partial body that never finishes; a GET waits for
 * `openGate(exited)`; every other request waits for the current generation's `bound`.
 */
export function generationEngineStub(directory: string, stalls: boolean) {
  const socket = join(directory, 'e.sock');
  const requests: string[] = [];
  const requestMarkers: PendingMarker[][] = [];
  const requestGenerations: string[][] = [];
  const seenMarkers = new Set<string>();
  const phase = {
    dispatched: Promise.withResolvers<undefined>(),
    bound: Promise.withResolvers<undefined>(),
  };
  const gate = Promise.withResolvers<undefined>();
  const created = Promise.withResolvers<undefined>();
  const deleted = Promise.withResolvers<undefined>();
  let stalled = false;
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const line = `${request.method ?? ''} ${request.url ?? ''}`;
      requests.push(line);
      const fresh = readdirSync(join(directory, SUBMISSION_PENDING))
        .map(
          // The same reserveSubmission-written marker shape samplePending reads.
          (name) =>
            JSON.parse(
              readFileSync(join(directory, SUBMISSION_PENDING, name), 'utf8'),
            ) as PendingMarker,
        )
        .filter((marker) => !seenMarkers.has(marker.id));
      requestMarkers.push(fresh);
      requestGenerations.push(fresh.map((marker) => marker.observer));
      for (const marker of fresh) seenMarkers.add(marker.id);
      phase.dispatched.resolve(undefined);
      if (line === CREATE_REQUEST) created.resolve(undefined);
      if (line === DELETE_REQUEST) deleted.resolve(undefined);
      const answer = (status: number) => () => {
        if (!response.destroyed) response.writeHead(status).end('{}');
      };
      if (stalls && !stalled && line === CREATE_REQUEST) {
        stalled = true;
        response.writeHead(201).write('{');
      } else if (request.method === 'GET') void gate.promise.then(answer(200));
      else void phase.bound.promise.then(answer(201));
    });
  });
  return {
    socket,
    requests,
    requestMarkers,
    requestGenerations,
    seenMarkers,
    async start(emitted: CompiledDockerClient) {
      initializeVerificationSubmissions(directory);
      const moduleUrl = pathToFileURL(await writeCompiledClient(directory, emitted)).href;
      const authority = createVerificationDockerObserverAuthority(directory, {
        moduleUrl,
        socketPath: socket,
      });
      const first = await reserveVerificationDockerObserver(authority);
      seenMarkers.add(first.participant);
      seenMarkers.add(first.bindingApproval.id);
      server.listen(socket);
      await once(server, 'listening');
      const source = (abort: boolean, probe = false) => `import assert from 'node:assert/strict';
import {createDockerClient,DockerHttpError} from ${JSON.stringify(moduleUrl)};
const client=createDockerClient(${JSON.stringify(socket)});
${probe ? "await client.json('GET','/networks/owned-effect');\n" : ''}const create=client.json('POST','/networks/create',{},AbortSignal.timeout(${String(abort ? 200 : 2000)}));
${abort ? 'await assert.rejects(create,error=>error instanceof Error&&!(error instanceof DockerHttpError));' : 'assert.deepEqual(await create,{});'}
await client.json('DELETE','/networks/owned-effect',undefined,AbortSignal.timeout(2000));`;
      return { authority, first, source };
    },
    childGates() {
      const { dispatched, bound } = phase;
      return {
        bindingGate: dispatched.promise,
        releaseResponse: () => {
          bound.resolve(undefined);
        },
      };
    },
    nextGeneration() {
      phase.dispatched = Promise.withResolvers<undefined>();
      phase.bound = Promise.withResolvers<undefined>();
    },
    /** Releases a held GET; resolves once the child's following create has arrived. */
    async openGate(exited: Promise<ObserverChildOutput>) {
      gate.resolve(undefined);
      await arrivalOrExit(created.promise, exited, requests);
    },
    /** The DELETE has arrived, so its marker exists. */
    async quiescent(exited: Promise<ObserverChildOutput>) {
      await arrivalOrExit(deleted.promise, exited, requests);
    },
    async close() {
      server.closeAllConnections();
      phase.bound.resolve(undefined);
      try {
        if (server.listening) {
          const stopped = Promise.withResolvers<undefined>();
          server.close((error) => {
            if (error) stopped.reject(error);
            else stopped.resolve(undefined);
          });
          await stopped.promise;
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
type GenerationEngineStub = ReturnType<typeof generationEngineStub>;

/** Fails at once with the child's own output if it exits before the request arrives; no deadline. */
async function arrivalOrExit(
  arrival: Promise<undefined>,
  exited: Promise<ObserverChildOutput>,
  requests: readonly string[],
): Promise<void> {
  const outcome = await Promise.race([arrival, exited]);
  if (outcome !== undefined)
    throw new Error(
      `Observer child exited ${JSON.stringify({ code: outcome.code, signal: outcome.signal, requests })} before the awaited request\n${outcome.stderr}`,
    );
}

export async function samplePending(directory: string): Promise<Map<string, PendingMarker>> {
  const pending = join(directory, SUBMISSION_PENDING);
  const entries = await Promise.all(
    (await readdir(pending)).map(
      // Every pending marker is a submission reservation; its id and observer fields are written
      // by reserveSubmission, which the compiler cannot see through JSON.
      async (name) =>
        [name, JSON.parse(await readFile(join(pending, name), 'utf8')) as PendingMarker] as const,
    ),
  );
  return new Map(entries);
}

function pendingChange(before: Map<string, PendingMarker>, after: Map<string, PendingMarker>) {
  const only = (side: Map<string, PendingMarker>, other: Map<string, PendingMarker>) =>
    [...side]
      .filter(([name]) => !other.has(name))
      .map(([name, marker]) => `${marker.id} (observer ${marker.observer}, file ${name})`)
      .join(', ') || 'none';
  return `rejected reserve changed pending markers; added: ${only(after, before)}; missing: ${only(before, after)}`;
}

interface RejectedReserveOracle {
  quiescent: () => Promise<void>;
  sample: () => Promise<Map<string, PendingMarker>>;
  reserve: () => Promise<unknown>;
  requests: readonly string[];
}

/**
 * A rejected reserve leaves the pending markers unchanged. Both samples follow `quiescent()`, so the
 * predecessor child cannot add a marker between them. The first sample must then be exactly the
 * predecessor participant plus the marker of every request received so far.
 */
export async function expectRejectedReserveUnchanged(
  oracle: RejectedReserveOracle,
  stub: GenerationEngineStub,
  predecessor: DockerObserverReservation,
): Promise<void> {
  await oracle.quiescent();
  const before = await oracle.sample();
  await expect(oracle.reserve()).rejects.toThrow();
  const after = await oracle.sample();
  const names = (sample: Map<string, PendingMarker>) => [...sample.keys()].sort();
  expect(names(after), pendingChange(before, after)).toEqual(names(before));
  expect(stub.requests).toEqual(oracle.requests);
  expect(names(before)).toEqual(
    [
      predecessor.participant,
      ...stub.requestMarkers.flat().map((marker) => `${predecessor.generation}.${marker.id}`),
    ].sort(),
  );
  expect(new Set([...before.values()].map((marker) => marker.observer))).toEqual(
    new Set([predecessor.generation]),
  );
}
