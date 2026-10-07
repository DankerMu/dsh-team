import type { ManagedPolicyEvidence } from './managed-policy-evidence.ts';

const ANCHOR = '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json';
const PROFILE = '/data/home/profiles/web/cordis.patch.yml';
const SAFE_FIELDS = [
  'id',
  'name',
  'group',
  'config',
  'insert',
  'plugins',
  'order',
  'description',
  'readLimit',
  '__jsExpr',
  'disabled',
  'isolate',
  'inject',
  'filter',
  'remove',
  'replace',
  'before',
  'after',
  'providers',
  'models',
  'provider',
  'model',
] as const;

export type ProfilePhase =
  | 'prepared'
  | 'start-runtime'
  | 'start-browser'
  | 'start-stopped'
  | 'employee-edited'
  | 'control-runtime'
  | 'control-stopped'
  | 'recompose-read'
  | 'recompose-published'
  | 'restart-runtime'
  | 'restart-browser'
  | 'final-hash';

interface Leaf {
  path: string;
  kind: string;
  digest: string;
}
interface Snapshot {
  byteHash: string;
  byteLength: number;
  semanticHash: string | null;
  loaderDumpHash: string | null;
  defaultDumpHash: string | null;
  parseStatus: 'parsed' | 'invalid';
  structure: Leaf[];
  structureTruncated: boolean;
  homeHash: string | null;
  liveHash: string;
  seedHash: string;
  markerHash: string;
  installedPackages?: unknown;
}

// Only fixed fixture files and three pinned package manifests are read. Neither
// config values, arbitrary object keys, environment nor module paths leave it.
function profileSnapshotScript(attest: boolean, profileBytes?: string): string {
  return `
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(${JSON.stringify(ANCHOR)});
const { load, dump } = require('js-yaml');
// The schema is resolved inside the installed image, not from the platform host.
const { entryListSchema } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis-plugin-include')).href);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bytes = ${profileBytes === undefined ? `readFileSync(${JSON.stringify(PROFILE)}, 'utf8')` : JSON.stringify(profileBytes)};
const safeFields = ${JSON.stringify(Object.fromEntries(SAFE_FIELDS.map((key) => [key, true])))};
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const structure = [];
let visited = 0;
let structureTruncated = false;
const walk = (value, path, depth = 0) => {
  if (++visited > 4096 || structure.length >= 512 || depth > 24) { structureTruncated = true; return; }
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (kind !== 'array' && kind !== 'object') {
    structure.push({ path, kind, digest: digest(JSON.stringify(value) ?? 'undefined') });
    return;
  }
  structure.push({ path, kind, digest: digest(kind === 'array' ? String(value.length) : JSON.stringify(Object.keys(value).sort())) });
  for (const key of Object.keys(value).sort()) {
    const segment = kind === 'array' ? key : Object.hasOwn(safeFields, key) ? key : 'key-' + digest(key);
    walk(value[key], path + '/' + segment, depth + 1);
    if (structureTruncated) break;
  }
};
let semanticHash = null, loaderDumpHash = null, defaultDumpHash = null, parseStatus = 'invalid';
try {
  const parsed = load(bytes, { schema: entryListSchema });
  semanticHash = digest(JSON.stringify(canonical(parsed)));
  loaderDumpHash = digest(dump(parsed, { schema: entryListSchema }));
  defaultDumpHash = digest(dump(parsed, { lineWidth: -1 }));
  walk(parsed, '');
  parseStatus = 'parsed';
} catch { /* Preserve byte evidence without leaking parser excerpts. */ }
const fileHash = (path) => existsSync(path) ? digest(readFileSync(path)) : null;
const snapshot = {
  byteHash: digest(bytes), byteLength: Buffer.byteLength(bytes), semanticHash,
  loaderDumpHash, defaultDumpHash, parseStatus, structure, structureTruncated,
  homeHash: fileHash('/data/home/cordis.patch.yml'),
  liveHash: fileHash('/data/home/profiles/web/node_modules/@dsh-team/zh-locale/cordis.patch.yml'),
  seedHash: fileHash('/opt/dsh-team/profile-seed/web/node_modules/@dsh-team/zh-locale/cordis.patch.yml'),
  markerHash: fileHash('/data/home/dsh-team-user-state.txt'),
};
if (${String(attest)}) {
  snapshot.installedPackages = [
    ['@deepseek-ai/cordis-plugin-loader', '1.0.5'],
    ['@deepseek-ai/dsh-agent-preset-registry', '0.2.0-rc.2'],
    ['@deepseek-ai/dsh-tool-fs', '0.2.0-rc.2'],
  ].map(([name, expectedVersion]) => {
    try {
      const raw = readFileSync(require.resolve(name + '/package.json'));
      const manifest = JSON.parse(raw);
      const version = typeof manifest.version === 'string' && /^[0-9A-Za-z.+-]{1,64}$/.test(manifest.version) ? manifest.version : null;
      return { name, expectedVersion, version, manifestHash: digest(raw), matchesPin: manifest.name === name && version === expectedVersion, status: 'resolved', resolution: 'dsh-install-anchor' };
    } catch {
      return { name, expectedVersion, version: null, matchesPin: false, status: 'unavailable', resolution: 'dsh-install-anchor' };
    }
  });
}
process.stdout.write(JSON.stringify(snapshot));
`;
}

export interface ProfileRecorder {
  capture(phase: ProfilePhase, profileBytes?: string): void;
}

export function createProfileRecorder(
  run: (phase: ProfilePhase, script: string) => string,
  evidence: ManagedPolicyEvidence,
): ProfileRecorder {
  let previous: Snapshot | undefined;
  let edited: Snapshot | undefined;
  const stages: unknown[] = [];
  return {
    capture(phase, profileBytes): void {
      const snapshot = JSON.parse(
        run(phase, profileSnapshotScript(phase === 'prepared', profileBytes)),
      ) as Snapshot;
      const { structure, installedPackages, ...summary } = snapshot;
      const before = new Map(previous?.structure.map((leaf) => [leaf.path, leaf]) ?? []);
      const after = new Map(structure.map((leaf) => [leaf.path, leaf]));
      const differences = [...new Set([...before.keys(), ...after.keys()])]
        .sort()
        .flatMap((path) => {
          const left = before.get(path);
          const right = after.get(path);
          if (left?.digest === right?.digest && left?.kind === right?.kind) return [];
          return [
            {
              path,
              beforeKind: left?.kind ?? 'missing',
              afterKind: right?.kind ?? 'missing',
              beforeDigest: left?.digest ?? null,
              afterDigest: right?.digest ?? null,
            },
          ];
        });
      if (phase === 'employee-edited') edited = snapshot;
      // Retain only deltas, not the full flattened profile, in canonical evidence.
      stages.push({
        phase,
        ...summary,
        previousByteHash: previous?.byteHash ?? null,
        byteChanged: previous === undefined ? false : snapshot.byteHash !== previous.byteHash,
        semanticChanged:
          previous === undefined ? false : snapshot.semanticHash !== previous.semanticHash,
        matchesEmployeeBytes: edited === undefined ? null : snapshot.byteHash === edited.byteHash,
        changedPaths: previous === undefined ? [] : differences.slice(0, 64),
        differencesTruncated:
          differences.length > 64 ||
          snapshot.structureTruncated ||
          (previous?.structureTruncated ?? false),
      });
      evidence.record({
        profileStages: stages,
        ...(installedPackages === undefined ? {} : { installedPackages }),
      });
      previous = snapshot;
    },
  };
}
