import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildUserImageExpectingFailure } from './user-image-fixture.ts';
import type { DockerCommand, DockerCommandResult } from './docker-command.ts';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const rejection = 'DSH plugin compatibility failed: platform-nav engines.dsh=">=0.3.0"';
const sentinel = 'dsh-team-test-sentinel:kept';

/**
 * Substitute daemon boundary: records each build's contexts, Dockerfile and primary context, and
 * the plugin range and catalog visible at build time.
 */
function daemon(outcome: DockerCommandResult, tagBuild: boolean) {
  const images = new Map<string, string>([[sentinel, 'sentinel-owner']]);
  const builds: {
    contexts: string[];
    range: unknown;
    file: string;
    primary: string;
    catalog: string;
  }[] = [];
  const ok = (stdout = ''): DockerCommandResult => ({ status: 0, stdout, stderr: '' });
  function build(args: readonly string[]): DockerCommandResult {
    const contexts = args.flatMap((arg, index) =>
      args[index - 1] === '--build-context' ? [arg] : [],
    );
    const directory = contexts.find((context) => context.startsWith('platform-nav='))?.slice(13);
    const manifest = JSON.parse(readFileSync(join(directory ?? '', 'package.json'), 'utf8')) as {
      engines?: { dsh?: unknown };
    };
    const primary = args.at(-1) ?? '';
    builds.push({
      contexts,
      range: manifest.engines?.dsh,
      file: args[args.indexOf('--file') + 1] ?? '',
      primary,
      catalog: readFileSync(join(primary, 'catalog.json'), 'utf8'),
    });
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

      const result = buildUserImageExpectingFailure(
        { plugin: 'platform-nav', enginesDsh: '>=0.3.0' },
        fake.command,
      );

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

    expect(() =>
      buildUserImageExpectingFailure(
        { plugin: 'platform-nav', enginesDsh: '>=0.3.0' },
        fake.command,
      ),
    ).toThrow(message);
    expect([...fake.images]).toEqual([[sentinel, 'sentinel-owner']]);
  });
});

const repositoryPrimary = join(repositoryRoot, 'images/dsh-user');
const catalogRejection = 'preinstalled packages not in catalog: @dsh-team/platform-nav';
const withoutPlatformNav = {
  primary: (directory: string) => {
    const path = join(directory, 'catalog.json');
    const catalog = JSON.parse(readFileSync(path, 'utf8')) as { entries: { id: string }[] };
    const entries = catalog.entries.filter((entry) => entry.id !== 'platform-nav');
    writeFileSync(path, `${JSON.stringify({ ...catalog, entries }, null, 2)}\n`);
  },
  expect: catalogRejection,
};
const repositoryBytes = () =>
  ['Dockerfile', 'catalog.json'].map((name) => readFileSync(join(repositoryPrimary, name)));

describe('inconsistent catalog user-image build rejection', () => {
  it.each([true, false])(
    'builds once from an owned mutated primary copy and leaves no owned tag (tagged=%s)',
    (tagged) => {
      const before = repositoryBytes();
      const fake = daemon(
        { status: 1, stdout: '', stderr: `#20 ERROR ${catalogRejection}\n` },
        tagged,
      );

      const result = buildUserImageExpectingFailure(withoutPlatformNav, fake.command);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(catalogRejection);
      expect(fake.builds).toHaveLength(1);
      const build = fake.builds[0];
      expect(build?.primary.startsWith(tmpdir())).toBe(true);
      expect(build?.primary).not.toBe(repositoryPrimary);
      expect(build?.file).toBe(join(build?.primary ?? '', 'Dockerfile'));
      expect(build?.catalog).not.toContain('@dsh-team/platform-nav');
      expect(build?.catalog).toContain('@dsh-team/zh-locale');
      expect(build?.contexts).toEqual(
        ['zh-locale', 'permission-tiers', 'office-agents', 'platform-nav'].map(repositoryPlugin),
      );
      expect(existsSync(build?.primary ?? '')).toBe(false);
      expect(repositoryBytes()).toEqual(before);
      expect([...fake.images]).toEqual([[sentinel, 'sentinel-owner']]);
    },
  );

  it.each([
    ['a successful build', { status: 0, stdout: '', stderr: '' }, 'must exit 1, got 0'],
    [
      'a failure without the expected diagnostic',
      { status: 1, stdout: '', stderr: 'ERROR: failed to fetch base image\n' },
      `does not contain ${catalogRejection}`,
    ],
  ] as const)(
    'rejects %s, removes the owned copy and still removes the owned tag',
    (_name, outcome, message) => {
      const before = repositoryBytes();
      const fake = daemon(outcome, true);

      expect(() => buildUserImageExpectingFailure(withoutPlatformNav, fake.command)).toThrow(
        message,
      );
      expect(fake.builds).toHaveLength(1);
      expect(existsSync(fake.builds[0]?.primary ?? '')).toBe(false);
      expect(repositoryBytes()).toEqual(before);
      expect([...fake.images]).toEqual([[sentinel, 'sentinel-owner']]);
    },
  );
});
