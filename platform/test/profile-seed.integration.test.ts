import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { profileSeedOracle, profileSeedScript } from './profile-seed-fixture.ts';

/** Independent observations at the Python JSON seam, not a mock claiming Docker capability. */
function observations() {
  const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
  const file = (bytes: string | Buffer) => ({ kind: 'file', sha256: hash(bytes) });
  const pinned: Record<string, { kind: string; sha256?: string } | null> = {
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
  };
  for (const name of ['package.json', 'index.js', 'client.js', 'cordis.patch.yml']) {
    pinned[`web/node_modules/@dsh-team/zh-locale/${name}`] = file(
      readFileSync(new URL(`../../plugins/zh-locale/${name}`, import.meta.url)),
    );
  }
  const seed = { digest: hash('delivered seed tree'), count: 14_663 };
  const edited = {
    count: 2,
    entries: {
      'web/cordis.patch.yml': file('# User profile edit retained across containers\n[]\n'),
      'web/profile-seed-test-marker': file('uid1001 persistent profile marker\n'),
    },
  };
  const common = {
    effectiveUid: 1001,
    seed,
    seedAfter: seed,
    pinned,
    metadata: { checked: seed.count + 3, owner: 0, writable: 0, first: [] as string[] },
    enginesDsh: '>=0.2.1-rc.2 <0.3.0',
    installedDsh: '0.2.1-rc.2',
    enginesSatisfied: true,
    rootConfig: '[]\n',
    patch: '[]\n',
    workspace: 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
  };
  return {
    fresh: {
      ...common,
      phase: 'fresh',
      live: { count: 0, entries: {} },
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
      const pinned: typeof fresh.pinned = kind === 'partial' ? { ...fresh.pinned } : {};
      if (kind === 'partial') pinned['web/cordis.yml'] = null;
      const invalid = { ...fresh, pinned };

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
      const pinned = { ...fresh.pinned, [path]: { kind: 'file', sha256: '0'.repeat(64) } };

      expect(() => {
        profileSeedOracle()(JSON.stringify({ ...fresh, pinned }));
      }).toThrow(`Canonical plugin bytes differ: ${path}`);
    },
  );

  it('rejects changed seed bytes after successful live edits', () => {
    const { fresh } = observations();
    const seedAfter = { ...fresh.seed, digest: '0'.repeat(64) };

    expect(() => {
      profileSeedOracle()(JSON.stringify({ ...fresh, seedAfter }));
    }).toThrow('Seed changed after live edits or denied mutations');
  });

  it('rejects matching paths with different first-copy bytes', () => {
    const { fresh } = observations();
    const live = {
      count: 1,
      entries: { 'web/cordis.yml': { kind: 'file', sha256: '0'.repeat(64) } },
    };

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

  // The per-entry owner and permission judgement runs in the container (see the observer below);
  // the oracle rejects any reported violation and any entry left unjudged.
  it.each([
    ['owner', { owner: 1 }, 'Seed boundary must be root-owned'],
    ['writable', { writable: 1 }, 'Seed boundary must not be writable'],
    ['listed', { first: ['/opt/dsh-team/profile-seed/web'] }, 'Seed boundary must be root-owned'],
    ['missing-metadata', { checked: 14_665 }, 'Permissions must cover the entire seed'],
  ] as const)('rejects an unsafe %s seed permission boundary', (_kind, change, message) => {
    const { fresh } = observations();
    const metadata = { ...fresh.metadata, ...change };

    expect(() => {
      profileSeedOracle()(JSON.stringify({ ...fresh, metadata }));
    }).toThrow(message);
  });

  it('rejects a seed below the delivered entry floor even when every copy agrees', () => {
    const { fresh } = observations();
    const seed = { ...fresh.seed, count: 12 };
    const metadata = { ...fresh.metadata, checked: 15 };

    expect(() => {
      profileSeedOracle()(JSON.stringify({ ...fresh, seed, seedAfter: seed, metadata }));
    }).toThrow('Seed must hold the delivered profile tree');
  });

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
      const entries: Record<string, unknown> = { ...reuse.live.entries };
      // A reverted patch or a lost marker no longer differs from the seed.
      if (loss === 'patch' || loss === 'all') delete entries['web/cordis.patch.yml'];
      if (loss === 'marker' || loss === 'all') delete entries['web/profile-seed-test-marker'];
      const live = { count: Object.keys(entries).length, entries };
      const oracle = profileSeedOracle();
      oracle(JSON.stringify(fresh));

      expect(() => {
        oracle(JSON.stringify({ ...reuse, live, liveAfter: live }));
      }).toThrow('Reused volume must preserve exact user edits and marker');
    },
  );

  it('retains the original seed across valid fresh/reuse observations and rejects later seed drift', () => {
    const { fresh, reuse } = observations();
    const seed = { ...reuse.seed, digest: '0'.repeat(64) };
    const oracle = profileSeedOracle();
    oracle(JSON.stringify(fresh));
    oracle(JSON.stringify(reuse));

    expect(() => {
      oracle(JSON.stringify({ ...reuse, seed, seedAfter: seed }));
    }).toThrow('Second container must retain the original seed');
  });

  it.each([
    { effectiveUid: 0 },
    { enginesDsh: '>=0.3.0', enginesSatisfied: false },
    { enginesSatisfied: false },
    { installedDsh: '0.2.0-rc.2' },
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

  it('judges a complete tree inside the observer and reports only digests, counts and the exact differences', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-team-test-seed-observer-'));
    const opt = join(directory, 'opt');
    const seed = join(opt, 'dsh-team/profile-seed');
    const live = join(directory, 'live');
    const bin = join(directory, 'bin');
    const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
    const files: Record<string, string | Buffer> = {
      'web/package.json': '{"name":"dsh-profile-web"}\n',
      'web/cordis.yml': '[]\n',
      'web/cordis.patch.yml': '[]\n',
      'web/pnpm-workspace.yaml': 'packages:\n  - .\n',
    };
    for (const name of ['package.json', 'index.js', 'client.js', 'cordis.patch.yml'])
      files[`web/node_modules/@dsh-team/zh-locale/${name}`] = readFileSync(
        new URL(`../../plugins/zh-locale/${name}`, import.meta.url),
      );
    /** Directories `directoryMode`, files `fileMode`, the root included. */
    const chmodTree = (root: string, directoryMode: number, fileMode: number): void => {
      chmodSync(root, directoryMode);
      for (const entry of readdirSync(root, { withFileTypes: true, recursive: true }))
        chmodSync(
          join(entry.parentPath, entry.name),
          entry.isDirectory() ? directoryMode : fileMode,
        );
    };
    try {
      for (const root of [seed, live])
        for (const [path, bytes] of Object.entries(files)) {
          mkdirSync(join(root, path, '..'), { recursive: true });
          writeFileSync(join(root, path), bytes);
        }
      writeFileSync(join(live, 'web/cordis.patch.yml'), '# edited\n');
      writeFileSync(join(live, 'web/marker'), 'marker\n');
      // The DSH semver boundary: a stand-in `node` answers the engines probe as the image does.
      mkdirSync(bin);
      writeFileSync(
        join(bin, 'node'),
        `#!/bin/sh\nprintf '{"installed":"0.2.1-rc.2","satisfied":true}'\n`,
        { mode: 0o755 },
      );
      chmodSync(opt, 0o755);
      chmodSync(join(opt, 'dsh-team'), 0o755);
      chmodTree(seed, 0o555, 0o444);
      // One writable seed file is the single permission violation the observer must count.
      chmodSync(join(seed, 'web/cordis.yml'), 0o644);

      const result = spawnSync('python3', ['-c', profileSeedScript, 'reuse', seed, live], {
        env: { PATH: `${bin}:/usr/local/bin:/usr/bin:/bin` },
        encoding: 'utf8',
        timeout: 10_000,
        killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      const readback = JSON.parse(result.stdout) as Record<string, unknown>;
      // 4 profile files, 4 plugin files and web, node_modules, @dsh-team, zh-locale.
      const seedDigest = readback.seed as { digest: string; count: number };
      expect(Object.keys(seedDigest).sort()).toEqual(['count', 'digest']);
      expect(seedDigest.count).toBe(12);
      expect(seedDigest.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(readback.seedAfter).toEqual(readback.seed);
      const edits = {
        count: 2,
        entries: {
          'web/cordis.patch.yml': { kind: 'file', sha256: hash('# edited\n') },
          'web/marker': { kind: 'file', sha256: hash('marker\n') },
        },
      };
      expect(readback.live).toEqual(edits);
      expect(readback.liveAfter).toEqual(edits);
      expect(readback.pinned).toMatchObject({
        web: { kind: 'directory' },
        'web/cordis.yml': { kind: 'file', sha256: hash('[]\n') },
      });
      // Every seed entry, the seed root and its two parents; owners are root only under root.
      const checked = 12 + 3;
      expect(readback.metadata).toMatchObject({
        checked,
        writable: 1,
        owner: process.getuid?.() === 0 ? 0 : checked,
      });
      expect(readback.denied).toEqual({});
    } finally {
      chmodTree(directory, 0o755, 0o644);
      rmSync(directory, { recursive: true });
    }
  });
});
