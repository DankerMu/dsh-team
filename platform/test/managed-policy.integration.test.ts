import { inspect } from 'node:util';
import { expect, it } from 'vitest';
import { runUserImage } from './user-image-fixture.ts';
import type { DockerCommand, DockerCommandResult } from './docker-command.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';
import { execScript } from './managed-policy-fixture.ts';
import {
  assertManagedPolicyRuntime,
  controlExposesEmployeePolicy,
  parseManagedPolicyRuntime,
  type ManagedPolicyRuntimeExpectation,
} from './managed-policy-oracle.ts';
import {
  assertRosterObservation,
  COMPOSITION_PLUGIN,
} from '../../scripts/probe-first-run-composition.mjs';

const EXPECTED: ManagedPolicyRuntimeExpectation = {
  intranetAddress: 'http://127.0.0.1:9/v1',
  defaultModel: 'beta',
  allowedModels: ['alpha', 'beta'],
  alphaContextWindow: 500_000,
  betaContextWindow: 262_144,
  presetIds: ['standard', 'minimal', 'custom-office'],
  descriptions: { 'custom-office': 'brief-zh' },
  retainedTools: {
    standard: ['bash', 'read'],
    minimal: ['bash'],
    'custom-office': ['read', 'present'],
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
    { id: 'standard', description: '', toolNames: ['bash', 'read'] },
    { id: 'minimal', description: '', toolNames: ['bash'] },
    { id: 'custom-office', description: 'brief-zh', toolNames: ['read', 'present'] },
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

it('rejects a nonempty inventory that dropped a known retained non-network tool', () => {
  expect(() => {
    assertManagedPolicyRuntime(
      {
        ...COMPLETE,
        presets: [
          { id: 'standard', description: '', toolNames: ['bash', 'read'] },
          { id: 'minimal', description: '', toolNames: ['bash'] },
          { id: 'custom-office', description: 'brief-zh', toolNames: ['read'] },
        ],
      },
      EXPECTED,
    );
  }).toThrow();
});

it('rejects a no-managed control that only exposes network tools on shipped presets', () => {
  const observation = parseManagedPolicyRuntime({
    models: {
      intranetAddress: 'http://127.0.0.1:8/v1',
      defaultModel: 'alpha',
      allowedModels: ['alpha', 'beta'],
      alphaContextWindow: 500_000,
      betaContextWindow: 262_144,
    },
    presets: [
      { id: 'standard', description: '', toolNames: ['bash', 'web_search', 'web_fetch'] },
      { id: 'custom-office', description: 'brief-zh', toolNames: ['read', 'present'] },
    ],
  });
  expect(controlExposesEmployeePolicy(observation, 'http://127.0.0.1:8/v1', 'alpha')).toBe(false);
});

it('rejects a live-copy roster that reenables personal-model onboarding', () => {
  const expected = [
    COMPOSITION_PLUGIN,
    '@deepseek-ai/dsh-client-ui-model-selection',
    '@deepseek-ai/dsh-client-ui-settings-general',
  ];
  expect(() => {
    assertRosterObservation(
      { ids: ['@deepseek-ai/dsh-client-ui-settings-models', ...expected].sort() },
      expected.sort(),
    );
  }).toThrow(/roster-mismatch/);
  expect(assertRosterObservation({ ids: [...expected].sort() }, [...expected].sort())).toEqual({
    ids: [...expected].sort(),
  });
});

it('cleans acquired helper resources after a post-create scenario failure without leaking secrets', async () => {
  const secret = 'sk-managed-policy-secret';
  const ok = (stdout = ''): DockerCommandResult => ({ status: 0, stdout, stderr: '' });
  const resources = {
    image: new Map([['foreign-image', 'foreign-owner']]),
    container: new Map([['foreign-container', 'foreign-owner']]),
    volume: new Map([['foreign-volume', 'foreign-owner']]),
  };
  const created: string[] = [];
  const failedRemovals: string[] = [];
  const labelOf = (args: readonly string[]): string =>
    args[args.indexOf('--label') + 1]?.split('=')[1] ?? '';
  const remember = (kind: 'image' | 'container' | 'volume', name: string, label: string): void => {
    resources[kind].set(name, label);
  };
  const create = (args: readonly string[]): DockerCommandResult => {
    if (args[0] === 'build') {
      remember('image', args[args.indexOf('--tag') + 1] ?? '', labelOf(args));
      return ok();
    }
    if (args[0] === 'volume' && args[1] === 'create') {
      const name = args.at(-1) ?? '';
      remember('volume', name, labelOf(args));
      return ok(name);
    }
    if (args[0] === 'create') {
      const name = args[args.indexOf('--name') + 1] ?? '';
      remember('container', name, labelOf(args));
      created.push(name);
      return ok();
    }
    return ok();
  };
  const inspectResource = (args: readonly string[]): DockerCommandResult => {
    const kind = args[0] as 'image' | 'container' | 'volume';
    const name = args.at(-1) ?? '';
    if (!resources[kind].has(name)) {
      return { status: 1, stdout: '', stderr: `Error: No such ${kind}: ${name}` };
    }
    if (args[0] === 'image' && args.includes('{{.Id}}')) {
      return ok(`sha256:${'a'.repeat(64)}\n`);
    }
    if (args.includes('{{json .}}') || args.includes('{{json .Mounts}}')) {
      const volumeName =
        [...resources.volume.keys()].find((candidate) => candidate.endsWith('-state')) ?? '';
      if (args.includes('{{json .Mounts}}')) {
        return ok(
          JSON.stringify([
            { Type: 'volume', Name: volumeName, Destination: '/data/home', RW: true },
          ]),
        );
      }
      return ok(JSON.stringify({ Image: `sha256:${'a'.repeat(64)}` }));
    }
    return ok(`${resources[kind].get(name) ?? ''}\n`);
  };
  const run = (args: readonly string[]): DockerCommandResult => ok(args[0] === 'wait' ? '0\n' : '');
  const remove = (args: readonly string[]): DockerCommandResult => {
    const kind = (args[0] === 'rm' ? 'container' : args[0]) as 'image' | 'container' | 'volume';
    const name = args.at(-1) ?? '';
    if (name.startsWith('foreign-')) {
      return { status: 1, stdout: secret, stderr: secret };
    }
    if (failedRemovals.length === 0) {
      failedRemovals.push(name);
      return { status: 1, stdout: secret, stderr: secret };
    }
    resources[kind].delete(name);
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
    if (args[1] === 'inspect') return inspectResource(args);
    if (args[0] === 'start' || args[0] === 'wait' || args[0] === 'logs') return run(args);
    if (args[0] === 'rm' || args[1] === 'rm') return remove(args);
    return ok();
  };
  const scenario = (lifecycle: UserImageLifecycle): Promise<string> => {
    execScript(lifecycle, `dsh-team-test-${lifecycle.runId}-helper`, 'process.stdout.write("ok")');
    return Promise.reject(new Error('acquired helper failed after create'));
  };
  try {
    await runUserImage('managed-policy', () => undefined, command, scenario);
    throw new Error('must fail after acquired helper');
  } catch (error) {
    expect(inspect(error)).not.toContain(secret);
    expect(inspect(error)).toMatch(
      /acquired helper failed after create|Web Docker operation failed/,
    );
  }
  expect(created.some((name) => name.endsWith('-helper'))).toBe(true);
  expect(failedRemovals).toEqual(created.filter((name) => name.endsWith('-helper')));
  expect([...resources.container.keys()]).toEqual(
    expect.arrayContaining(['foreign-container', ...failedRemovals]),
  );
  expect([...resources.image.keys()]).toEqual(['foreign-image']);
  expect([...resources.volume.keys()]).toEqual(['foreign-volume']);
  expect([...resources.image.keys()].some((name) => name.startsWith('dsh-team-test-'))).toBe(false);
});
