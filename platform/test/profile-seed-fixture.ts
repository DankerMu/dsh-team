import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DSH_ENGINES_PRELUDE } from './dsh-engines.ts';

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
/** A whole tree judged inside the container: digest of its sorted paths, kinds and bytes. */
interface TreeDigest {
  readonly digest: string;
  readonly count: number;
}
/** The live entries differing from the seed (null: absent from live), the first 20 by path. */
interface TreeDiff {
  readonly count: number;
  readonly entries: Record<string, Entry | null>;
}
interface Readback {
  readonly phase: 'fresh' | 'reuse';
  readonly effectiveUid: number;
  readonly seed: TreeDigest;
  readonly seedAfter: TreeDigest;
  readonly pinned: Record<string, Entry | null>;
  readonly live: TreeDiff;
  readonly liveAfter: TreeDiff;
  readonly metadata: {
    readonly checked: number;
    readonly owner: number;
    readonly writable: number;
    readonly first: readonly string[];
  };
  readonly denied: Record<string, number>;
  readonly enginesDsh: string;
  readonly installedDsh: string;
  readonly enginesSatisfied: boolean;
  readonly rootConfig: string;
  readonly patch: string;
  readonly workspace: string;
}

/** Hardcoded floor against an empty seed passing: the sidebar's closure alone is ~14,600 entries. */
const SEED_ENTRY_FLOOR = 14_000;
const REQUIRED_FILES = ['package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml'];
const noDifference: TreeDiff = { count: 0, entries: {} };

interface CanonicalPlugin {
  readonly hashes: Record<string, Entry>;
  readonly enginesDsh: string;
}

/** Local canonical bytes and range, never expectations obtained from the image under test. */
function canonicalPlugin(): CanonicalPlugin {
  // JSON is the repository manifest; the assertions below validate every consumed field.
  const manifest = JSON.parse(readFileSync(new URL('package.json', pluginDirectory), 'utf8')) as {
    engines?: { dsh?: unknown };
    peerDependencies?: Record<string, unknown>;
  };
  const enginesDsh = manifest.engines?.dsh;
  ok(typeof enginesDsh === 'string' && enginesDsh.trim() !== '', 'Plugin must declare engines.dsh');
  strictEqual(manifest.peerDependencies?.['@deepseek-ai/dsh'], undefined, 'No exact DSH peer');
  const hashes = Object.fromEntries(
    pluginFiles.map((file) => [
      `${pluginPrefix}${file}`,
      { kind: 'file' as const, sha256: digest(readFileSync(new URL(file, pluginDirectory))) },
    ]),
  );
  return { hashes, enginesDsh };
}

function validateSeed(readback: Readback, plugin: CanonicalPlugin): void {
  strictEqual(readback.effectiveUid, 1001, 'Profile probe must run as uid1001');
  strictEqual(readback.pinned.web?.kind, 'directory', 'Seed must contain a real Web profile');
  for (const file of REQUIRED_FILES) {
    strictEqual(readback.pinned[`web/${file}`]?.kind, 'file', `Missing Web profile file: ${file}`);
  }
  for (const [path, expected] of Object.entries(plugin.hashes)) {
    deepStrictEqual(readback.pinned[path], expected, `Canonical plugin bytes differ: ${path}`);
  }
  ok(readback.seed.count >= SEED_ENTRY_FLOOR, 'Seed must hold the delivered profile tree');
  strictEqual(readback.enginesDsh, plugin.enginesDsh, 'Seeded engines.dsh must be canonical');
  strictEqual(readback.installedDsh, '0.2.1-rc.2', 'Image must carry the pinned DSH release');
  strictEqual(readback.enginesSatisfied, true, 'Installed DSH must satisfy engines.dsh');
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
  // Every seed entry plus /opt, /opt/dsh-team and the seed root, each judged in the container.
  strictEqual(
    readback.metadata.checked,
    readback.seed.count + 3,
    'Permissions must cover the entire seed and replacement-sensitive parents',
  );
  deepStrictEqual(
    [readback.metadata.owner, readback.metadata.first],
    [0, []],
    'Seed boundary must be root-owned',
  );
  deepStrictEqual(
    [readback.metadata.writable, readback.metadata.first],
    [0, []],
    'Seed boundary must not be writable',
  );
  deepStrictEqual(
    readback.seedAfter,
    readback.seed,
    'Seed changed after live edits or denied mutations',
  );
}

/** Stateful test callback: first-copy equality, immutable seed, then exact same-volume edits. */
export function profileSeedOracle(): (stdout: string) => void {
  const plugin = canonicalPlugin();
  // The only differences a uid1001 edit may leave between the live profile and the seed.
  const edited: TreeDiff = {
    count: 2,
    entries: {
      'web/cordis.patch.yml': { kind: 'file', sha256: digest(editedPatch) },
      [markerPath]: { kind: 'file', sha256: digest(markerBytes) },
    },
  };
  let originalSeed: TreeDigest | undefined;
  return (stdout) => {
    // JSON is an external Python process boundary. Assertions below validate every consumed field.
    const readback = JSON.parse(stdout) as Readback;
    validateSeed(readback, plugin);
    if (originalSeed === undefined) {
      strictEqual(readback.phase, 'fresh');
      deepStrictEqual(
        readback.live,
        noDifference,
        'Fresh volume must receive identical recursive paths and bytes',
      );
      deepStrictEqual(
        readback.denied,
        { write: 13, delete: 13, replace: 13, replaceSeed: 13 },
        'Seed write, deletion and replacement must fail specifically with permission denied',
      );
      deepStrictEqual(
        readback.liveAfter,
        edited,
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
        edited,
        'Reused volume must preserve exact user edits and marker',
      );
      deepStrictEqual(readback.liveAfter, edited, 'Reuse must not reset the live profile');
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
import subprocess
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

# Whole trees are judged here and leave as digests, counts and bounded differences: the delivered
# profile holds ~14,600 entries, far above the probe's bounded output.
def tree_digest(entries):
    lines = "\\n".join(path + "\\0" + entry["kind"] + "\\0" + entry.get("sha256", "")
                      for path, entry in sorted(entries.items()))
    return {"digest": hashlib.sha256(lines.encode()).hexdigest(), "count": len(entries)}

def difference(base, other):
    paths = sorted(path for path in set(base) | set(other) if base.get(path) != other.get(path))
    return {"count": len(paths), "entries": {path: other.get(path) for path in paths[:20]}}

before = inventory(seed)
live_before = inventory(live)
web = seed / "web"
plugin = web / "node_modules/@dsh-team/zh-locale"
pinned_paths = ("package.json", "cordis.yml", "cordis.patch.yml", "pnpm-workspace.yaml",
                "node_modules/@dsh-team/zh-locale/package.json",
                "node_modules/@dsh-team/zh-locale/index.js",
                "node_modules/@dsh-team/zh-locale/client.js",
                "node_modules/@dsh-team/zh-locale/cordis.patch.yml")
for relative in pinned_paths:
    if not (web / relative).is_file():
        raise FileNotFoundError("Missing required profile seed file: " + str(web / relative))
pinned = {path: before.get(path) for path in ["web"] + ["web/" + relative for relative in pinned_paths]}
parents = (seed.parent.parent, seed.parent)
metadata = {"checked": 0, "owner": 0, "writable": 0, "first": []}
for path in [*parents, seed] + sorted(seed.rglob("*")):
    info = path.lstat()
    metadata["checked"] += 1
    owner = info.st_uid != 0
    writable = (stat.S_IMODE(info.st_mode) & (0o022 if path in parents else 0o222)) != 0
    metadata["owner"] += owner
    metadata["writable"] += writable
    if (owner or writable) and len(metadata["first"]) < 5:
        metadata["first"].append(str(path))
engines_dsh = json.loads((plugin / "package.json").read_text())["engines"]["dsh"]
# DSH's own semver decides the range in the image, exactly as its loader does.
engines = json.loads(subprocess.run(
    ["node", "-e", ${JSON.stringify(`${DSH_ENGINES_PRELUDE}process.stdout.write(JSON.stringify({installed:dshInstalled,satisfied:dshEnginesSatisfied(process.argv[1])}));`)}, engines_dsh],
    check=True, capture_output=True, text=True, timeout=10).stdout)
readback = {
    "phase": phase, "effectiveUid": os.geteuid(), "seed": tree_digest(before), "pinned": pinned,
    "live": difference(before, live_before), "metadata": metadata, "denied": {},
    "enginesDsh": engines_dsh, "installedDsh": engines["installed"], "enginesSatisfied": engines["satisfied"],
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
readback["seedAfter"] = tree_digest(inventory(seed))
readback["liveAfter"] = difference(before, inventory(live))
print(json.dumps(readback, ensure_ascii=False, sort_keys=True))
`;
