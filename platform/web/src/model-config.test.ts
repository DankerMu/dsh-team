import { expect, it } from 'vitest';
import { isCompleteModelConfig, jsonObject, parseModelConfig } from './model-config.ts';

const COMPLETE = {
  baseURL: 'http://models.invalid/v1',
  apiKeyConfigured: true,
  models: [{ name: 'alpha', contextWindow: 500000 }, { name: 'beta' }],
  defaultModel: 'beta',
};

it('parses a complete settings body into its canonical shape', () => {
  expect(parseModelConfig(COMPLETE, false)).toEqual({
    baseURL: 'http://models.invalid/v1',
    apiKeyConfigured: true,
    models: [{ name: 'alpha', contextWindow: 500000 }, { name: 'beta' }],
    defaultModel: 'beta',
    runningInstances: null,
  });
});

it('parses a saved body with its running-instance count', () => {
  expect(parseModelConfig({ ...COMPLETE, runningInstances: 3 }, true).runningInstances).toBe(3);
});

it('accepts the absent-settings body', () => {
  expect(
    parseModelConfig({ baseURL: '', apiKeyConfigured: false, models: [], defaultModel: '' }, false),
  ).toEqual({
    baseURL: '',
    apiKeyConfigured: false,
    models: [],
    defaultModel: '',
    runningInstances: null,
  });
});

it.each<[string, unknown, boolean]>([
  ['null', null, false],
  ['an array', [], false],
  ['a string', 'text', false],
  ['an unknown field', { ...COMPLETE, apiKey: 'leaked' }, false],
  ['a running count outside a save', { ...COMPLETE, runningInstances: 0 }, false],
  ['a non-string address', { ...COMPLETE, baseURL: 1 }, false],
  ['a non-boolean key state', { ...COMPLETE, apiKeyConfigured: 'yes' }, false],
  ['a non-string default', { ...COMPLETE, defaultModel: null }, false],
  ['a non-array model list', { ...COMPLETE, models: {} }, false],
  ['a non-object model', { ...COMPLETE, models: ['alpha'] }, false],
  ['a blank model name', { ...COMPLETE, models: [{ name: ' ' }], defaultModel: '' }, false],
  ['an unknown model field', { ...COMPLETE, models: [{ name: 'beta', size: 1 }] }, false],
  ['a zero context window', { ...COMPLETE, models: [{ name: 'beta', contextWindow: 0 }] }, false],
  [
    'a fractional context window',
    { ...COMPLETE, models: [{ name: 'beta', contextWindow: 1.5 }] },
    false,
  ],
  ['an unlisted default', { ...COMPLETE, defaultModel: 'gamma' }, false],
  ['a missing save count', COMPLETE, true],
  ['a negative save count', { ...COMPLETE, runningInstances: -1 }, true],
  ['a blank saved address', { ...COMPLETE, baseURL: ' ', runningInstances: 0 }, true],
  ['a blank saved default', { ...COMPLETE, defaultModel: '', runningInstances: 0 }, true],
])('rejects %s', (_name, body, saved) => {
  expect(() => parseModelConfig(body, saved)).toThrow(Error);
});

it.each<[string, Record<string, unknown>, boolean]>([
  ['complete settings', COMPLETE, true],
  ['a blank address', { ...COMPLETE, baseURL: ' \t' }, false],
  ['no configured key', { ...COMPLETE, apiKeyConfigured: false }, false],
  ['an empty model list', { ...COMPLETE, models: [], defaultModel: '' }, false],
  ['no default model', { ...COMPLETE, defaultModel: '' }, false],
])('judges %s complete: %s', (_name, body, complete) => {
  expect(isCompleteModelConfig(parseModelConfig(body, false))).toBe(complete);
});

it('narrows only JSON objects', () => {
  expect(jsonObject({ a: 1 })).toEqual({ a: 1 });
  expect(() => jsonObject([])).toThrow('Invalid configuration response');
  expect(() => jsonObject(null)).toThrow('Invalid configuration response');
});
