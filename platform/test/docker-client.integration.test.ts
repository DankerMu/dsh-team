import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  initializeVerificationSubmissions,
  SUBMISSION_JOURNAL,
} from '../../scripts/verification-submission-storage.mjs';
import { requireVerificationSubmissionsSettled } from '../../scripts/verification-submission-assessment.mjs';
import { trackVerificationDockerClient } from '../../scripts/verification-submissions.mjs';
import { createDockerClient, DockerHttpError } from '../src/orchestrator/index.ts';

it('uses a real owned Unix HTTP socket for JSON, status, incremental logs and cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-http-'));
  const socket = join(directory, 'engine.sock');
  const previousSubmissions = process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS;
  let logClosed: Promise<unknown> | undefined;
  const server = createServer((request, response) => {
    if (request.url === '/missing') {
      response.writeHead(404).end('secret daemon detail');
      return;
    }
    if (request.url === '/logs') {
      logClosed = once(response, 'close');
      response.write(Buffer.from('010000000000000361', 'hex'));
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () =>
      response.end(
        JSON.stringify({
          method: request.method,
          path: request.url,
          body: Buffer.concat(chunks).toString(),
        }),
      ),
    );
  });
  try {
    initializeVerificationSubmissions(directory);
    process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS = join(directory, SUBMISSION_JOURNAL);
    server.listen(socket);
    await once(server, 'listening');
    const raw = createDockerClient(socket);
    const client = trackVerificationDockerClient(raw, DockerHttpError);

    expect(await client.json('POST', '/create?name=a%20b', { Image: '中文' })).toEqual({
      method: 'POST',
      path: '/create?name=a%20b',
      body: '{"Image":"中文"}',
    });
    await expect(client.json('GET', '/missing')).rejects.toMatchObject({ statusCode: 404 });
    const logs = client.logs('/logs');
    expect(await logs.next()).toMatchObject({
      done: false,
      value: { stream: 'stdout', data: Buffer.from('a') },
    });
    await logs.return(undefined);
    await logClosed;
    await expect(
      createDockerClient(join(directory, 'absent.sock')).json('GET', '/version'),
    ).rejects.toThrow(`Docker socket ${join(directory, 'absent.sock')}: ENOENT`);
    expect(() => {
      requireVerificationSubmissionsSettled(directory);
    }).not.toThrow();
  } finally {
    if (previousSubmissions === undefined) delete process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS;
    else process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS = previousSubmissions;
    server.closeAllConnections();
    try {
      if (server.listening)
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

const submissionScenarios: {
  name: string;
  method?: string;
  path: string;
  status: number;
  inventory: string;
  settles: boolean;
  canonical?: boolean;
}[] = [
  {
    name: 'settles canonical network-create 403 without replacing its rejection',
    path: '/networks/create',
    status: 403,
    inventory: '/networks',
    settles: true,
  },
  {
    name: 'keeps sibling volume-create 403 unresolved',
    path: '/volumes/create',
    status: 403,
    inventory: '/volumes',
    settles: false,
  },
  {
    name: 'keeps truncated network-create success unresolved',
    path: '/networks/create',
    status: 201,
    inventory: '/networks',
    settles: false,
  },
  {
    name: 'settles network-create 403 with its original query',
    path: '/networks/create?checkDuplicate=true',
    status: 403,
    inventory: '/networks',
    settles: true,
  },
  {
    name: 'settles an already-stopped container 304',
    path: '/containers/owned-container/stop?t=2',
    status: 304,
    inventory: '/containers/owned-container/json',
    settles: true,
  },
  ...['containers', 'networks', 'volumes'].map((kind) => ({
    name: `settles an exact absent ${kind} delete 404`,
    method: 'DELETE',
    path: `/${kind}/owned-resource?force=true`,
    status: 404,
    inventory: '/networks',
    settles: true,
  })),
  {
    name: 'keeps network-create 500 unresolved',
    path: '/networks/create',
    status: 500,
    inventory: '/networks',
    settles: false,
  },
  {
    name: 'keeps a stop sibling endpoint 304 unresolved',
    path: '/containers/owned-container/restart',
    status: 304,
    inventory: '/containers/owned-container/json',
    settles: false,
  },
  {
    name: 'keeps a noncanonical error constructor unresolved',
    path: '/networks/create',
    status: 403,
    inventory: '/networks',
    settles: false,
    canonical: false,
  },
  ...[
    '/networks/',
    '/networks/..',
    '/networks/%2e%2e',
    '/networks/owned%2fresource',
    '/networks/owned/resource',
    '/images/owned-resource',
  ].map((path) => ({
    name: `keeps nonmatching delete ${path} unresolved`,
    method: 'DELETE',
    path,
    status: 404,
    inventory: '/networks',
    settles: false,
  })),
  {
    name: 'keeps a wait sibling endpoint failure unresolved',
    path: '/containers/owned-container/wait/extra',
    status: 500,
    inventory: '/networks',
    settles: false,
  },
  {
    name: 'keeps a nonmatching network-create method unresolved',
    method: 'PUT',
    path: '/networks/create',
    status: 403,
    inventory: '/networks',
    settles: false,
  },
  {
    name: 'keeps a dot-segment stop target unresolved',
    path: '/containers/../stop',
    status: 304,
    inventory: '/networks',
    settles: false,
  },
  {
    name: 'keeps an encoded-separator wait target unresolved',
    path: '/containers/owned%2fcontainer/wait',
    status: 500,
    inventory: '/networks',
    settles: false,
  },
];

it.each(submissionScenarios)(
  'verification submission settlement: $name',
  async ({ method = 'POST', path, status, inventory, settles, canonical = true }) => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-http-'));
    const socket = join(directory, 'engine.sock');
    const submissions = join(directory, SUBMISSION_JOURNAL);
    const previousSubmissions = process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS;
    const body = { Name: 'dsh-team-rejection-fixture' };
    const resources: unknown[] = [];
    const requests: { method: string | undefined; path: string | undefined; body: string }[] = [];
    const pendingAtDispatch: unknown[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const document = Buffer.concat(chunks).toString();
        requests.push({ method: request.method, path: request.url, body: document });
        if (request.method === method && request.url === path) {
          try {
            requireVerificationSubmissionsSettled(directory);
            pendingAtDispatch.push(undefined);
          } catch (error) {
            pendingAtDispatch.push(error);
          }
          if (status === 201) {
            resources.push(JSON.parse(document));
            // Successful headers do not complete a create whose JSON is truncated.
            response.writeHead(status).end('{');
          } else {
            // Header rejections must not wait for an error body the original client destroys.
            response.writeHead(status);
            response.flushHeaders();
            if (status !== 304) response.write('rejected');
          }
        } else if (request.method === 'GET' && request.url === inventory) {
          response.end(
            JSON.stringify(
              inventory.endsWith('/json')
                ? { Id: 'owned-container', State: { Running: false } }
                : inventory === '/volumes'
                  ? { Volumes: resources }
                  : resources,
            ),
          );
        } else {
          response.writeHead(404).end();
        }
      });
    });
    try {
      initializeVerificationSubmissions(directory);
      process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS = submissions;
      server.listen(socket);
      await once(server, 'listening');
      const raw = createDockerClient(socket);
      let originalError: unknown;
      // A distinct constructor cannot authorize errors emitted by the actual client.
      class OtherDockerHttpError extends DockerHttpError {}
      const observing: typeof raw = {
        ...raw,
        async json(...args) {
          try {
            return await raw.json(...args);
          } catch (error) {
            originalError = error;
            throw error;
          }
        },
      };
      const client = trackVerificationDockerClient(
        observing,
        canonical ? DockerHttpError : OtherDockerHttpError,
      );

      const { error } = await client.json(method, path, body, AbortSignal.timeout(2_000)).then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );
      const observed = await client.json('GET', inventory, undefined, AbortSignal.timeout(2_000));

      expect(error).toBeInstanceOf(Error);
      expect(error).toBe(originalError);
      if (status !== 201) {
        expect(error).toBeInstanceOf(DockerHttpError);
        expect(error).toMatchObject({ statusCode: status });
      } else {
        expect(error).not.toBeInstanceOf(DockerHttpError);
      }
      expect(pendingAtDispatch).toHaveLength(1);
      expect(pendingAtDispatch[0]).toEqual(
        new Error('Verification submission settlement unconfirmed'),
      );
      expect(requests).toEqual([
        { method, path, body: JSON.stringify(body) },
        { method: 'GET', path: inventory, body: '' },
      ]);
      const expectedResources = status === 201 ? [body] : [];
      expect(observed).toEqual(
        inventory.endsWith('/json')
          ? { Id: 'owned-container', State: { Running: false } }
          : inventory === '/volumes'
            ? { Volumes: expectedResources }
            : expectedResources,
      );
      expect(await readFile(submissions, 'utf8')).not.toBe('');
      if (status === 201) {
        // A later exact-delete rejection settles only itself, never this lost create.
        await expect(
          client.json('DELETE', '/networks/missing', undefined, AbortSignal.timeout(2_000)),
        ).rejects.toMatchObject({ statusCode: 404 });
      }
      if (settles) {
        expect(() => {
          requireVerificationSubmissionsSettled(directory);
        }).not.toThrow();
      } else {
        expect(() => {
          requireVerificationSubmissionsSettled(directory);
        }).toThrow('Verification submission settlement unconfirmed');
      }
    } finally {
      if (previousSubmissions === undefined) delete process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS;
      else process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS = previousSubmissions;
      server.closeAllConnections();
      try {
        if (server.listening)
          await new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error) reject(error);
              else resolve();
            });
          });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
);

it.each(['success', 'rejected', 'cancelled'])(
  'keeps canonical container wait %s observational',
  async (outcome) => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-http-'));
    const socket = join(directory, 'engine.sock');
    const submissions = join(directory, SUBMISSION_JOURNAL);
    const previousSubmissions = process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS;
    const path = '/containers/owned-container/wait?condition=next-exit';
    const received = Promise.withResolvers<undefined>();
    const evidenceAtDispatch: string[] = [];
    const requests: string[] = [];
    let closed: Promise<unknown> | undefined;
    const server = createServer((request, response) => {
      requests.push(`${request.method ?? ''} ${request.url ?? ''}`);
      request.resume();
      request.on('end', () => {
        if (request.method === 'POST' && request.url === path) {
          evidenceAtDispatch.push(readFileSync(submissions, 'utf8'));
          closed = once(response, 'close');
          if (outcome === 'cancelled') response.writeHead(200).write('{');
          else if (outcome === 'rejected') response.writeHead(404).end();
          else response.end('{"StatusCode":0}');
          received.resolve(undefined);
        } else {
          response.end(
            JSON.stringify({
              Id: 'owned-container',
              State: { Running: outcome !== 'success' },
            }),
          );
        }
      });
    });
    try {
      initializeVerificationSubmissions(directory);
      process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS = submissions;
      server.listen(socket);
      await once(server, 'listening');
      const client = trackVerificationDockerClient(createDockerClient(socket), DockerHttpError);
      const controller = new AbortController();
      const pending = client
        .json(
          'POST',
          path,
          undefined,
          AbortSignal.any([controller.signal, AbortSignal.timeout(2_000)]),
        )
        .then(
          (value) => ({ value, error: undefined }),
          (error: unknown) => ({ value: undefined, error }),
        );

      await received.promise;
      if (outcome === 'cancelled') controller.abort();
      const result = await pending;
      await closed;
      const state = await client.json(
        'GET',
        '/containers/owned-container/json',
        undefined,
        AbortSignal.timeout(2_000),
      );

      if (outcome === 'success')
        expect(result).toEqual({ value: { StatusCode: 0 }, error: undefined });
      else {
        expect(result.error).toBeInstanceOf(Error);
        if (outcome === 'rejected') expect(result.error).toMatchObject({ statusCode: 404 });
        else expect(result.error).not.toBeInstanceOf(DockerHttpError);
      }
      expect(state).toEqual({
        Id: 'owned-container',
        State: { Running: outcome !== 'success' },
      });
      expect(requests).toEqual([`POST ${path}`, 'GET /containers/owned-container/json']);
      expect(evidenceAtDispatch).toEqual(['']);
      expect(await readFile(submissions, 'utf8')).toBe('');
      expect(() => {
        requireVerificationSubmissionsSettled(directory);
      }).not.toThrow();
    } finally {
      if (previousSubmissions === undefined) delete process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS;
      else process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS = previousSubmissions;
      server.closeAllConnections();
      try {
        if (server.listening)
          await new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error) reject(error);
              else resolve();
            });
          });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
);

it('refuses mutation dispatch when submission publication is unavailable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-http-'));
  const socket = join(directory, 'engine.sock');
  const previousSubmissions = process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method ?? ''} ${request.url ?? ''}`);
    response.end('{}');
  });
  try {
    // The journal is intentionally absent: authority failure must precede the client call.
    process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS = join(directory, SUBMISSION_JOURNAL);
    server.listen(socket);
    await once(server, 'listening');
    const raw = createDockerClient(socket);
    let dispatches = 0;
    const observing: typeof raw = {
      ...raw,
      json(...args) {
        dispatches += 1;
        return raw.json(...args);
      },
    };
    const client = trackVerificationDockerClient(observing, DockerHttpError);

    await expect(
      client.json(
        'POST',
        '/networks/create',
        { Name: 'owned-network' },
        AbortSignal.timeout(2_000),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    expect(dispatches).toBe(0);
    expect(requests).toEqual([]);
  } finally {
    if (previousSubmissions === undefined) delete process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS;
    else process.env.DSH_TEAM_VERIFICATION_SUBMISSIONS = previousSubmissions;
    server.closeAllConnections();
    try {
      if (server.listening)
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
