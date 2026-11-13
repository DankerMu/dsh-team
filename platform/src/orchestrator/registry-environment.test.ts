import { rm } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { START_MODEL, startupOwnerFixture } from '../../test/container-start-fixture.ts';
import { isRegistryEnvironmentName, registryEnvironment } from './registry-environment.ts';

it('points the instance npm/pnpm default registry at the first managed registry and silences update checks', () => {
  expect(
    registryEnvironment(['https://npm.intranet.example/', 'https://registry.npmmirror.com/']),
  ).toStrictEqual({
    npm_config_registry: 'https://npm.intranet.example/',
    npm_config_update_notifier: 'false',
  });
});

it('refuses an empty registry list instead of leaving the public default in place', () => {
  expect(() => registryEnvironment([])).toThrow('Instance registry list must be nonempty');
});

it.each([
  ['npm_config_registry', true],
  ['NPM_CONFIG_REGISTRY', true],
  ['Npm_Config_Update_Notifier', true],
  ['DMXAPI_KEY', false],
  ['MY_npm_config_KEY', false],
])('reserves the case-insensitive npm_config_ prefix: %s → %s', (name, reserved) => {
  expect(isRegistryEnvironmentName(name)).toBe(reserved);
});

it('rejects a model-key environment name in the npm_config_ space before Docker side effects', async () => {
  const { root, database, daemon, owner, input } = await startupOwnerFixture();
  try {
    const modelSettings = { ...START_MODEL, apiKeyEnv: 'Npm_Config_Registry' };

    await expect(owner.startUserContainer({ ...input, modelSettings })).rejects.toThrow(
      /model environment validation/,
    );

    expect(daemon.requests).toEqual([]);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
