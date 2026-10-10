import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { readSettings } from '../db/index.ts';
import { jsonRequestHeaders, SOURCE, withApp } from '../../test/auth-fixture.ts';
import {
  administrator,
  MODEL_CONFIG as CONFIG,
  putConfig,
} from '../../test/admin-config-fixture.ts';

const PATH = '/_platform/api/admin/model-config';

it('saves a safe projection and an actor/source audit without reading audits', async () => {
  await withApp(async (app, database) => {
    const { user, cookie } = await administrator(app, database);
    const apiKey = randomBytes(32).toString('hex');

    const saved = await app.inject({
      method: 'PUT',
      url: PATH,
      remoteAddress: SOURCE,
      headers: jsonRequestHeaders({ cookie }),
      payload: { ...CONFIG, apiKey },
    });
    const read = await app.inject({ url: PATH, headers: { cookie } });

    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ ...CONFIG, apiKeyConfigured: true });
    expect(read.json()).toEqual(saved.json());
    expect(readSettings(database).modelApiKey === apiKey).toBe(true);
    expect(
      database
        .prepare(
          "SELECT actor_email, source_address, details FROM audit_events WHERE event_type = 'model-config.updated'",
        )
        .all(),
    ).toEqual([{ actor_email: user.email, source_address: SOURCE, details: '{}' }]);
  });
});

it.each([
  ['missing fields', {}],
  ['array', []],
  ['null', null],
  ['numeric address', { ...CONFIG, baseURL: 9 }],
  ['blank address', { ...CONFIG, baseURL: ' \t' }],
  ['numeric default', { ...CONFIG, defaultModel: 9 }],
  ['blank default', { ...CONFIG, defaultModel: '' }],
  ['absent default', { ...CONFIG, defaultModel: 'missing' }],
  ['case mismatch', { ...CONFIG, defaultModel: 'Beta' }],
  ['empty key', { ...CONFIG, apiKey: '' }],
  ['blank key', { ...CONFIG, apiKey: ' \t' }],
  ['numeric key', { ...CONFIG, apiKey: 9 }],
  ['null key', { ...CONFIG, apiKey: null }],
  ['unknown field', { ...CONFIG, modelApiKey: 'not-accepted' }],
  ['invalid models', { ...CONFIG, models: {} }],
  ['blank name', { ...CONFIG, models: [{ name: ' ' }] }],
  ['numeric name', { ...CONFIG, models: [{ name: 9 }] }],
  ['string context', { ...CONFIG, models: [{ name: 'beta', contextWindow: '500000' }] }],
  ['zero context', { ...CONFIG, models: [{ name: 'beta', contextWindow: 0 }] }],
  ['unsafe context', { ...CONFIG, models: [{ name: 'beta', contextWindow: 2 ** 53 }] }],
])('rejects %s before changing settings or auditing', async (_label, payload) => {
  await withApp(async (app, database) => {
    const { cookie } = await administrator(app, database);
    const before = database.prepare('SELECT * FROM audit_events').all();

    const response = await putConfig(app, PATH, cookie, JSON.stringify(payload));

    expect(response.statusCode).toBe(400);
    expect(database.prepare('SELECT * FROM settings').all()).toEqual([]);
    expect(database.prepare('SELECT * FROM audit_events').all()).toEqual(before);
  });
});
