import type { RequestOptions } from 'node:http';
import { Readable, Writable } from 'node:stream';
import { expect, it } from 'vitest';
import { createDockerClient, ensureUserVolumes } from './index.ts';
import type { DockerTransport } from './index.ts';

const USER = 'abcdefghijkl';
const HOME = 'dsh-team-home-abcdefghijkl';
const WORK = 'dsh-team-work-abcdefghijkl';

function daemon() {
  const volumes = new Map<string, { Name: string; Labels: unknown; marker: string }>();
  const requests: {
    method: RequestOptions['method'];
    path: RequestOptions['path'];
    body: unknown;
  }[] = [];
  const replies = new Map<string, { status: number; document: unknown }>();
  const transport: DockerTransport = (options, receive) => {
    const chunks: Buffer[] = [];
    return new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(chunk);
        done();
      },
      final(done) {
        // Request JSON crosses the external Docker transport boundary.
        const body: unknown =
          chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString());
        requests.push({ method: options.method, path: options.path, body });
        if (
          options.method !== 'POST' ||
          options.path !== '/volumes/create' ||
          typeof body !== 'object' ||
          body === null ||
          !('Name' in body) ||
          typeof body.Name !== 'string' ||
          !('Labels' in body)
        ) {
          done(new Error('Unexpected Docker volume request'));
          return;
        }
        const reply = replies.get(body.Name);
        let volume = volumes.get(body.Name);
        if (volume === undefined && (reply === undefined || reply.status < 300)) {
          volume = { Name: body.Name, Labels: body.Labels, marker: 'persistent employee data' };
          volumes.set(body.Name, volume);
        }
        const document = reply === undefined ? volume : reply.document;
        const bytes = document === undefined ? [] : [Buffer.from(JSON.stringify(document))];
        queueMicrotask(() => {
          const response: Readable & { statusCode?: number } = Readable.from(bytes);
          response.statusCode = reply?.status ?? 201;
          receive(response);
        });
        done();
      },
    });
  };
  return {
    client: createDockerClient('/owned/docker.sock', transport),
    volumes,
    requests,
    replies,
  };
}

it('rejects an existing home volume owned by another user without touching its data or work volume', async () => {
  const wire = daemon();
  wire.volumes.set(HOME, {
    Name: HOME,
    Labels: { 'dsh-team.user': 'mnopqrstuvwx' },
    marker: 'other employee data',
  });

  await expect(ensureUserVolumes(wire.client, USER)).rejects.toThrow(/ownership/);

  expect(wire.volumes.get(HOME)).toEqual({
    Name: HOME,
    Labels: { 'dsh-team.user': 'mnopqrstuvwx' },
    marker: 'other employee data',
  });
  expect(wire.volumes.has(WORK)).toBe(false);
  expect(wire.requests).toEqual([
    {
      method: 'POST',
      path: '/volumes/create',
      body: { Name: HOME, Labels: { 'dsh-team.user': USER } },
    },
  ]);
});

it('reuses both canonical volumes without losing persisted home and work data', async () => {
  const wire = daemon();
  const expected = { home: HOME, work: WORK };
  expect(await ensureUserVolumes(wire.client, USER)).toEqual(expected);
  wire.volumes.set(HOME, {
    Name: HOME,
    Labels: { 'dsh-team.user': USER },
    marker: 'saved Session',
  });
  wire.volumes.set(WORK, {
    Name: WORK,
    Labels: { 'dsh-team.user': USER },
    marker: 'saved document',
  });

  const repeated = await ensureUserVolumes(wire.client, USER);

  expect(repeated).toEqual(expected);
  expect([...wire.volumes.values()]).toEqual([
    { Name: HOME, Labels: { 'dsh-team.user': USER }, marker: 'saved Session' },
    { Name: WORK, Labels: { 'dsh-team.user': USER }, marker: 'saved document' },
  ]);
  expect(
    wire.requests.every(({ method, path }) => method === 'POST' && path === '/volumes/create'),
  ).toBe(true);
});

it.each([
  ['home without owner', HOME, {}],
  ['work without labels', WORK, null],
  ['work belonging to another user', WORK, { 'dsh-team.user': 'mnopqrstuvwx' }],
] as const)(
  'rejects %s without adopting or deleting persistent data',
  async (_title, name, labels) => {
    const wire = daemon();
    const existing = { Name: name, Labels: labels, marker: 'keep employee data' };
    wire.volumes.set(name, existing);

    await expect(ensureUserVolumes(wire.client, USER)).rejects.toThrow(/ownership/);

    expect(wire.volumes.get(name)).toEqual(existing);
    expect(
      wire.requests.every(({ method, path }) => method === 'POST' && path === '/volumes/create'),
    ).toBe(true);
  },
);

it.each([
  ['empty document', undefined],
  ['null document', null],
  ['non-object document', 'secret-daemon-content'],
  ['array document', []],
  ['missing name', { Labels: { 'dsh-team.user': USER } }],
  ['wrong name', { Name: 'secret-daemon-content', Labels: { 'dsh-team.user': USER } }],
  ['missing labels', { Name: HOME }],
  ['non-object labels', { Name: HOME, Labels: 'secret-daemon-content' }],
  ['array labels', { Name: HOME, Labels: [] }],
  ['non-string owner', { Name: HOME, Labels: { 'dsh-team.user': 123 } }],
])('rejects an invalid daemon response: %s', async (_title, document) => {
  const wire = daemon();
  wire.replies.set(HOME, { status: 201, document });

  const error: unknown = await ensureUserVolumes(wire.client, USER).catch(
    (error: unknown) => error,
  );

  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toMatch(/Invalid Docker volume response|ownership/);
  expect(String(error) + JSON.stringify(error)).not.toContain('secret-daemon-content');
  expect(wire.volumes.has(WORK)).toBe(false);
});

it('preserves the home volume on work creation failure and safely completes a caller retry', async () => {
  const wire = daemon();
  wire.replies.set(WORK, { status: 500, document: { message: 'daemon failure' } });

  await expect(ensureUserVolumes(wire.client, USER)).rejects.toMatchObject({ statusCode: 500 });
  expect(wire.volumes.get(HOME)).toEqual({
    Name: HOME,
    Labels: { 'dsh-team.user': USER },
    marker: 'persistent employee data',
  });
  expect(wire.volumes.has(WORK)).toBe(false);
  expect(wire.requests.map(({ body }) => body)).toEqual([
    { Name: HOME, Labels: { 'dsh-team.user': USER } },
    { Name: WORK, Labels: { 'dsh-team.user': USER } },
  ]);
  wire.volumes.set(HOME, {
    Name: HOME,
    Labels: { 'dsh-team.user': USER },
    marker: 'saved Session',
  });
  wire.replies.delete(WORK);
  const recovered = await ensureUserVolumes(wire.client, USER);

  expect(recovered).toEqual({ home: HOME, work: WORK });
  expect([...wire.volumes.values()]).toEqual([
    { Name: HOME, Labels: { 'dsh-team.user': USER }, marker: 'saved Session' },
    { Name: WORK, Labels: { 'dsh-team.user': USER }, marker: 'persistent employee data' },
  ]);
  expect(
    wire.requests.every(({ method, path }) => method === 'POST' && path === '/volumes/create'),
  ).toBe(true);
});

it('preserves ready home data when the work daemon response is malformed', async () => {
  const wire = daemon();
  wire.replies.set(WORK, {
    status: 201,
    document: { Name: 'unexpected-work-name', Labels: { 'dsh-team.user': USER } },
  });

  await expect(ensureUserVolumes(wire.client, USER)).rejects.toThrow(
    `Invalid Docker volume response for ${WORK}`,
  );

  expect(wire.volumes.get(HOME)).toEqual({
    Name: HOME,
    Labels: { 'dsh-team.user': USER },
    marker: 'persistent employee data',
  });
  expect(
    wire.requests.every(({ method, path }) => method === 'POST' && path === '/volumes/create'),
  ).toBe(true);
});

it.each([
  '',
  'abc',
  'ABCDEFGHIJKL',
  'abcdefghijk_',
  'abcdefghijk/',
  'abcdefghijkl/extra',
  'abcdefghijkl\n',
])('rejects unsafe account ID %j before Docker side effects', async (userId) => {
  const wire = daemon();

  await expect(ensureUserVolumes(wire.client, userId)).rejects.toThrow('Invalid account user ID');

  expect(wire.requests).toEqual([]);
  expect([...wire.volumes.values()]).toEqual([]);
});
