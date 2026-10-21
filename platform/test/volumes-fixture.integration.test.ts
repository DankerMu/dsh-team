import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import {
  initializeVerificationSubmissions,
  SUBMISSION_JOURNAL,
} from '../../scripts/verification-submission-storage.mjs';
import { requireVerificationSubmissionsSettled } from '../../scripts/verification-submission-assessment.mjs';
import { readCleanupJournal } from './docker-cleanup.ts';
import { runUserVolumes } from './volumes-fixture.ts';

it.each([
  {
    name: 'aborts a persisted stalled create and reaches exact-owned cleanup without watchdog rescue',
    stalls: true,
  },
  {
    name: 'settles successful volume creation and exact-owned cleanup while preserving unrelated volumes',
    stalls: false,
  },
])('$name', async ({ stalls }) => {
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
    const name = request.url?.slice('/volumes/'.length) ?? '';
    if (!volumes.has(name)) {
      response.writeHead(404).end();
    } else if (request.method === 'DELETE') {
      volumes.delete(name);
      response.writeHead(204).end();
    } else {
      response.end(JSON.stringify(volumes.get(name)));
    }
  });
  try {
    initializeVerificationSubmissions(directory);
    await writeFile(resources, '', { mode: 0o600, flag: 'wx' });
    process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS = submissions;
    process.env.DSH_TEAM_CI_RESOURCE_JOURNAL = resources;
    server.listen(socket);
    await once(server, 'listening');
    const settled = runUserVolumes(socket, 200).then(
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
      delay(2_000, true, { signal: watchdog.signal }),
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
      expect(error.errors).toHaveLength(1);
      expect(error.errors[0]).toBeInstanceOf(Error);
      // Transport errors are sanitized rather than retaining a raw abort cause.
      expect(error.errors[0]).not.toHaveProperty('cause');
      expect(persistedName).toMatch(/^dsh-team-home-[a-f0-9]{10}00$/);
      expect(requests.filter(({ method }) => method === 'POST')).toEqual([
        { method: 'POST', path: '/volumes/create' },
      ]);
      expect(requests.filter(({ method }) => method === 'DELETE')).toEqual([
        { method: 'DELETE', path: `/volumes/${persistedName ?? ''}` },
      ]);
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
