import { expect, it } from 'vitest';
import {
  connectionMessage,
  isCompleteModelConfig,
  jsonObject,
  parseModelConfig,
} from './model-config.ts';

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

const HINT = 'OpenAI 兼容地址通常以 /v1 结尾';
it.each([
  [{ result: 'ok', httpStatus: 200, elapsedMs: 123 }, true, '连接成功（用时 123 毫秒）'],
  [{ result: 'unconfigured', httpStatus: null, elapsedMs: 0 }, false, '请先保存完整的模型配置'],
  [{ result: 'unauthorized', httpStatus: 401, elapsedMs: 5 }, false, '密钥无效或无权访问该模型'],
  [{ result: 'not-found', httpStatus: 404, elapsedMs: 5 }, false, `地址或模型不存在。${HINT}。`],
  [{ result: 'rejected', httpStatus: 422, elapsedMs: 5 }, false, '模型服务拒绝了请求（HTTP 422）'],
  [{ result: 'server-error', httpStatus: 502, elapsedMs: 5 }, false, '模型服务出错（HTTP 502）'],
  [
    { result: 'bad-response', httpStatus: 200, elapsedMs: 5 },
    false,
    `地址返回的不是模型接口。${HINT}。`,
  ],
  [{ result: 'timeout', httpStatus: null, elapsedMs: 20000 }, false, '连接超时'],
  [{ result: 'unreachable', httpStatus: null, elapsedMs: 3 }, false, '无法连接到模型地址'],
  [
    { result: 'invalid-address', httpStatus: null, elapsedMs: 0 },
    false,
    '模型地址格式无效，需以 http:// 或 https:// 开头',
  ],
  [{ result: 'invalid-key', httpStatus: null, elapsedMs: 0 }, false, '已保存的密钥包含无效字符'],
])('explains connection test result %j', (body, ok, text) => {
  expect(connectionMessage(body)).toEqual({ ok, text });
});

it.each([
  null,
  [],
  { result: 'ok', httpStatus: 200 },
  { result: 'unknown', httpStatus: null, elapsedMs: 0 },
  { result: 'ok', httpStatus: 200, elapsedMs: -1 },
  { result: 'ok', httpStatus: 200, elapsedMs: 1.5 },
  { result: 'ok', httpStatus: '200', elapsedMs: 1 },
  { result: 'ok', httpStatus: 99, elapsedMs: 1 },
  { result: 'rejected', httpStatus: null, elapsedMs: 1 },
  { result: 'server-error', httpStatus: null, elapsedMs: 1 },
  { result: 'ok', httpStatus: 200, elapsedMs: 1, url: 'http://models.invalid' },
  { result: 'constructor', httpStatus: 500, elapsedMs: 1 },
  { result: 'toString', httpStatus: null, elapsedMs: 1 },
])('rejects malformed connection test body %j', (body) => {
  expect(() => connectionMessage(body)).toThrow();
});
