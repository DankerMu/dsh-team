import { expect, it } from 'vitest';
import type { Settings } from '../db/index.ts';
import { hasCompleteModelSnapshot, modelSnapshot } from './index.ts';

const SETTINGS: Settings = {
  idleMinutes: 30,
  cpuCores: 2,
  memoryMiB: 4096,
  maxRunningInstances: 60,
  defaultPermissionTier: 'yolo',
  models: [{ name: 'alpha', contextWindow: 500000 }, { name: 'beta' }],
  modelBaseUrl: ' http://models.invalid/v1/ ',
  modelApiKey: 'owned-nonsecret-key',
  defaultModel: 'beta',
};

it('maps stored settings to the managed model reference and the separate injected key', () => {
  expect(modelSnapshot(SETTINGS)).toEqual({
    modelSettings: {
      baseURL: ' http://models.invalid/v1/ ',
      apiKeyEnv: 'DSH_TEAM_MODEL_API_KEY',
      models: [{ name: 'alpha', contextWindow: 500000 }, { name: 'beta' }],
      defaultModel: 'beta',
    },
    modelKey: 'owned-nonsecret-key',
  });
});

it('treats a complete stored model configuration as complete', () => {
  expect(hasCompleteModelSnapshot(modelSnapshot(SETTINGS))).toBe(true);
});

it.each<[string, Partial<Settings>]>([
  ['empty key', { modelApiKey: '' }],
  ['blank key', { modelApiKey: ' \t' }],
  ['blank address', { modelBaseUrl: ' ' }],
  ['empty model list', { models: [], defaultModel: '' }],
  ['blank default', { defaultModel: '' }],
])('treats a stored configuration with %s as incomplete', (_label, patch) => {
  expect(hasCompleteModelSnapshot(modelSnapshot({ ...SETTINGS, ...patch }))).toBe(false);
});
