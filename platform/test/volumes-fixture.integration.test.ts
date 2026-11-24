import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import type * as Orchestrator from '../src/orchestrator/index.ts';
import {
  initializeVerificationSubmissions,
  SUBMISSION_JOURNAL,
} from '../../scripts/verification-submission-storage.mjs';
import { requireVerificationSubmissionsSettled } from '../../scripts/verification-submission-assessment.mjs';
import { readCleanupJournal } from './docker-cleanup.ts';
import { runUserVolumes } from './volumes-fixture.ts';

const cancellations = vi.hoisted(
  () => new Map<string, { error: unknown; signal: AbortSignal | undefined }>(),
);
vi.mock('../src/orchestrator/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof Orchestrator>();
  return {
    ...actual,
    createDockerClient(...args: Parameters<typeof actual.createDockerClient>) {
      const client = actual.createDockerClient(...args);
      return {
        ...client,
        async json(...request: Parameters<typeof client.json>) {
          try {
            return await client.json(...request);
          } catch (error) {
            if (request[0] === 'POST' && request[1] === '/volumes/create')
              cancellations.set(args[0], { error, signal: request[3] });
            // Observe the real transport rejection before custody; never supply an expected error.
            throw error;
          }
        },
      };
    },
  };
});

// Each aggregated error as `Class: message`, plus one cause level, so a length
// mismatch names the unexpected error instead of only counting it.
function describeErrors(errors: unknown[]): string[] {
  return errors.map((error) => {
    if (!(error instanceof Error)) return typeof error;
    const head = `${error.constructor.name}: ${error.message}`;
    const { cause } = error;
    if (cause === undefined) return head;
    if (!(cause instanceof Error)) return `${head} (cause ${typeof cause})`;
    return `${head} (cause ${cause.constructor.name}: ${cause.message})`;
  });
}

// The stall bound covers acceptance mutations, the read bound acceptance reads and cleanup.
const STALL_MS = 200;
const READ_MS = 1_000;
// Watchdog headroom past a case's worst legitimate path, for timers firing late under load.
const WATCHDOG_MARGIN_MS = 2_000;
// Each case's watchdog is its worst legitimate path, every request at its full bound, plus the
// margin. A stalled case: four collision GETs, the stalled create, then cleanup of user 00 only
// (work's GET; home's GET, DELETE and GET).
const STALLED_WATCHDOG_MS = 4 * READ_MS + STALL_MS + 4 * READ_MS + WATCHDOG_MARGIN_MS;
// Strictly above the largest watchdog (the success case's, 30s) plus setup, assertions and close.
const VOLUMES_CASE_MS = 35_000;

interface DelayedRequest {
  method: string | undefined;
  path: string | undefined;
  status?: number;
}

// The injected delay must hit the intended GET and still be answered, proving the slow request
// was that one: cleanup's first GET is the absent work volume of the stalled user, and the
// first collision GET is the absent home volume the create later persists.
function expectDelayed(
  delayed: DelayedRequest | undefined,
  delays: 'cleanup' | 'probe' | undefined,
  persistedName: string | undefined,
): void {
  if (delays === undefined) {
    expect(delayed).toBeUndefined();
    return;
  }
  const name = persistedName ?? '';
  expect(delayed).toEqual({
    method: 'GET',
    path: `/volumes/${delays === 'cleanup' ? name.replace('-home-', '-work-') : name}`,
    status: 404,
  });
}

it.each([
  {
    name: 'aborts a persisted stalled create and reaches exact-owned cleanup without watchdog rescue',
    stalls: true,
    delays: undefined,
    stallMs: STALL_MS,
    watchdogMs: STALLED_WATCHDOG_MS,
  },
  {
    name: 'cleanup slower than the stall budget still aggregates only the cancellation',
    stalls: true,
    delays: 'cleanup',
    stallMs: STALL_MS,
    watchdogMs: STALLED_WATCHDOG_MS,
  },
  {
    name: 'a collision probe slower than the stall budget still aggregates only the cancellation',
    stalls: true,
    delays: 'probe',
    stallMs: STALL_MS,
    watchdogMs: STALLED_WATCHDOG_MS,
  },
  {
    name: 'settles successful volume creation and exact-owned cleanup while preserving unrelated volumes',
    stalls: false,
    delays: undefined,
    // No stall is under test here, and a 200ms POST under load would be the same false failure.
    stallMs: READ_MS,
    // Four collision GETs, eight POSTs, four post-create inspections and twelve cleanup
    // requests (GET, DELETE, GET per target).
    watchdogMs: (4 + 8 + 4 + 12) * READ_MS + WATCHDOG_MARGIN_MS,
  },
] as const)('$name', { timeout: VOLUMES_CASE_MS }, async ({ stalls, delays, ...bounds }) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-volumes-'));
  const socket = join(directory, 'engine.sock');
  const submissions = join(directory, SUBMISSION_JOURNAL);
  const resources = join(directory, 'resources.jsonl');
  const previousSubmissions = process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS;
  const previousResources = process.env.DSH_TEAM_CI_RESOURCE_JOURNAL;
  const sentinel = { Name: 'unrelated-volume', Labels: { 'dsh-team.user': 'unrelated' } };
  const volumes = new Map<string, unknown>([[sentinel.Name, sentinel]]);
  const requests: { method: string | undefined; path: string | undefined }[] = [];
  const registrationsAtCreate: string[] = [];
  let stalled: ServerResponse | undefined;
  let connectionClosed: Promise<unknown> | undefined;
  let persistedName: string | undefined;
  // The first request after the stalled create is cleanup's first GET, and the very first
  // request is the first collision GET; delaying either past the stall bound, inside the read
  // bound, reproduces a slow runner deterministically.
  let delayedRequest: DelayedRequest | undefined;
  let delayTimer: NodeJS.Timeout | undefined;
  function answer(request: IncomingMessage, response: ServerResponse): void {
    const name = request.url?.slice('/volumes/'.length) ?? '';
    if (!volumes.has(name)) {
      response.writeHead(404).end();
    } else if (request.method === 'DELETE') {
      volumes.delete(name);
      response.writeHead(204).end();
    } else {
      response.end(JSON.stringify(volumes.get(name)));
    }
  }
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url });
    if (request.method === 'POST' && request.url === '/volumes/create') {
      registrationsAtCreate.push(readFileSync(resources, 'utf8'));
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const document: unknown = JSON.parse(Buffer.concat(chunks).toString());
        if (
          typeof document !== 'object' ||
          document === null ||
          !('Name' in document) ||
          typeof document.Name !== 'string'
        ) {
          response.writeHead(400).end();
          return;
        }
        persistedName = document.Name;
        volumes.set(document.Name, document);
        if (stalls) {
          stalled = response;
          connectionClosed = once(request.socket, 'close');
          response.writeHead(201).write('{');
        } else {
          response.writeHead(201).end(JSON.stringify(document));
        }
      });
      return;
    }
    const due = delays === 'cleanup' ? stalled !== undefined : delays === 'probe';
    if (due && delayedRequest === undefined) {
      const delayed: DelayedRequest = {
        method: request.method,
        path: request.url,
      };
      delayedRequest = delayed;
      delayTimer = setTimeout(() => {
        if (response.destroyed) return;
        answer(request, response);
        delayed.status = response.statusCode;
      }, 300);
      return;
    }
    answer(request, response);
  });
  try {
    initializeVerificationSubmissions(directory);
    await writeFile(resources, '', { mode: 0o600, flag: 'wx' });
    process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS = submissions;
    process.env.DSH_TEAM_CI_RESOURCE_JOURNAL = resources;
    server.listen(socket);
    await once(server, 'listening');
    const settled = runUserVolumes(socket, bounds.stallMs, READ_MS).then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    const watchdog = new AbortController();
    const rescued = await Promise.race([
      settled.then(async () => {
        // The same watchdog bounds both cleanup completion and closure of the
        // actual stalled connection; neither proof can await indefinitely.
        if (connectionClosed !== undefined) await connectionClosed;
        return false;
      }),
      delay(bounds.watchdogMs, true, { signal: watchdog.signal }),
    ]);
    watchdog.abort();
    // The pre-fix RED also releases its hung fixture, so this test never leaves a socket/resource behind.
    if (rescued) stalled?.destroy();
    const { error } = await settled;

    expect(
      rescued,
      'Acceptance must cancel, close its stalled connection and finish cleanup before rescue',
    ).toBe(false);
    if (stalls) {
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError))
        throw new Error('Expected aggregated acceptance failure');
      // Exactly one error; a mismatch diff prints every description.
      expect(describeErrors(error.errors)).toEqual([expect.any(String)]);
      expect(error.errors[0]).toBeInstanceOf(Error);
      const cancellation = cancellations.get(socket);
      if (cancellation === undefined)
        throw new Error('Canonical mutation cancellation was not observed');
      expect(cancellation.signal?.aborted).toBe(true);
      expect(error.errors[0]).toBe(cancellation.error);
      // Transport errors are sanitized rather than retaining a raw abort cause.
      expect(error.errors[0]).not.toHaveProperty('cause');
      expect(persistedName).toMatch(/^dsh-team-home-[a-f0-9]{10}00$/);
      expect(requests.filter(({ method }) => method === 'POST')).toEqual([
        { method: 'POST', path: '/volumes/create' },
      ]);
      expect(requests.filter(({ method }) => method === 'DELETE')).toEqual([
        { method: 'DELETE', path: `/volumes/${persistedName ?? ''}` },
      ]);
      expectDelayed(delayedRequest, delays, persistedName);
    } else {
      expect(error).toBeUndefined();
      expect(requests.filter(({ method }) => method === 'POST')).toEqual(
        Array.from({ length: 8 }, () => ({ method: 'POST', path: '/volumes/create' })),
      );
      expect(requests.filter(({ method }) => method === 'DELETE')).toEqual(
        readCleanupJournal(resources)
          .toReversed()
          .map(({ target }) => ({ method: 'DELETE', path: `/volumes/${target.name}` })),
      );
    }
    expect([...volumes.entries()]).toEqual([[sentinel.Name, sentinel]]);
    const registrations = readCleanupJournal(resources);
    expect(registrations).toHaveLength(4);
    expect(new Set(registrations.map(({ runId }) => runId)).size).toBe(1);
    for (const { target } of registrations) {
      expect(target.kind).toBe('volume');
      expect(target.name).toMatch(/^dsh-team-(?:home|work)-[a-f0-9]{10}0[01]$/);
      expect(target.ownership).toEqual({ 'dsh-team.user': target.name.slice(-12) });
    }
    const resourceEvidence = await readFile(resources, 'utf8');
    expect(registrationsAtCreate).toEqual(
      Array.from({ length: stalls ? 1 : 8 }, () => resourceEvidence),
    );
    expect(await readFile(submissions, 'utf8')).not.toBe('');
    if (stalls) {
      expect(() => {
        requireVerificationSubmissionsSettled(directory);
      }).toThrow('Verification submission settlement unconfirmed');
    } else {
      expect(() => {
        requireVerificationSubmissionsSettled(directory);
      }).not.toThrow();
    }
  } finally {
    clearTimeout(delayTimer);
    cancellations.delete(socket);
    if (previousSubmissions === undefined) delete process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS;
    else process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS = previousSubmissions;
    if (previousResources === undefined) delete process.env.DSH_TEAM_CI_RESOURCE_JOURNAL;
    else process.env.DSH_TEAM_CI_RESOURCE_JOURNAL = previousResources;
    stalled?.destroy();
    server.closeAllConnections();
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
    await rm(directory, { recursive: true, force: true });
  }
});
