import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const pluginDirectory = new URL('../../plugins/zh-locale/', import.meta.url);
const pluginPrefix = 'web/node_modules/@dsh-team/zh-locale/';
const pluginFiles = ['package.json', 'index.js', 'client.js', 'cordis.patch.yml'];
const editedPatch = '# User profile edit retained across containers\n[]\n';
const markerPath = 'web/profile-seed-test-marker';
const markerBytes = 'uid1001 persistent profile marker\n';
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

interface Entry {
  readonly kind: 'directory' | 'file';
  readonly sha256?: string;
}
interface Readback {
  readonly phase: 'fresh' | 'reuse';
  readonly effectiveUid: number;
  readonly seed: Record<string, Entry>;
  readonly seedAfter: Record<string, Entry>;
  readonly live: Record<string, Entry>;
  readonly liveAfter: Record<string, Entry>;
  readonly metadata: readonly { path: string; uid: number; mode: number; parent: boolean }[];
  readonly denied: Record<string, number>;
  readonly webManifest: unknown;
  readonly peerVersion: string;
  readonly rootConfig: string;
  readonly patch: string;
  readonly workspace: string;
}

/** Local canonical bytes, never expectations obtained from the image under test. */
function canonicalPluginHashes(): Record<string, Entry> {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL('package.json', pluginDirectory), 'utf8'),
  );
  ok(typeof manifest === 'object' && manifest !== null && 'peerDependencies' in manifest);
  deepStrictEqual(manifest.peerDependencies, { '@deepseek-ai/dsh': '0.2.0-rc.2' });
  return Object.fromEntries(
    pluginFiles.map((file) => [
      `${pluginPrefix}${file}`,
      { kind: 'file', sha256: digest(readFileSync(new URL(file, pluginDirectory))) },
    ]),
  );
}

function validateSeed(readback: Readback, pluginHashes: Record<string, Entry>): void {
  strictEqual(readback.effectiveUid, 1001, 'Profile probe must run as uid1001');
  const requiredFiles = ['package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml'];
  strictEqual(readback.seed.web?.kind, 'directory', 'Seed must contain a real Web profile');
  for (const file of requiredFiles) {
    strictEqual(readback.seed[`web/${file}`]?.kind, 'file', `Missing Web profile file: ${file}`);
  }
  for (const [path, expected] of Object.entries(pluginHashes)) {
    deepStrictEqual(readback.seed[path], expected, `Canonical plugin bytes differ: ${path}`);
  }
  deepStrictEqual(
    readback.webManifest,
    {
      name: 'dsh-profile-web',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    },
    'Seed manifest must describe the released Web profile',
  );
  strictEqual(readback.peerVersion, '0.2.0-rc.2', 'Plugin must pin the installed DSH release');
  const uncomment = (text: string) =>
    text
      .split('\n')
      .map((line) => line.replace(/#.*$/, '').trim())
      .filter(Boolean)
      .join('\n');
  strictEqual(uncomment(readback.rootConfig), '[]', 'Root config must remain an empty entry list');
  strictEqual(
    uncomment(readback.patch),
    '[]',
    'Seed patch must remain the released empty user layer',
  );
  strictEqual(
    uncomment(readback.workspace),
    'packages:\n- .\nnodeLinker: hoisted\nautoInstallPeers: false',
    'Web profile must include the released plugin workspace settings',
  );
  const expectedPaths = [
    '/opt',
    '/opt/dsh-team',
    '/opt/dsh-team/profile-seed',
    ...Object.keys(readback.seed).map((path) => `/opt/dsh-team/profile-seed/${path}`),
  ].sort();
  deepStrictEqual(
    readback.metadata.map(({ path }) => path).sort(),
    expectedPaths,
    'Permissions must cover the entire seed and replacement-sensitive parents',
  );
  for (const metadata of readback.metadata) {
    strictEqual(metadata.uid, 0, `Seed boundary must be root-owned: ${metadata.path}`);
    ok(
      Number.isInteger(metadata.mode) && metadata.mode >= 0 && metadata.mode <= 0o7777,
      `Seed boundary must report a valid permission mode: ${metadata.path}`,
    );
    const parent = metadata.path === '/opt' || metadata.path === '/opt/dsh-team';
    strictEqual(metadata.parent, parent);
    strictEqual(
      metadata.mode & (parent ? 0o022 : 0o222),
      0,
      `Seed boundary must not be writable: ${metadata.path}`,
    );
  }
  deepStrictEqual(
    readback.seedAfter,
    readback.seed,
    'Seed changed after live edits or denied mutations',
  );
}

/** Stateful test callback: first-copy equality, immutable seed, then exact same-volume edits. */
export function profileSeedOracle(): (stdout: string) => void {
  const pluginHashes = canonicalPluginHashes();
  let originalSeed: Record<string, Entry> | undefined;
  let editedLive: Record<string, Entry> | undefined;
  return (stdout) => {
    // JSON is an external Python process boundary. Assertions below validate every consumed field.
    const readback = JSON.parse(stdout) as Readback;
    validateSeed(readback, pluginHashes);
    if (originalSeed === undefined) {
      strictEqual(readback.phase, 'fresh');
      deepStrictEqual(
        readback.live,
        readback.seed,
        'Fresh volume must receive identical recursive paths and bytes',
      );
      deepStrictEqual(
        readback.denied,
        { write: 13, delete: 13, replace: 13, replaceSeed: 13 },
        'Seed write, deletion and replacement must fail specifically with permission denied',
      );
      editedLive = {
        ...readback.seed,
        'web/cordis.patch.yml': { kind: 'file', sha256: digest(editedPatch) },
        [markerPath]: { kind: 'file', sha256: digest(markerBytes) },
      };
      deepStrictEqual(
        readback.liveAfter,
        editedLive,
        'uid1001 must modify a live profile and create a marker',
      );
      originalSeed = readback.seed;
    } else {
      strictEqual(readback.phase, 'reuse');
      deepStrictEqual(
        readback.seed,
        originalSeed,
        'Second container must retain the original seed',
      );
      deepStrictEqual(
        readback.live,
        editedLive,
        'Reused volume must preserve exact user edits and marker',
      );
      deepStrictEqual(readback.liveAfter, editedLive, 'Reuse must not reset the live profile');
      deepStrictEqual(readback.denied, {});
    }
  };
}

/** The only runtime observer; no DSH boot, manual volume copy, network or package installer. */
export const profileSeedScript = `
import errno
import hashlib
import json
import os
from pathlib import Path
import stat
import sys

# Optional roots exercise this same observer against owned local malformed filesystem fixtures.
# Real Docker always uses the defaults below, never a host bind mount or manual copy.
seed = Path(sys.argv[2] if len(sys.argv) > 2 else "/opt/dsh-team/profile-seed")
live = Path(sys.argv[3] if len(sys.argv) > 3 else "/data/home/profiles")
phase = sys.argv[1]

def inventory(root):
    if not root.is_dir():
        raise FileNotFoundError("Required profile tree is missing: " + str(root))
    entries = {}
    for path in sorted(root.rglob("*")):
        relative = str(path.relative_to(root))
        mode = path.lstat().st_mode
        if stat.S_ISDIR(mode):
            entries[relative] = {"kind": "directory"}
        elif stat.S_ISREG(mode):
            entries[relative] = {"kind": "file", "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
        else:
            raise AssertionError("Unexpected seed/profile entry type: " + str(path))
    return entries

before = inventory(seed)
live_before = inventory(live)
web = seed / "web"
plugin = web / "node_modules/@dsh-team/zh-locale"
for relative in ("package.json", "cordis.yml", "cordis.patch.yml", "pnpm-workspace.yaml",
                 "node_modules/@dsh-team/zh-locale/package.json",
                 "node_modules/@dsh-team/zh-locale/index.js",
                 "node_modules/@dsh-team/zh-locale/client.js",
                 "node_modules/@dsh-team/zh-locale/cordis.patch.yml"):
    if not (web / relative).is_file():
        raise FileNotFoundError("Missing required profile seed file: " + str(web / relative))
metadata = []
for path in [Path("/opt"), seed.parent, seed] + sorted(seed.rglob("*")):
    info = path.lstat()
    metadata.append({"path": str(path), "uid": info.st_uid,
                     "mode": stat.S_IMODE(info.st_mode), "parent": path in (Path("/opt"), seed.parent)})
readback = {
    "phase": phase, "effectiveUid": os.geteuid(), "seed": before, "live": live_before,
    "metadata": metadata, "denied": {},
    "webManifest": json.loads((web / "package.json").read_text()),
    "peerVersion": json.loads((plugin / "package.json").read_text())["peerDependencies"]["@deepseek-ai/dsh"],
    "rootConfig": (web / "cordis.yml").read_text(),
    "patch": (web / "cordis.patch.yml").read_text(),
    "workspace": (web / "pnpm-workspace.yaml").read_text(),
}
if phase == "fresh":
    (live / "web/cordis.patch.yml").write_text(${JSON.stringify(editedPatch)})
    (live / ${JSON.stringify(markerPath)}).write_text(${JSON.stringify(markerBytes)})
    operations = {
        "write": lambda: (web / "cordis.patch.yml").write_text("seed corruption"),
        "delete": lambda: (web / "package.json").unlink(),
        "replace": lambda: os.replace(web / "cordis.yml", web / "cordis.patch.yml"),
        "replaceSeed": lambda: seed.rename(seed.parent / "profile-seed-replaced"),
    }
    for name, operation in operations.items():
        try:
            operation()
            readback["denied"][name] = 0
        except OSError as error:
            if error.errno != errno.EACCES:
                raise
            readback["denied"][name] = error.errno
readback["seedAfter"] = inventory(seed)
readback["liveAfter"] = inventory(live)
print(json.dumps(readback, ensure_ascii=False, sort_keys=True))
`;
