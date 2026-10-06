import { expect, it } from 'vitest';
import {
  assertManagedPolicyRuntime,
  type ManagedPolicyRuntimeExpectation,
} from './managed-policy-oracle.ts';

const EXPECTED: Omit<ManagedPolicyRuntimeExpectation, 'presetIds'> = {
  intranetAddress: 'http://127.0.0.1:9/v1',
  defaultModel: 'beta',
  allowedModels: ['alpha', 'beta'],
  alphaContextWindow: 500_000,
  betaContextWindow: 262_144,
};

it('rejects a live runtime observation that omits the required custom grouped preset', () => {
  const observation = {
    models: {
      intranetAddress: EXPECTED.intranetAddress,
      defaultModel: EXPECTED.defaultModel,
      allowedModels: EXPECTED.allowedModels,
      alphaContextWindow: EXPECTED.alphaContextWindow,
      betaContextWindow: EXPECTED.betaContextWindow,
    },
    presets: [
      { id: 'standard', greeting: '', toolNames: ['bash', 'read_file'] },
      { id: 'minimal', greeting: '', toolNames: ['bash'] },
    ],
  };

  expect(() => {
    assertManagedPolicyRuntime(observation, {
      ...EXPECTED,
      presetIds: ['standard', 'minimal', 'custom-office'],
    });
  }).toThrow();
});
