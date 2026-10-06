import { expect, it } from 'vitest';
import { runUserImage } from './user-image-fixture.ts';
import type { DockerCommand, DockerCommandResult } from './docker-command.ts';
import {
  assertManagedPolicyRuntime,
  type ManagedPolicyRuntimeExpectation,
} from './managed-policy-oracle.ts';

const EXPECTED: ManagedPolicyRuntimeExpectation = {
  intranetAddress: 'http://127.0.0.1:9/v1',
  defaultModel: 'beta',
  allowedModels: ['alpha', 'beta'],
  alphaContextWindow: 500_000,
  betaContextWindow: 262_144,
  presetIds: ['standard', 'minimal', 'custom-office'],
};

const COMPLETE = {
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
    { id: 'custom-office', greeting: 'brief-zh', toolNames: ['bash', 'read_file'] },
  ],
};

it('rejects an incorrect context window even when the custom preset is present', () => {
  expect(() => {
    assertManagedPolicyRuntime(
      {
        ...COMPLETE,
        models: { ...COMPLETE.models, alphaContextWindow: 128_000 },
      },
      EXPECTED,
    );
  }).toThrow();
});

it('rejects network tools in a live preset inventory', () => {
  expect(() => {
    assertManagedPolicyRuntime(
      {
        ...COMPLETE,
        presets: [
          ...COMPLETE.presets.slice(0, 2),
          { id: 'custom-office', greeting: 'brief-zh', toolNames: ['bash', 'web_search'] },
        ],
      },
      EXPECTED,
    );
  }).toThrow();
});

it('accepts a complete independent roster with released beta fallback context', () => {
  expect(() => {
    assertManagedPolicyRuntime(COMPLETE, EXPECTED);
  }).not.toThrow();
});

it('does not leak credential-bearing Docker diagnostics from managed-policy cleanup', async () => {
  const secret = 'sk-managed-policy-secret';
  const ok = (stdout = ''): DockerCommandResult => ({ status: 0, stdout, stderr: '' });
  const command: DockerCommand = (args) => {
    if (args[0] === 'version') return ok('29.1.3');
    return { status: 1, stdout: secret, stderr: secret };
  };
  const unused = (): Promise<string> => Promise.reject(new Error('scenario unused'));
  await expect(runUserImage('managed-policy', () => undefined, command, unused)).rejects.toThrow(
    /Web Docker operation failed/,
  );
  try {
    await runUserImage('managed-policy', () => undefined, command, unused);
  } catch (error) {
    expect(String(error)).not.toContain(secret);
  }
});
