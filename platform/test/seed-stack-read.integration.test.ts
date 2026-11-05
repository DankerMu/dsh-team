import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { SEED_DATASETS, readSeedDatasetIds, readSeedDatasets } from '../../scripts/seed-stack.mjs';

interface FakeSet {
  id: string;
  name: string;
  docs: { id: string; name: string; status: string }[];
}

const key = randomUUID();
const RUNNING_FILE = 'weekly-minutes-02.txt';
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

// rc2 list shapes: datasets as `data[]`, documents as `data.docs[]` with `ingestion_status`.
async function serve(sets: FakeSet[]) {
  const log: string[] = [];
  const server = createServer((request, response) => {
    log.push(`${String(request.method)} ${String(request.headers.authorization)}`);
    const path = new URL(request.url ?? '/', 'http://fake').pathname;
    const set = sets.find(({ id }) => path === `/api/v1/datasets/${id}/documents`);
    const data =
      path === '/api/v1/datasets'
        ? sets.map(({ id, name }) => ({ id, name }))
        : {
            docs: set?.docs.map(({ id, name, status }) => ({ id, name, ingestion_status: status })),
          };
    response.end(JSON.stringify({ code: 0, data }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  return { log, url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` };
}

const seeded = () =>
  SEED_DATASETS.map(({ name, files }) => ({
    id: randomUUID(),
    name,
    docs: files.map((file) => ({
      id: randomUUID(),
      name: file,
      status: file === RUNNING_FILE ? 'RUNNING' : 'COMPLETED',
    })),
  }));

/** Read-only snapshot: only GETs; a failure line names datasets/files, never ids, URL or key. */
async function readSnapshot(sets: FakeSet[]) {
  const { log, url } = await serve(sets);
  const snapshot: unknown = await readSeedDatasets({ ragflowUrl: url, ragflowApiKey: key }).catch(
    (error: unknown) => (error instanceof Error ? error.message : error),
  );
  const ids = sets.flatMap((set) => [set.id, ...set.docs.map(({ id }) => id)]);
  for (const secret of [url, key, ...ids]) expect(JSON.stringify(snapshot)).not.toContain(secret);
  expect(new Set(log)).toEqual(new Set([`GET Bearer ${key}`]));
  return { snapshot, requests: log.length };
}

it('reads the seeded datasets in seed order with only GET requests', async () => {
  const unrelated = { id: randomUUID(), name: 'unrelated', docs: [] };
  const { snapshot, requests } = await readSnapshot([...seeded().reverse(), unrelated]);

  expect(snapshot).toEqual(
    SEED_DATASETS.map(({ name, files }) => ({
      name,
      files: files.map((file) => ({
        name: file,
        status: file === RUNNING_FILE ? 'RUNNING' : 'COMPLETED',
      })),
    })),
  );
  // One dataset listing and one document listing per seed dataset.
  expect(requests).toBe(4);
});

const changed = (change: (sets: FakeSet[]) => unknown) => () => {
  const sets = seeded();
  change(sets);
  return sets;
};
const [POLICIES, PRODUCTS, MINUTES] = SEED_DATASETS.map(({ name }) => name);
const inexact = (name: string | undefined) =>
  `dataset ${String(name)} does not hold exactly its seed files`;

it.each<[string, () => FakeSet[], string]>([
  ['a missing dataset', () => seeded().slice(0, 2), `dataset ${String(MINUTES)} is missing`],
  ['a missing file', changed((sets) => sets[0]?.docs.pop()), inexact(POLICIES)],
  [
    'an extra file',
    changed((sets) => sets[1]?.docs.push({ id: randomUUID(), name: 'x.txt', status: 'COMPLETED' })),
    inexact(PRODUCTS),
  ],
])('refuses %s with a fixed name-only line', async (_case, sets, text) => {
  expect((await readSnapshot(sets())).snapshot).toBe(`seed:stack failed: ${text}`);
});

it('reads the seed dataset IDs in seed order with one GET', async () => {
  const sets = seeded();
  const { log, url } = await serve([...sets].reverse());

  expect(await readSeedDatasetIds({ ragflowUrl: url, ragflowApiKey: key })).toEqual(
    sets.map(({ id, name }) => ({ name, id })),
  );
  expect(log).toEqual([`GET Bearer ${key}`]);
});

it('refuses a missing seed dataset ID with a fixed name-only line', async () => {
  const { url } = await serve(seeded().slice(1));
  const failure = await readSeedDatasetIds({ ragflowUrl: url, ragflowApiKey: key }).catch(
    (error: unknown) => (error instanceof Error ? error.message : error),
  );

  expect(failure).toBe(`seed:stack failed: dataset ${String(POLICIES)} is missing`);
});
