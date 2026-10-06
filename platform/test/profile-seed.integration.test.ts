import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { profileSeedOracle, profileSeedScript } from './profile-seed-fixture.ts';

/** Independent observations at the Python JSON seam, not a mock claiming Docker capability. */
function observations() {
  const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
  const file = (bytes: string | Buffer) => ({ kind: 'file', sha256: hash(bytes) });
  const seed: Record<string, { kind: string; sha256?: string }> = {
    web: { kind: 'directory' },
    'web/package.json': file(
      '{"name":"dsh-profile-web","private":true,"dependencies":{},' +
        '"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]}}}\n',
    ),
    'web/cordis.yml': file('[]\n'),
    'web/cordis.patch.yml': file('[]\n'),
    'web/pnpm-workspace.yaml': file(
      'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
    ),
    'web/node_modules': { kind: 'directory' },
    'web/node_modules/@dsh-team': { kind: 'directory' },
    'web/node_modules/@dsh-team/zh-locale': { kind: 'directory' },
  };
  for (const name of ['package.json', 'index.js', 'client.js', 'cordis.patch.yml']) {
    seed[`web/node_modules/@dsh-team/zh-locale/${name}`] = file(
      readFileSync(new URL(`../../plugins/zh-locale/${name}`, import.meta.url)),
    );
  }
  const edited: typeof seed = {
    ...seed,
    'web/cordis.patch.yml': file('# User profile edit retained across containers\n[]\n'),
    'web/profile-seed-test-marker': file('uid1001 persistent profile marker\n'),
  };
  const metadata = [
    { path: '/opt', uid: 0, mode: 0o755, parent: true },
    { path: '/opt/dsh-team', uid: 0, mode: 0o755, parent: true },
    { path: '/opt/dsh-team/profile-seed', uid: 0, mode: 0o555, parent: false },
    ...Object.entries(seed).map(([path, entry]) => ({
      path: `/opt/dsh-team/profile-seed/${path}`,
      uid: 0,
      mode: entry.kind === 'directory' ? 0o555 : 0o444,
      parent: false,
    })),
  ];
  const common = {
    effectiveUid: 1001,
    seed,
    seedAfter: seed,
    metadata,
    webManifest: {
      name: 'dsh-profile-web',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    },
    peerVersion: '0.2.0-rc.2',
    rootConfig: '[]\n',
    patch: '[]\n',
    workspace: 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
  };
  return {
    fresh: {
      ...common,
      phase: 'fresh',
      live: seed,
      liveAfter: edited,
      denied: { write: 13, delete: 13, replace: 13, replaceSeed: 13 },
    },
    reuse: { ...common, phase: 'reuse', live: edited, liveAfter: edited, denied: {} },
  };
}

describe('profile seed observed-behavior oracle', () => {
  it.each(['missing', 'empty', 'partial'] as const)(
    'rejects %s seed content even when the first-copy tree is equally incomplete',
    (kind) => {
      const { fresh } = observations();
      const seed: typeof fresh.seed = kind === 'partial' ? { ...fresh.seed } : {};
      if (kind === 'partial') delete seed['web/cordis.yml'];
      const invalid = { ...fresh, seed, live: seed, seedAfter: seed };

      expect(() => {
        profileSeedOracle()(JSON.stringify(invalid));
      }).toThrow(
        kind === 'partial'
          ? 'Missing Web profile file: cordis.yml'
          : 'Seed must contain a real Web profile',
      );
    },
  );

  it.each(['package.json', 'index.js', 'client.js', 'cordis.patch.yml'])(
    'rejects canonical plugin %s bytes changed in both seed and live copy',
    (name) => {
      const { fresh } = observations();
      const path = `web/node_modules/@dsh-team/zh-locale/${name}`;
      const seed = { ...fresh.seed, [path]: { kind: 'file', sha256: '0'.repeat(64) } };

      expect(() => {
        profileSeedOracle()(JSON.stringify({ ...fresh, seed, seedAfter: seed, live: seed }));
      }).toThrow(`Canonical plugin bytes differ: ${path}`);
    },
  );

  it('rejects changed seed bytes after successful live edits', () => {
    const { fresh } = observations();
    const seedAfter = {
      ...fresh.seed,
      'web/cordis.patch.yml': { kind: 'file', sha256: '0'.repeat(64) },
    };

    expect(() => {
      profileSeedOracle()(JSON.stringify({ ...fresh, seedAfter }));
    }).toThrow('Seed changed after live edits or denied mutations');
  });

  it('rejects matching paths with different first-copy bytes', () => {
    const { fresh } = observations();
    const live = { ...fresh.live, 'web/cordis.yml': { kind: 'file', sha256: '0'.repeat(64) } };

    expect(() => {
      profileSeedOracle()(JSON.stringify({ ...fresh, live }));
    }).toThrow('Fresh volume must receive identical recursive paths and bytes');
  });

  it('rejects a live profile that uid1001 could not edit', () => {
    const { fresh } = observations();

    expect(() => {
      profileSeedOracle()(JSON.stringify({ ...fresh, liveAfter: fresh.live }));
    }).toThrow('uid1001 must modify a live profile and create a marker');
  });

  it.each(['file', 'directory', 'parent', 'owner', 'missing-metadata'] as const)(
    'rejects an unsafe %s seed permission boundary',
    (kind) => {
      const { fresh } = observations();
      const metadata = fresh.metadata.map((entry) => ({ ...entry }));
      const target = metadata.find(
        ({ path }) =>
          path ===
          (kind === 'parent'
            ? '/opt/dsh-team'
            : kind === 'directory'
              ? '/opt/dsh-team/profile-seed/web'
              : '/opt/dsh-team/profile-seed/web/package.json'),
      );
      if (target === undefined) throw new Error('Independent fixture lacks permission target');
      if (kind === 'owner') target.uid = 1001;
      else if (kind === 'missing-metadata') metadata.pop();
      else target.mode |= kind === 'parent' ? 0o002 : 0o200;

      expect(() => {
        profileSeedOracle()(JSON.stringify({ ...fresh, metadata }));
      }).toThrow(
        kind === 'owner'
          ? 'Seed boundary must be root-owned'
          : kind === 'missing-metadata'
            ? 'Permissions must cover the entire seed'
            : 'Seed boundary must not be writable',
      );
    },
  );

  it.each(['write', 'delete', 'replace', 'replaceSeed'] as const)(
    'rejects a successful %s operation instead of accepting an alleged immutable seed',
    (operation) => {
      const { fresh } = observations();
      const denied = { ...fresh.denied, [operation]: 0 };

      expect(() => {
        profileSeedOracle()(JSON.stringify({ ...fresh, denied }));
      }).toThrow('must fail specifically with permission denied');
    },
  );

  it('rejects missing-file errors as evidence of permission denial', () => {
    const { fresh } = observations();

    expect(() => {
      profileSeedOracle()(
        JSON.stringify({
          ...fresh,
          denied: {
            write: 2,
            delete: 2,
            replace: 2,
            replaceSeed: 2,
          },
        }),
      );
    }).toThrow('must fail specifically with permission denied');
  });

  it.each(['patch', 'marker', 'all'] as const)(
    'rejects loss of the user %s on a reused volume',
    (loss) => {
      const { fresh, reuse } = observations();
      const live = { ...reuse.live };
      if (loss === 'patch' || loss === 'all') {
        const original = fresh.seed['web/cordis.patch.yml'];
        if (original === undefined) throw new Error('Independent fixture lacks the original patch');
        live['web/cordis.patch.yml'] = original;
      }
      if (loss === 'marker' || loss === 'all') delete live['web/profile-seed-test-marker'];
      const oracle = profileSeedOracle();
      oracle(JSON.stringify(fresh));

      expect(() => {
        oracle(JSON.stringify({ ...reuse, live, liveAfter: live }));
      }).toThrow('Reused volume must preserve exact user edits and marker');
    },
  );

  it('retains the original seed across valid fresh/reuse observations and rejects later seed drift', () => {
    const { fresh, reuse } = observations();
    const seed = { ...reuse.seed, 'web/cordis.yml': { kind: 'file', sha256: '0'.repeat(64) } };
    const oracle = profileSeedOracle();
    oracle(JSON.stringify(fresh));
    oracle(JSON.stringify(reuse));

    expect(() => {
      oracle(JSON.stringify({ ...reuse, seed, seedAfter: seed }));
    }).toThrow('Second container must retain the original seed');
  });

  it.each([
    { effectiveUid: 0 },
    { peerVersion: '^0.2.0-rc.2' },
    { webManifest: { dsh: { profile: { bundles: [] } } } },
    { rootConfig: '- name: preactivated-plugin\n' },
    { patch: '- name: duplicate-locale\n' },
    { workspace: '' },
  ])('rejects invalid released profile semantics or identity %#', (invalid) => {
    const { fresh } = observations();

    expect(() => {
      profileSeedOracle()(JSON.stringify({ ...fresh, ...invalid }));
    }).toThrow();
  });
});

describe('profile seed filesystem observer', () => {
  it.each(['missing', 'empty', 'partial'] as const)(
    'fails on an actual %s seed tree rather than emitting a success observation',
    (kind) => {
      const directory = mkdtempSync(join(tmpdir(), 'dsh-team-test-seed-observer-'));
      const seed = join(directory, 'seed');
      const live = join(directory, 'live');
      try {
        mkdirSync(live);
        if (kind !== 'missing') mkdirSync(seed);
        if (kind === 'partial') {
          const web = join(seed, 'web');
          const plugin = join(web, 'node_modules/@dsh-team/zh-locale');
          mkdirSync(plugin, { recursive: true });
          writeFileSync(join(web, 'package.json'), '{"name":"dsh-profile-web"}\n');
          writeFileSync(
            join(plugin, 'package.json'),
            readFileSync(new URL('../../plugins/zh-locale/package.json', import.meta.url)),
          );
        }

        const result = spawnSync('python3', ['-c', profileSeedScript, 'reuse', seed, live], {
          env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
          encoding: 'utf8',
          timeout: 10_000,
          killSignal: 'SIGKILL',
          maxBuffer: 1024 * 1024,
        });

        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('FileNotFoundError');
        expect(result.stderr).toContain(
          kind === 'missing'
            ? `Required profile tree is missing: ${seed}`
            : kind === 'empty'
              ? join(seed, 'web/package.json')
              : join(seed, 'web/cordis.yml'),
        );
      } finally {
        rmSync(directory, { recursive: true });
      }
    },
  );
});
