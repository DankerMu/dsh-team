import { expect, it } from 'vitest';
import { runUserImage } from './user-image-fixture.ts';
import type { DockerCommand, DockerCommandResult } from './docker-command.ts';
import {
  assertManagedPolicyRuntime,
  liveCopyReenablesPersonalModels,
  type ManagedPolicyRuntimeExpectation,
} from './managed-policy-oracle.ts';

const EXPECTED: ManagedPolicyRuntimeExpectation = {
  intranetAddress: 'http://127.0.0.1:9/v1',
  defaultModel: 'beta',
  allowedModels: ['alpha', 'beta'],
  alphaContextWindow: 500_000,
  betaContextWindow: 262_144,
  presetIds: ['standard', 'minimal', 'custom-office'],
  descriptions: { 'custom-office': 'brief-zh' },
  retainedTools: {
    standard: ['bash', 'read_file'],
    minimal: ['bash'],
    'custom-office': ['read_file', 'present'],
  },
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
    { id: 'standard', description: '', toolNames: ['bash', 'read_file'] },
    { id: 'minimal', description: '', toolNames: ['bash'] },
    { id: 'custom-office', description: 'brief-zh', toolNames: ['read_file', 'present'] },
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
          { id: 'custom-office', description: 'brief-zh', toolNames: ['bash', 'web_search'] },
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

it('rejects a nonempty inventory that dropped a known retained non-network tool', () => {
  expect(() => {
    assertManagedPolicyRuntime(
      {
        ...COMPLETE,
        presets: [
          { id: 'standard', description: '', toolNames: ['bash', 'read_file'] },
          { id: 'minimal', description: '', toolNames: ['bash'] },
          { id: 'custom-office', description: 'brief-zh', toolNames: ['read_file'] },
        ],
      },
      EXPECTED,
    );
  }).toThrow();
});

it('rejects a live-copy roster that reenables personal-model onboarding', () => {
  expect(
    liveCopyReenablesPersonalModels({
      bootRoster: { ids: ['@deepseek-ai/dsh-client-ui-settings-models'] },
    }),
  ).toBe(true);
  expect(
    liveCopyReenablesPersonalModels({
      bootRoster: { ids: ['@dsh-team/zh-locale'] },
    }),
  ).toBe(false);
});

it('cleans owned helper resources after a registered post-create scenario failure without leaking secrets', async () => {
  const secret = 'sk-managed-policy-secret';
  const ok = (stdout = ''): DockerCommandResult => ({ status: 0, stdout, stderr: '' });
  const owned = new Set<string>(['foreign-image', 'foreign-container', 'foreign-volume']);
  const labels = new Map<string, string>([
    ['foreign-image', 'foreign-owner'],
    ['foreign-container', 'foreign-owner'],
    ['foreign-volume', 'foreign-owner'],
  ]);
  const removed: string[] = [];
  const labelOf = (args: readonly string[]): string =>
    args[args.indexOf('--label') + 1]?.split('=')[1] ?? '';
  const remember = (name: string, label: string): void => {
    owned.add(name);
    labels.set(name, label);
  };
  const create = (args: readonly string[]): DockerCommandResult => {
    if (args[0] === 'build') {
      remember(args[args.indexOf('--tag') + 1] ?? '', labelOf(args));
      return ok();
    }
    if (args[0] === 'volume' && args[1] === 'create') {
      const name = args.at(-1) ?? '';
      remember(name, labelOf(args));
      return ok(name);
    }
    if (args[0] === 'create') {
      remember(args[args.indexOf('--name') + 1] ?? '', labelOf(args));
      return ok();
    }
    return ok();
  };
  const inspect = (args: readonly string[]): DockerCommandResult => {
    if (args[0] === 'image' && args.includes('{{.Id}}')) {
      return ok(`sha256:${'a'.repeat(64)}\n`);
    }
    return ok(`${labels.get(args.at(-1) ?? '') ?? ''}\n`);
  };
  const run = (args: readonly string[]): DockerCommandResult => ok(args[0] === 'wait' ? '0\n' : '');
  const remove = (args: readonly string[]): DockerCommandResult => {
    const name = args.at(-1) ?? '';
    if (name.startsWith('foreign-')) {
      return { status: 1, stdout: secret, stderr: secret };
    }
    removed.push(name);
    owned.delete(name);
    if (removed.length === 1) {
      return { status: 1, stdout: secret, stderr: secret };
    }
    return ok();
  };
  const command: DockerCommand = (args) => {
    if (args[0] === 'version') return ok('29.1.3');
    if (
      args[0] === 'build' ||
      (args[0] === 'volume' && args[1] === 'create') ||
      args[0] === 'create'
    ) {
      return create(args);
    }
    if (args[1] === 'inspect') return inspect(args);
    if (args[0] === 'start' || args[0] === 'wait' || args[0] === 'logs') return run(args);
    if (args[0] === 'rm' || args[1] === 'rm') return remove(args);
    return ok();
  };
  const scenario = (lifecycle: {
    registerContainer: (name: string) => void;
    runId: string;
  }): Promise<string> => {
    lifecycle.registerContainer(`dsh-team-test-${lifecycle.runId}-helper`);
    return Promise.reject(new Error('registered helper failed after create'));
  };
  try {
    await runUserImage('managed-policy', () => undefined, command, scenario);
    throw new Error('must fail after registered helper');
  } catch (error) {
    expect(String(error)).not.toContain(secret);
    expect(String(error)).toMatch(
      /registered helper failed after create|Web Docker operation failed/,
    );
  }
  expect([...owned].some((name) => name.startsWith('foreign-'))).toBe(true);
});
