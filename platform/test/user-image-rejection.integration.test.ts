import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildUserImageExpectingFailure } from './user-image-fixture.ts';
import type { DockerCommand, DockerCommandResult } from './docker-command.ts';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const rejection = 'DSH plugin compatibility failed: platform-nav engines.dsh=">=0.3.0"';
const sentinel = 'dsh-team-test-sentinel:kept';

/** Substitute daemon boundary: records each build's contexts and the range visible at build time. */
function daemon(outcome: DockerCommandResult, tagBuild: boolean) {
  const images = new Map<string, string>([[sentinel, 'sentinel-owner']]);
  const builds: { contexts: string[]; range: unknown }[] = [];
  const ok = (stdout = ''): DockerCommandResult => ({ status: 0, stdout, stderr: '' });
  function build(args: readonly string[]): DockerCommandResult {
    const contexts = args.flatMap((arg, index) =>
      args[index - 1] === '--build-context' ? [arg] : [],
    );
    const directory = contexts.find((context) => context.startsWith('platform-nav='))?.slice(13);
    const manifest = JSON.parse(readFileSync(join(directory ?? '', 'package.json'), 'utf8')) as {
      engines?: { dsh?: unknown };
    };
    builds.push({ contexts, range: manifest.engines?.dsh });
    const label = args[args.indexOf('--label') + 1]?.split('=')[1] ?? '';
    if (tagBuild) images.set(args[args.indexOf('--tag') + 1] ?? '', label);
    return outcome;
  }
  const command: DockerCommand = (args) => {
    const [operation, subcommand] = args;
    const name = args.at(-1) ?? '';
    if (operation === 'version') return ok('28.0.0\n');
    if (operation === 'build') return build(args);
    if (operation === 'image' && subcommand === 'inspect') {
      const owner = images.get(name);
      if (owner === undefined)
        return {
          status: 1,
          stdout: '',
          stderr: `Error response from daemon: No such image: ${name}\n`,
        };
      return ok(`${owner}\n`);
    }
    if (operation === 'image' && subcommand === 'rm') {
      images.delete(name);
      return ok();
    }
    throw new Error(`Unexpected Docker boundary call: ${args.join(' ')}`);
  };
  return { images, builds, command };
}

const repositoryPlugin = (name: string) => `${name}=${join(repositoryRoot, 'plugins', name)}`;

describe('incompatible plugin user-image build rejection', () => {
  it.each([true, false])(
    'builds once with an owned platform-nav copy and leaves no owned tag (tagged=%s)',
    (tagged) => {
      const fake = daemon(
        { status: 1, stdout: '', stderr: `#14 ERROR ${rejection} installed=0.2.1-rc.2\n` },
        tagged,
      );

      const result = buildUserImageExpectingFailure('platform-nav', '>=0.3.0', fake.command);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(rejection);
      expect(fake.builds).toHaveLength(1);
      expect(fake.builds[0]?.range).toBe('>=0.3.0');
      const [zhLocale, permissionTiers, officeAgents, platformNav] = fake.builds[0]?.contexts ?? [];
      expect([zhLocale, permissionTiers, officeAgents]).toEqual([
        repositoryPlugin('zh-locale'),
        repositoryPlugin('permission-tiers'),
        repositoryPlugin('office-agents'),
      ]);
      expect(platformNav).not.toBe(repositoryPlugin('platform-nav'));
      expect(existsSync(platformNav?.slice(13) ?? '')).toBe(false);
      expect(
        JSON.parse(readFileSync(join(repositoryRoot, 'plugins/platform-nav/package.json'), 'utf8')),
      ).toMatchObject({ engines: { dsh: '>=0.2.1-rc.2 <0.3.0' } });
      expect([...fake.images]).toEqual([[sentinel, 'sentinel-owner']]);
    },
  );

  it.each([
    ['a successful build', { status: 0, stdout: '', stderr: '' }, 'must exit 1, got 0'],
    [
      'a failure that does not name the plugin',
      { status: 1, stdout: '', stderr: 'ERROR: failed to fetch base image\n' },
      'does not name platform-nav',
    ],
  ] as const)('rejects %s and still removes the owned tag', (_name, outcome, message) => {
    const fake = daemon(outcome, true);

    expect(() => buildUserImageExpectingFailure('platform-nav', '>=0.3.0', fake.command)).toThrow(
      message,
    );
    expect([...fake.images]).toEqual([[sentinel, 'sentinel-owner']]);
  });
});
