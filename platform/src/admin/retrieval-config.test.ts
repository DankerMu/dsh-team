import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DatabaseHandle } from '../db/index.ts';
import { jsonRequestHeaders, SOURCE, withApp } from '../../test/auth-fixture.ts';
import {
  administrator,
  putConfig,
  SEEDED_SETTINGS,
  seededWith,
  settingsRows,
} from '../../test/admin-config-fixture.ts';

const PATH = '/_platform/api/admin/retrieval-config';
const DEFAULTS = {
  retrievalTopK: 8,
  retrievalSimilarityThreshold: 0.2,
  retrievalKeywordsWeight: 0.7,
  retrievalRerankId: '',
};
const CONFIG = {
  retrievalTopK: 3,
  retrievalSimilarityThreshold: 0.5,
  retrievalKeywordsWeight: 0.3,
  retrievalRerankId: 'bge-reranker-v2-m3',
};
const DOMAINS =
  'Allowed domains: retrievalTopK: integer 1..100 (returned chunk count); retrievalSimilarityThreshold, retrievalKeywordsWeight: finite numbers 0..1; retrievalRerankId: rerank model ID without surrounding whitespace, or empty for no reranking';
const ENVELOPE = `Invalid retrieval configuration; provide exactly retrievalTopK, retrievalSimilarityThreshold, retrievalKeywordsWeight, retrievalRerankId. ${DOMAINS}`;
const field = (name: string) => `Invalid settings field "${name}". ${DOMAINS}`;
const RERANK = `retrievalRerankId must be empty or a rerank model ID without surrounding whitespace. ${DOMAINS}`;
const INTERNAL_ERROR = {
  statusCode: 500,
  error: 'Internal Server Error',
  message: 'Internal Server Error',
};
const SENTINEL = 'RETRIEVAL_INPUT_SENTINEL';
const stored = (config: typeof CONFIG) =>
  seededWith(
    Object.fromEntries(Object.entries(config).map(([key, value]) => [key, JSON.stringify(value)])),
  );
const audits = (database: DatabaseHandle) =>
  database
    .prepare(
      "SELECT actor_email, target_email, source_address, details FROM audit_events WHERE event_type = 'retrieval-config.updated'",
    )
    .all();
const allAudits = (database: DatabaseHandle) =>
  database.prepare('SELECT * FROM audit_events ORDER BY id').all();
const save = (app: FastifyInstance, cookie: string, payload: unknown) =>
  app.inject({
    method: 'PUT',
    url: PATH,
    remoteAddress: SOURCE,
    headers: jsonRequestHeaders({ cookie }),
    payload: JSON.stringify(payload),
  });
const read = (app: FastifyInstance, cookie: string) =>
  app.inject({ url: PATH, headers: { cookie } });

it('reports the seeded retrieval parameters', async () => {
  await withApp(async (app, database) => {
    const { cookie } = await administrator(app, database);

    const response = await read(app, cookie);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(DEFAULTS);
  });
});

it('replaces only the four retrieval rows with one actor/source audit, then turns reranking off', async () => {
  await withApp(async (app, database) => {
    const { user, cookie } = await administrator(app, database);
    const audit = { actor_email: user.email, target_email: null, source_address: SOURCE };

    const saved = await save(app, cookie, CONFIG);
    const first = await read(app, cookie);

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ ...CONFIG, runningInstances: 0 });
    expect(first.json()).toEqual(CONFIG);
    expect(settingsRows(database)).toEqual(stored(CONFIG));
    expect(audits(database)).toEqual([{ ...audit, details: '{}' }]);

    const off = { ...CONFIG, retrievalRerankId: '' };
    const disabled = await save(app, cookie, off);
    const second = await read(app, cookie);

    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toEqual({ ...off, runningInstances: 0 });
    expect(second.json()).toEqual(off);
    expect(settingsRows(database)).toEqual(stored(off));
    expect(audits(database)).toEqual([
      { ...audit, details: '{}' },
      { ...audit, details: '{}' },
    ]);
  });
});

it.each([
  { ...CONFIG, retrievalTopK: 1, retrievalSimilarityThreshold: 0, retrievalKeywordsWeight: 0 },
  { ...CONFIG, retrievalTopK: 100, retrievalSimilarityThreshold: 1, retrievalKeywordsWeight: 1 },
  { ...CONFIG, retrievalRerankId: 'BAAI/bge-reranker-v2-m3@Builtin' },
  { ...CONFIG, retrievalRerankId: 'my reranker@Builtin' },
])('accepts the boundary configuration %j', async (payload) => {
  await withApp(async (app, database) => {
    const { cookie } = await administrator(app, database);

    const saved = await save(app, cookie, payload);
    const after = await read(app, cookie);

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ ...payload, runningInstances: 0 });
    expect(after.json()).toEqual(payload);
    expect(settingsRows(database)).toEqual(stored(payload));
  });
});

const without = (key: string) =>
  Object.fromEntries(Object.entries(CONFIG).filter(([name]) => name !== key));

const REJECTED: [string, unknown, string][] = [
  // Each label names the single rule that isolates the case.
  ['a null body (envelope rule)', null, ENVELOPE],
  ['an array body (envelope rule)', [SENTINEL], ENVELOPE],
  ['a string body (envelope rule)', SENTINEL, ENVELOPE],
  ...Object.keys(CONFIG).map<[string, unknown, string]>((key) => [
    `a missing ${key} (key-set rule)`,
    without(key),
    ENVELOPE,
  ]),
  ['an extra key (key-set rule)', { ...CONFIG, [SENTINEL]: 1 }, ENVELOPE],
  ...[0, 101, 1.5, '8'].map<[string, unknown, string]>((value) => [
    `retrievalTopK ${JSON.stringify(value)} (settings domain)`,
    { ...CONFIG, retrievalTopK: value },
    field('retrievalTopK'),
  ]),
  ...[-0.1, 1.1, '0.2'].map<[string, unknown, string]>((value) => [
    `retrievalSimilarityThreshold ${JSON.stringify(value)} (settings domain)`,
    { ...CONFIG, retrievalSimilarityThreshold: value },
    field('retrievalSimilarityThreshold'),
  ]),
  ...[-0.1, 1.1, null].map<[string, unknown, string]>((value) => [
    `retrievalKeywordsWeight ${JSON.stringify(value)} (settings domain)`,
    { ...CONFIG, retrievalKeywordsWeight: value },
    field('retrievalKeywordsWeight'),
  ]),
  [
    'a numeric retrievalRerankId (settings domain)',
    { ...CONFIG, retrievalRerankId: 9 },
    field('retrievalRerankId'),
  ],
  [
    'a string retrievalTopK (settings domain)',
    { ...CONFIG, retrievalTopK: SENTINEL },
    field('retrievalTopK'),
  ],
  ['a blank rerank ID (whitespace rule)', { ...CONFIG, retrievalRerankId: ' ' }, RERANK],
  [
    'a leading-space rerank ID (whitespace rule)',
    { ...CONFIG, retrievalRerankId: ` ${SENTINEL}` },
    RERANK,
  ],
  [
    'a trailing-space rerank ID (whitespace rule)',
    { ...CONFIG, retrievalRerankId: `${SENTINEL} ` },
    RERANK,
  ],
];

it.each(REJECTED)(
  'rejects %s with a fixed message and leaves settings and audits unchanged',
  async (_label, payload, message) => {
    await withApp(async (app, database, lines) => {
      const { cookie } = await administrator(app, database);
      const before = allAudits(database);

      const response = await putConfig(app, PATH, cookie, JSON.stringify(payload));

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ statusCode: 400, error: 'Bad Request', message });
      expect((response.body + lines.join('')).includes(SENTINEL)).toBe(false);
      expect(settingsRows(database)).toEqual(SEEDED_SETTINGS);
      expect(allAudits(database)).toEqual(before);
    });
  },
);

it.each(['write', 'corrupt-json', 'corrupt-type'] as const)(
  'returns a safe storage failure and keeps settings and audits for %s',
  async (boundary) => {
    await withApp(async (app, database, lines) => {
      const { cookie } = await administrator(app, database);
      const secret = randomBytes(32).toString('hex');
      if (boundary === 'write') {
        database.exec(
          `CREATE TRIGGER reject_retrieval_save BEFORE INSERT ON settings BEGIN SELECT RAISE(ABORT, '${secret}'); END;`,
        );
      } else {
        database
          .prepare("UPDATE settings SET value = ? WHERE key = 'retrievalTopK'")
          .run(boundary === 'corrupt-json' ? `{${secret}` : '"8"');
      }
      const settings = settingsRows(database);
      const before = allAudits(database);

      const response = await save(app, cookie, CONFIG);
      const after = await read(app, cookie);

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual(INTERNAL_ERROR);
      if (boundary === 'write') {
        expect(settings).toEqual(SEEDED_SETTINGS);
        expect(after.statusCode).toBe(200);
        expect(after.json()).toEqual(DEFAULTS);
      } else {
        expect(after.statusCode).toBe(500);
        expect(after.json()).toEqual(INTERNAL_ERROR);
      }
      expect(settingsRows(database)).toEqual(settings);
      expect(allAudits(database)).toEqual(before);
      for (const value of [secret, 'SQLITE', 'reject_retrieval_save'])
        expect((response.body + after.body + lines.join('')).includes(value)).toBe(false);
    });
  },
);
