// Local image build of the parent-side VPS lane: the three linux/amd64 images from
// `git archive <sha>`, each labelled with this run, saved to OCI archives and checked.
// Docker runs with the extracted source as cwd and relative paths only.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { capture, LaneRefusal } from './vps-lane-record.mjs';
import { sha256File } from './vps-lane-remote.mjs';

export const ROLES = ['platform', 'user', 'browser'];
// Files that uid 1000/nonroot must read; Docker COPY keeps context modes (pr512b: EACCES).
const LAYER_MODES = {
  platform: [
    ['app/platform/dist/db/migrations/', 'drwxr-xr-x'],
    ['app/platform/dist/db/migrations/1-initial.sql', '-rw-r--r--'],
    ['app/images/dsh-user/catalog.json', '-rw-r--r--'],
  ],
  browser: [['opt/dsh-team/probe-browser-runtime.mjs', '-rw-r--r--']],
};

const imageTag = (run, role) => `dsh-team-test-${run}:${role}`;

/** First file not readable, or directory not traversable, by others below `base`. */
function unreadable(base, directory = base) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const mode = lstatSync(path).mode;
    if (entry.isDirectory()) {
      if ((mode & 0o005) !== 0o005) return relative(base, path);
      const nested = unreadable(base, path);
      if (nested) return nested;
    } else if (entry.isFile() && (mode & 0o004) === 0) return relative(base, path);
  }
  return undefined;
}

/** Copies exactly the files the browser Dockerfile takes from its `browser-runtime` context. */
async function browserContext(source, context) {
  const dockerfile = readFileSync(join(source, 'images/browser-verification/Dockerfile'), 'utf8');
  const names = [...dockerfile.matchAll(/COPY --from=browser-runtime \/(\S+)/g)].map((m) => m[1]);
  mkdirSync(context);
  for (const name of names) {
    if (name.includes('/') || !existsSync(join(source, 'scripts', name)))
      throw new LaneRefusal(`browser Dockerfile names ${name}, which scripts/ lacks`);
    await copyFile(join(source, 'scripts', name), join(context, name));
  }
}

function buildArguments(source) {
  const plugins = readdirSync(join(source, 'plugins'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => ['--build-context', `${entry.name}=plugins/${entry.name}`]);
  return {
    platform: ['-f', 'platform/Dockerfile', '.'],
    user: ['-f', 'images/dsh-user/Dockerfile', ...plugins, 'images/dsh-user'],
    browser: [
      '-f',
      'images/browser-verification/Dockerfile',
      '--build-context',
      'browser-runtime=../browser-context',
      'images/browser-verification',
    ],
  };
}

function exited(child) {
  return new Promise((resolve) => {
    child.once('error', () => resolve(-1));
    child.once('close', (code) => resolve(code ?? -1));
  });
}

async function buildAll({ source, build, sha, run }) {
  const args = buildArguments(source);
  const codes = await Promise.all(
    ROLES.map((role) => {
      const log = openSync(join(build, `build-${role}.log`), 'w', 0o600);
      const child = spawn(
        'docker',
        [
          'buildx',
          'build',
          '--platform',
          'linux/amd64',
          '--load',
          '--progress=plain',
          '--label',
          `dsh-team.test-run=${run}`,
          '--label',
          `dsh-team.source-sha=${sha}`,
          '-t',
          imageTag(run, role),
          ...args[role],
        ],
        { cwd: source, stdio: ['ignore', log, log] },
      );
      return exited(child);
    }),
  );
  const failed = ROLES.filter((_role, index) => codes[index] !== 0);
  if (failed.length) {
    const tail = readFileSync(join(build, `build-${failed[0]}.log`), 'utf8').slice(-2000);
    throw new LaneRefusal(`image build failed: ${failed.join(', ')}\n${tail}`);
  }
}

/** Every saved layer entry for `path` must carry `want`; later layers cannot hide a bad one. */
function checkLayerModes(build, archive, wanted) {
  const blobs = capture('tar', ['-tf', archive], { cwd: build })
    .split('\n')
    .filter((name) => /^blobs\/sha256\/[a-f0-9]{64}$/.test(name));
  const found = new Map(wanted.map(([path]) => [path, new Set()]));
  for (const blob of blobs) {
    const listing = capture(
      'sh',
      ['-c', 'tar -xOf "$1" "$2" | { tar -tvf - 2>/dev/null || true; }', 'sh', archive, blob],
      {
        cwd: build,
      },
    );
    for (const line of listing.split('\n')) {
      const fields = line.trim().split(/\s+/);
      found.get(fields.at(-1) ?? '')?.add(fields[0]);
    }
  }
  for (const [path, want] of wanted) {
    const modes = [...(found.get(path) ?? [])];
    const bad = modes.find((mode) => mode !== want);
    if (modes.length === 0 || bad)
      throw new LaneRefusal(`saved layer mode: ${path} is ${bad ?? 'missing'}, want ${want}`);
  }
}

/** Removes only this run's own tags; a tag a failed build never created is already absent. */
function removeRunImages(run) {
  for (const role of ROLES)
    spawnSync('docker', ['image', 'rm', imageTag(run, role)], { stdio: 'ignore' });
}

/**
 * Builds, saves and checks the three images in `build` (a fresh 0700 directory), then removes
 * their local tags on every path. Returns each archive's sha256.
 */
export async function buildImages({ root, sha, build, run }) {
  mkdirSync(build, { mode: 0o700 });
  const archive = openSync(join(build, 'source.tar'), 'w', 0o600);
  capture('git', ['archive', '--format=tar', sha], {
    cwd: root,
    stdio: ['ignore', archive, 'pipe'],
  });
  const source = join(build, 'source');
  mkdirSync(source);
  capture('tar', ['-xf', '../source.tar'], { cwd: source });
  await browserContext(source, join(build, 'browser-context'));
  for (const base of [source, join(build, 'browser-context')]) {
    const path = unreadable(base);
    if (path)
      throw new LaneRefusal(`build input not world-readable: ${relative(build, join(base, path))}`);
  }
  try {
    await buildAll({ source, build, sha, run });
    const images = {};
    for (const role of ROLES) {
      const tag = imageTag(run, role);
      const identity = capture('docker', [
        'image',
        'inspect',
        '--format',
        '{{.Id}}|{{.Os}}/{{.Architecture}}',
        tag,
      ]).trim();
      const [id, platform] = identity.split('|');
      if (platform !== 'linux/amd64')
        throw new LaneRefusal(`${role} image is ${String(platform)}, not linux/amd64`);
      capture('docker', ['save', '--platform', 'linux/amd64', '-o', `../${role}-image.tar`, tag], {
        cwd: source,
      });
      images[role] = { id, sha256: await sha256File(join(build, `${role}-image.tar`)) };
    }
    for (const [role, wanted] of Object.entries(LAYER_MODES))
      checkLayerModes(build, `${role}-image.tar`, wanted);
    return images;
  } finally {
    removeRunImages(run);
  }
}
