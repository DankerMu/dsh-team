import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, expect, it } from 'vitest';
import {
  bindVerificationDockerObserver,
  createVerificationDockerObserverAuthority,
  requireVerificationDockerObserverSettled,
  requireVerificationDockerObserverInitialized,
  requireVerificationDockerObserverRequestsSettled,
  reserveVerificationDockerObserver,
} from '../../scripts/verification-docker-generations.mjs';
import type {
  DockerObserverReservation,
  DockerProcessWitness,
} from '../../scripts/verification-docker-generations.mjs';
import {
  initializeVerificationSubmissions,
  SUBMISSION_JOURNAL,
  SUBMISSION_PENDING,
} from '../../scripts/verification-submission-storage.mjs';
import { requireVerificationSubmissionsSettled } from '../../scripts/verification-submission-assessment.mjs';
import {
  compileDockerClient,
  writeCompiledClient,
  runObserverChild,
  freshObserverAssessment,
  observerFaultBehavior,
  prepareObserverFault,
  observerFaultOptions,
  observerFaultSource,
  observerScenarioSource,
} from './deployed-docker-observer-fixture.ts';
import type { ObserverFaultBehavior } from './deployed-docker-observer-fixture.ts';
import { assessTrustedDockerCleanup } from '../../scripts/trusted-docker-audit.mjs';
import type { CleanupAssessmentRequest } from '../../scripts/trusted-docker-audit.mjs';
import { createDockerClient as createFixtureDockerClient } from '../src/orchestrator/index.ts';
import { createObserverEngineFixture } from './deployed-docker-engine-fixture.ts';
import type { FixturePlatform } from './deployed-docker-engine-fixture.ts';

let emittedClient: Readonly<{ javascript: string; sourceMap: string }>;
beforeAll(() => {
  emittedClient = compileDockerClient();
});

it.each([
  {
    name: 'keeps a compiled child create unresolved after normal exit and exact-owned cleanup',
    stalls: true,
    containerMode: false,
  },
  {
    name: 'settles a compiled child successful mutation and its initialized normal-exit participant',
    stalls: false,
    containerMode: false,
  },
  {
    name: 'requires independent exact-ID container retirement after compiled observer settlement',
    stalls: false,
    containerMode: true,
  },
])('$name', async ({ stalls, containerMode }) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-obs-'));
  const socket = join(directory, 'e.sock');
  const invocation = randomUUID();
  const ownedId = 'a'.repeat(64);
  const sentinelId = 'b'.repeat(64);
  const platformId = 'c'.repeat(64);
  const platformImage = `sha256:${'d'.repeat(64)}`;
  const platformInspect = {
    Id: platformId,
    Image: platformImage,
    State: { Running: true, StartedAt: '2026-01-02T03:04:05.123456789Z' },
  };
  const name = 'dsh-team-observer-owned';
  const body = { Image: 'owned-fixture-image', Labels: { 'dsh-team.test-run': invocation } };
  const sentinel = { Id: sentinelId, Name: '/unrelated-sentinel', Config: { Labels: {} } };
  const resources = new Map<string, unknown>([[sentinelId, sentinel]]);
  const createPath = `/containers/create?name=${name}`;
  const inspectPath = `/containers/${ownedId}/json`;
  const deletePath = `/containers/${ownedId}?force=true`;
  const { server, dispatched, bound, observation, requests, parentInspections } =
    createObserverEngineFixture({
      directory,
      stalls,
      platformInspect,
      ownedId,
      name,
      resources,
      createPath,
      inspectPath,
      deletePath,
    });
  try {
    initializeVerificationSubmissions(directory);
    await mkdir(join(directory, 'retirement-temporary'), { mode: 0o700 });
    const temporary = await realpath(join(directory, 'retirement-temporary'));
    const temporaryInfo = await stat(temporary);
    const assessmentRequest = {
      root: directory,
      temporary,
      temporaryDevice: String(temporaryInfo.dev),
      temporaryInode: String(temporaryInfo.ino),
    };
    await writeFile(join(directory, 'resources.jsonl'), '', { mode: 0o600, flag: 'wx' });
    const clientPath = await writeCompiledClient(directory, emittedClient);
    const authority = createVerificationDockerObserverAuthority(directory, {
      moduleUrl: pathToFileURL(clientPath).href,
      socketPath: socket,
      ...(containerMode ? { imageId: platformImage } : {}),
    });
    const reserved = await reserveVerificationDockerObserver(authority);
    const digest = createHash('sha256').update(emittedClient.javascript).digest('hex');
    server.listen(socket);
    await once(server, 'listening');
    const source = observerScenarioSource({
      directory,
      socket,
      clientPath,
      reserved,
      stalls,
      containerMode,
      assessmentRequest,
      createPath,
      body,
      ownedId,
      name,
      inspectPath,
      deletePath,
    });
    const outcome = await runObserverChild(reserved, source, {
      bindingGate: dispatched.promise,
      releaseResponse: () => {
        bound.resolve(undefined);
      },
      inspectContainer: containerMode
        ? async () => {
            const document = await createFixtureDockerClient(socket).json(
              'GET',
              `/containers/${platformId}/json`,
              undefined,
              AbortSignal.timeout(2000),
            );
            expect(document).toEqual(platformInspect);
            const inspected = document as typeof platformInspect;
            return {
              id: inspected.Id,
              imageId: inspected.Image,
              startedAt: inspected.State.StartedAt,
            };
          }
        : undefined,
    });

    expect(outcome, outcome.stderr).toMatchObject({ code: 0, signal: null });
    expect(outcome.stdout).toBe(
      stalls
        ? 'create-aborted-owned-cleanup-observed\n'
        : 'create-completed-owned-cleanup-observed\n',
    );
    expect(outcome.stderr).toBe('');
    expect(parentInspections).toEqual(containerMode ? [`/containers/${platformId}/json`] : []);
    expect(observation.persisted).toBe(true);
    expect(observation.markersBeforeBinding).toHaveLength(3);
    expect(observation.markersBeforeBinding).toEqual(
      expect.arrayContaining([reserved.participant, reserved.bindingApproval.id]),
    );
    expect(observation.stalledConnectionClosed).toBeDefined();
    await observation.stalledConnectionClosed;
    expect(observation.logClosed).toBeDefined();
    await observation.logClosed;
    expect(requests).toEqual([
      { method: 'POST', path: createPath, body: JSON.stringify(body) },
      { method: 'GET', path: inspectPath, body: '' },
      { method: 'DELETE', path: deletePath, body: '' },
      { method: 'GET', path: inspectPath, body: '' },
      { method: 'POST', path: '/networks/create', body: '{}' },
      { method: 'GET', path: '/large', body: '' },
      { method: 'GET', path: '/large', body: '' },
      { method: 'GET', path: '/logs', body: '' },
    ]);
    expect([...resources.entries()]).toEqual([[sentinelId, sentinel]]);
    await assertCompiledObserverEvidence(directory, reserved, clientPath, digest);
    const pending = await readdir(join(directory, SUBMISSION_PENDING));
    expect(pending).not.toContain(reserved.participant);
    expect(pending).not.toContain(reserved.bindingApproval.id);
    expect(pending).toHaveLength(stalls ? 1 : 0);
    if (stalls) {
      const markerName = pending[0];
      expect(markerName).toBeDefined();
      if (markerName === undefined) throw new Error('Interrupted request marker missing');
      const marker = JSON.parse(
        await readFile(join(directory, SUBMISSION_PENDING, markerName), 'utf8'),
      ) as {
        id: string;
        observer: string;
      };
      expect(markerName).toBe(`${reserved.generation}.${marker.id}`);
      expect(marker.observer).toBe(reserved.generation);
      expect(() => {
        requireVerificationDockerObserverRequestsSettled(reserved);
      }).toThrow();
      expect(() => {
        requireVerificationSubmissionsSettled(directory);
      }).toThrow('Verification submission settlement unconfirmed');
    } else {
      expect(() => {
        requireVerificationDockerObserverRequestsSettled(reserved);
      }).not.toThrow();
      expect(() => {
        requireVerificationSubmissionsSettled(directory);
      }).not.toThrow();
      if (containerMode) {
        await assertContainerRetirement(
          assessmentRequest,
          directory,
          reserved,
          platformInspect,
          sentinelId,
        );
      } else {
        expect(
          await assessTrustedDockerCleanup(assessmentRequest, directory, true, () => {
            throw new Error('Unexpected Docker inspection for process-only fixture');
          }),
        ).toEqual({ state: 'confirmed', browserExec: null });
      }
      await assertScopedMarkerIsolation(directory, reserved);
    }
    expect(freshObserverAssessment(directory)).toBe(stalls ? 'unconfirmed' : 'confirmed');
  } finally {
    server.closeAllConnections();
    bound.resolve(undefined);
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
  }
});

it.each([
  'missing-preload',
  'missing-factory',
  'wrong-generation',
  'foreign-authority',
  'foreign-capability',
  'missing-module-interception',
  'missing-parent-binding',
  'abrupt-exit',
  'publication-failure',
  'binding-publication-failure',
  'binding-replaced',
  'binding-changed',
  'changed-journal',
  'initialization-existing',
  'initialization-race',
  'initialization-missing',
  'initialization-replaced',
  'initialization-extra-link',
])('retains compiled observer uncertainty for %s', async (fault) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-obs-'));
  const socket = join(directory, 'e.sock');
  const behavior = observerFaultBehavior(fault);
  const { submitted, livenessOnly, hasHttp } = behavior;
  const dispatched = Promise.withResolvers<undefined>();
  const bound = Promise.withResolvers<undefined>();
  const requests: string[] = [];
  const markersAtDispatch: string[][] = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      requests.push(`${request.method ?? ''} ${request.url ?? ''}`);
      markersAtDispatch.push(readdirSync(join(directory, SUBMISSION_PENDING)));
      dispatched.resolve(undefined);
      void bound.promise.then(() => {
        if (!response.destroyed) response.writeHead(201).end('{"Id":"owned-effect"}');
      });
    });
  });
  try {
    initializeVerificationSubmissions(directory);
    const clientPath = await writeCompiledClient(directory, emittedClient);
    const { reserved, initializedPath } = await prepareObserverFault(
      directory,
      socket,
      clientPath,
      fault,
    );
    server.listen(socket);
    await once(server, 'listening');
    const source = observerFaultSource(fault, clientPath, socket, initializedPath, livenessOnly);
    const result = await runObserverChild(
      reserved,
      source,
      observerFaultOptions(fault, reserved, hasHttp, dispatched.promise, () => {
        bound.resolve(undefined);
      }),
    );

    if (fault === 'abrupt-exit') expect(result.signal).toBe('SIGKILL');
    else {
      expect(result.signal).toBeNull();
      expect(result.code).toBe(fault === 'missing-preload' ? 0 : 1);
    }
    expect(requests).toEqual(
      submitted ? ['POST /networks/create'] : livenessOnly ? ['GET /fixture-ready'] : [],
    );
    expect(markersAtDispatch).toHaveLength(hasHttp ? 1 : 0);
    if (hasHttp) {
      expect(markersAtDispatch[0]).toEqual(
        expect.arrayContaining([reserved.participant, reserved.bindingApproval.id]),
      );
      expect(markersAtDispatch[0]).toHaveLength(
        livenessOnly || fault === 'missing-preload' || fault === 'missing-module-interception'
          ? 2
          : 3,
      );
    }
    await assertObserverFaultEvidence(fault, behavior, directory, reserved, initializedPath);
    expect(() => {
      requireVerificationDockerObserverSettled(reserved);
    }).toThrow();
    expect(() => {
      requireVerificationSubmissionsSettled(directory);
    }).toThrow();
    expect(freshObserverAssessment(directory)).toBe('unconfirmed');
  } finally {
    server.closeAllConnections();
    bound.resolve(undefined);
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
  }
});

it.each([false, true])(
  'isolates same-authority process generations with predecessor uncertainty=%s',
  async (stalls) => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-obs-'));
    const socket = join(directory, 'e.sock');
    const requests: string[] = [];
    const requestGenerations: string[][] = [];
    const seenMarkers = new Set<string>();
    let dispatched = Promise.withResolvers<undefined>();
    let bound = Promise.withResolvers<undefined>();
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        requests.push(`${request.method ?? ''} ${request.url ?? ''}`);
        const markers = readdirSync(join(directory, SUBMISSION_PENDING)).map(
          (name) =>
            JSON.parse(readFileSync(join(directory, SUBMISSION_PENDING, name), 'utf8')) as {
              id: string;
              observer: string;
            },
        );
        requestGenerations.push(
          markers.filter((marker) => !seenMarkers.has(marker.id)).map((marker) => marker.observer),
        );
        for (const marker of markers) seenMarkers.add(marker.id);
        dispatched.resolve(undefined);
        if (stalls && requests.length === 1) {
          response.writeHead(201).write('{');
        } else {
          void bound.promise.then(() => {
            if (!response.destroyed) response.writeHead(201).end('{}');
          });
        }
      });
    });
    try {
      initializeVerificationSubmissions(directory);
      const clientPath = await writeCompiledClient(directory, emittedClient);
      const options = { moduleUrl: pathToFileURL(clientPath).href, socketPath: socket };
      const authority = createVerificationDockerObserverAuthority(directory, options);
      const first = await reserveVerificationDockerObserver(authority);
      seenMarkers.add(first.participant);
      seenMarkers.add(first.bindingApproval.id);
      const source = (abort: boolean) => `import assert from 'node:assert/strict';
import {createDockerClient,DockerHttpError} from ${JSON.stringify(options.moduleUrl)};
const client=createDockerClient(${JSON.stringify(socket)});
const create=client.json('POST','/networks/create',{},AbortSignal.timeout(${String(abort ? 200 : 2000)}));
${abort ? 'await assert.rejects(create,error=>error instanceof Error&&!(error instanceof DockerHttpError));' : 'assert.deepEqual(await create,{});'}
await client.json('DELETE','/networks/owned-effect',undefined,AbortSignal.timeout(2000));`;
      server.listen(socket);
      await once(server, 'listening');
      const currentPath = join(authority.bootstrap, 'current.json');
      const originalManifest = await readFile(currentPath);
      const firstOutcome = await runObserverChild(first, source(stalls), {
        bindingGate: dispatched.promise,
        releaseResponse: () => {
          bound.resolve(undefined);
        },
        beforeRelease: async () => {
          const pending = await readdir(join(directory, SUBMISSION_PENDING));
          await expect(reserveVerificationDockerObserver(authority)).rejects.toThrow();
          expect(await readdir(join(directory, SUBMISSION_PENDING))).toEqual(pending);
          expect(await readFile(currentPath)).toEqual(originalManifest);
          // A live process must keep its captured generation even if the parent manifest changes.
          await writeFile(
            currentPath,
            JSON.stringify({
              version: 1,
              nonce: randomUUID(),
              authority: authority.authority,
            }),
            { mode: 0o600 },
          );
        },
      });
      expect(firstOutcome, firstOutcome.stderr).toMatchObject({ code: 0, signal: null });
      await writeFile(currentPath, originalManifest, { mode: 0o600 });
      expect(() => {
        requireVerificationDockerObserverSettled(first);
      }).not.toThrow();
      const predecessorPending = await readdir(join(directory, SUBMISSION_PENDING));
      expect(predecessorPending).toHaveLength(stalls ? 1 : 0);

      const second = await reserveVerificationDockerObserver(authority);
      seenMarkers.add(second.participant);
      seenMarkers.add(second.bindingApproval.id);
      expect(second.authority).toBe(first.authority);
      expect(second.bootstrap).toBe(first.bootstrap);
      expect(second.generation).not.toBe(first.generation);
      expect(second.participant).not.toBe(first.participant);
      expect(second.bindingApproval.id).not.toBe(first.bindingApproval.id);
      dispatched = Promise.withResolvers<undefined>();
      bound = Promise.withResolvers<undefined>();
      const secondOutcome = await runObserverChild(second, source(false), {
        bindingGate: dispatched.promise,
        releaseResponse: () => {
          bound.resolve(undefined);
        },
      });
      expect(secondOutcome, secondOutcome.stderr).toMatchObject({ code: 0, signal: null });
      expect(requests).toEqual([
        'POST /networks/create',
        'DELETE /networks/owned-effect',
        'POST /networks/create',
        'DELETE /networks/owned-effect',
      ]);
      expect(requestGenerations.slice(0, 2)).toEqual([[first.generation], [first.generation]]);
      expect(requestGenerations.slice(2)).toEqual([[second.generation], [second.generation]]);
      expect(() => {
        requireVerificationDockerObserverSettled(first);
      }).not.toThrow();
      expect(() => {
        requireVerificationDockerObserverSettled(second);
      }).not.toThrow();
      expect(() => {
        requireVerificationDockerObserverRequestsSettled(second);
      }).not.toThrow();
      expect(await readdir(join(directory, SUBMISSION_PENDING))).toEqual(predecessorPending);
      expect(freshObserverAssessment(directory)).toBe(stalls ? 'unconfirmed' : 'confirmed');

      const previousBinding = JSON.parse(
        await readFile(join(second.bootstrap, `${second.generation}.binding.json`), 'utf8'),
      ) as { witness: DockerProcessWitness };
      const third = await reserveVerificationDockerObserver(authority);
      expect(() => {
        bindVerificationDockerObserver(third, {
          ...previousBinding.witness,
          generation: third.generation,
        });
      }).toThrow();
      await expect(
        readFile(join(third.bootstrap, `${third.generation}.binding.json`)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      // A fresh reservation cannot authorize replay of a predecessor's already-claimed process.
      await writeFile(currentPath, originalManifest, { mode: 0o600 });
      const replay = await runObserverChild(third, source(false), { bind: false });
      expect(replay).toMatchObject({ code: 1, signal: null });
      expect(requests).toHaveLength(4);
      expect(await readdir(join(directory, SUBMISSION_PENDING))).toEqual(
        expect.arrayContaining([
          ...predecessorPending,
          third.participant,
          third.bindingApproval.id,
        ]),
      );
      expect(freshObserverAssessment(directory)).toBe('unconfirmed');
    } finally {
      server.closeAllConnections();
      bound.resolve(undefined);
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
    }
  },
);

async function assertObserverFaultEvidence(
  fault: string,
  behavior: ObserverFaultBehavior,
  directory: string,
  reserved: DockerObserverReservation,
  initializedPath: string,
): Promise<void> {
  const { livenessOnly, initializationTamper, initializationFailure } = behavior;
  if (
    livenessOnly ||
    initializationTamper ||
    fault === 'binding-replaced' ||
    fault === 'binding-changed'
  )
    expect(await readdir(join(directory, SUBMISSION_PENDING))).toEqual([reserved.participant]);
  if (livenessOnly || initializationTamper)
    expect(() => {
      requireVerificationDockerObserverInitialized(reserved);
    }).toThrow();
  if (initializationFailure)
    expect(await readFile(initializedPath, 'utf8')).toBe('foreign-initialization\n');
  if (fault === 'binding-publication-failure') {
    expect(await readdir(join(directory, SUBMISSION_PENDING))).toEqual(
      expect.arrayContaining([reserved.participant, reserved.bindingApproval.id]),
    );
    const rows = (await readFile(join(directory, SUBMISSION_JOURNAL), 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line: string) => JSON.parse(line) as { id: string; state: string });
    expect(rows).toContainEqual(
      expect.objectContaining({ id: reserved.bindingApproval.id, state: 'settled' }),
    );
    expect(() => {
      requireVerificationDockerObserverInitialized(reserved);
    }).toThrow();
  }
}

async function assertContainerRetirement(
  assessmentRequest: CleanupAssessmentRequest,
  directory: string,
  reserved: DockerObserverReservation,
  platformInspect: FixturePlatform,
  sentinelId: string,
): Promise<void> {
  const platformId = platformInspect.Id;
  expect(requireVerificationSubmissionsSettled(directory)).toEqual([
    {
      kind: 'container',
      authority: reserved.authority,
      generation: reserved.generation,
      id: platformId,
      imageId: platformInspect.Image,
      startedAt: platformInspect.State.StartedAt,
    },
  ]);
  for (const state of ['present', 'transport', 'ambiguous', 'foreign-absence', 'absent']) {
    const inspected: string[][] = [];
    const assessment = await assessTrustedDockerCleanup(
      assessmentRequest,
      directory,
      true,
      (args) => {
        inspected.push([...args]);
        if (state === 'present')
          return { status: 0, stdout: JSON.stringify([platformInspect]), stderr: '' };
        if (state === 'transport')
          return {
            status: null,
            stdout: '',
            stderr: '',
            error: new Error('owned-inspect-transport-failure'),
          };
        if (state === 'ambiguous') return { status: 1, stdout: '', stderr: 'container not found' };
        return {
          status: 1,
          stdout: '',
          stderr: `Error response from daemon: No such container: ${state === 'absent' ? platformId : sentinelId}`,
        };
      },
    );
    expect(inspected).toEqual([['container', 'inspect', platformId]]);
    expect(assessment).toEqual({
      state: state === 'absent' ? 'confirmed' : 'unconfirmed',
      browserExec: null,
    });
  }
}

async function assertScopedMarkerIsolation(
  directory: string,
  reserved: DockerObserverReservation,
): Promise<void> {
  const unrelatedNames = [randomUUID(), `${randomUUID()}.${randomUUID()}`];
  for (const name of unrelatedNames)
    await writeFile(join(directory, SUBMISSION_PENDING, name), '', { mode: 0o600, flag: 'wx' });
  expect(() => {
    requireVerificationDockerObserverRequestsSettled(reserved);
  }).not.toThrow();
  expect(() => {
    requireVerificationSubmissionsSettled(directory);
  }).toThrow();
  for (const name of unrelatedNames) await unlink(join(directory, SUBMISSION_PENDING, name));
  for (const name of [`${reserved.generation}.${randomUUID()}`, 'malformed-marker']) {
    await writeFile(join(directory, SUBMISSION_PENDING, name), '', { mode: 0o600, flag: 'wx' });
    expect(() => {
      requireVerificationDockerObserverRequestsSettled(reserved);
    }).toThrow();
    await unlink(join(directory, SUBMISSION_PENDING, name));
  }
}

async function assertCompiledObserverEvidence(
  directory: string,
  reserved: DockerObserverReservation,
  clientPath: string,
  digest: string,
): Promise<void> {
  expect(
    createHash('sha256')
      .update(await readFile(clientPath))
      .digest('hex'),
  ).toBe(digest);
  process.stdout.write(`${JSON.stringify({ compiledDockerClientSha256: digest })}\n`);
  expect(() => {
    requireVerificationDockerObserverSettled(reserved);
  }).not.toThrow();
  expect(() => {
    requireVerificationDockerObserverInitialized(reserved);
  }).not.toThrow();
  const initializedPath = join(
    dirname(join(directory, SUBMISSION_JOURNAL)),
    `observer-${reserved.generation}.initialized`,
  );
  const initialized = await stat(initializedPath);
  const prepared = await stat(`${initializedPath}-prepared`);
  expect(initialized.nlink).toBe(2);
  expect(prepared.nlink).toBe(2);
  expect(prepared.ino).toBe(initialized.ino);
  expect(prepared.dev).toBe(initialized.dev);
  expect(initialized.mode & 0o777).toBe(0o600);
}
