import { expect, it } from 'vitest';
import {
  assertManagedPolicyRuntime,
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
