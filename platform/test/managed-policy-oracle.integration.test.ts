import { expect, it } from 'vitest';
import {
  assertManagedPolicyRuntime,
  controlEmployeePolicyFailure,
  controlExposesEmployeePolicy,
  type ManagedPolicyRuntimeObservation,
  type ManagedPolicyRuntimeExpectation,
} from './managed-policy-oracle.ts';

const EXPECTED: Omit<ManagedPolicyRuntimeExpectation, 'presetIds'> = {
  intranetAddress: 'http://127.0.0.1:9/v1',
  defaultModel: 'beta',
  catalog: [{ id: 'intranet', models: ['alpha', 'beta'] }],
  alphaContextWindow: 500_000,
  betaContextWindow: 262_144,
};

it('rejects a live runtime observation that omits the required custom grouped preset', () => {
  const observation = {
    models: {
      intranetAddress: EXPECTED.intranetAddress,
      defaultModel: EXPECTED.defaultModel,
      catalog: EXPECTED.catalog,
      alphaContextWindow: EXPECTED.alphaContextWindow,
      betaContextWindow: EXPECTED.betaContextWindow,
    },
    presets: [
      { id: 'standard', description: '', toolNames: ['bash', 'read'] },
      { id: 'minimal', description: '', toolNames: ['bash'] },
    ],
  };

  expect(() => {
    assertManagedPolicyRuntime(observation, {
      ...EXPECTED,
      presetIds: ['standard', 'minimal', 'custom-office'],
    });
  }).toThrow();
});

it.each([
  {
    label: 'an extra registered provider that advertises no models',
    catalog: [
      { id: 'intranet', models: ['alpha', 'beta'] },
      { id: 'deepseek-account', models: [] },
    ],
  },
  {
    label: 'a same-size catalog that substitutes another provider for intranet',
    catalog: [{ id: 'personal', models: ['alpha', 'beta'] }],
  },
  {
    label: 'an extra model on the sole intranet provider',
    catalog: [{ id: 'intranet', models: ['alpha', 'beta', 'gamma'] }],
  },
] as const)('rejects $label', ({ catalog }) => {
  const observation = {
    models: {
      intranetAddress: EXPECTED.intranetAddress,
      defaultModel: EXPECTED.defaultModel,
      catalog,
      alphaContextWindow: EXPECTED.alphaContextWindow,
      betaContextWindow: EXPECTED.betaContextWindow,
    },
    presets: [
      { id: 'standard', description: '', toolNames: ['bash', 'read'] },
      { id: 'minimal', description: '', toolNames: ['bash'] },
      { id: 'custom-office', description: 'brief-zh', toolNames: ['read', 'present'] },
    ],
  };

  expect(() => {
    assertManagedPolicyRuntime(observation, {
      ...EXPECTED,
      presetIds: ['standard', 'minimal', 'custom-office'],
    });
  }).toThrow();
});

const QUALIFIED_CONTROL: ManagedPolicyRuntimeObservation = {
  models: {
    intranetAddress: 'http://127.0.0.1:8/v1',
    defaultModel: 'alpha',
    catalog: [
      { id: 'intranet', models: ['alpha', 'beta'] },
      { id: 'personal', models: ['gamma'] },
      { id: 'deepseek-official', models: [] },
      { id: 'deepseek-account', models: [] },
    ],
    alphaContextWindow: 500_000,
    betaContextWindow: 262_144,
  },
  presets: [
    {
      id: 'custom-office',
      description: 'brief-zh',
      toolNames: ['read', 'present', 'web_search', 'web_fetch'],
    },
  ],
};

it.each([
  ['intranet-address', { intranetAddress: 'http://127.0.0.1:9/v1' }],
  ['default-model', { defaultModel: 'beta' }],
  ['intranet-models', { catalog: QUALIFIED_CONTROL.models.catalog.slice(1) }],
  [
    'intranet-models',
    {
      catalog: [
        { id: 'intranet', models: ['alpha'] },
        ...QUALIFIED_CONTROL.models.catalog.slice(1),
      ],
    },
  ],
  [
    'personal-model',
    { catalog: QUALIFIED_CONTROL.models.catalog.filter((row) => row.id !== 'personal') },
  ],
  [
    'official-provider',
    { catalog: QUALIFIED_CONTROL.models.catalog.filter((row) => row.id !== 'deepseek-official') },
  ],
  [
    'account-provider',
    { catalog: QUALIFIED_CONTROL.models.catalog.filter((row) => row.id !== 'deepseek-account') },
  ],
] as const)('identifies the failed employee control %s condition', (failure, models) => {
  const observation = {
    ...QUALIFIED_CONTROL,
    models: { ...QUALIFIED_CONTROL.models, ...models },
  };
  expect(controlEmployeePolicyFailure(observation, 'http://127.0.0.1:8/v1', 'alpha')).toBe(failure);
  expect(controlExposesEmployeePolicy(observation, 'http://127.0.0.1:8/v1', 'alpha')).toBe(false);
});

it.each([
  ['custom-preset', []],
  ['custom-web-search', [{ id: 'custom-office', description: '', toolNames: ['web_fetch'] }]],
  ['custom-web-fetch', [{ id: 'custom-office', description: '', toolNames: ['web_search'] }]],
] as const)('identifies the failed employee control %s preset condition', (failure, presets) => {
  const observation = { ...QUALIFIED_CONTROL, presets };
  expect(controlEmployeePolicyFailure(observation, 'http://127.0.0.1:8/v1', 'alpha')).toBe(failure);
  expect(controlExposesEmployeePolicy(observation, 'http://127.0.0.1:8/v1', 'alpha')).toBe(false);
});

it('qualifies employee control only when every provider and custom web tool is exposed', () => {
  expect(
    controlEmployeePolicyFailure(QUALIFIED_CONTROL, 'http://127.0.0.1:8/v1', 'alpha'),
  ).toBeUndefined();
  expect(controlExposesEmployeePolicy(QUALIFIED_CONTROL, 'http://127.0.0.1:8/v1', 'alpha')).toBe(
    true,
  );
});

it('reports only the first static control failure rather than employee-supplied values', () => {
  const observation = {
    ...QUALIFIED_CONTROL,
    models: {
      ...QUALIFIED_CONTROL.models,
      intranetAddress: 'https://employee:secret@invalid.example',
      defaultModel: 'employee-secret',
      catalog: [],
    },
    presets: [],
  };
  expect(controlEmployeePolicyFailure(observation, 'http://127.0.0.1:8/v1', 'alpha')).toBe(
    'intranet-address',
  );
});
