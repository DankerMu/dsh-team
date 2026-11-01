import { readFileSync } from 'node:fs';
import { readManagedComposition } from '../src/managed-config/index.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

const INVALID = 'Invalid managed bundle read observation';
const INVALID_COMPOSITION = 'Invalid managed composition';
const OFFICE_ID = 'office-agents';
const MISSING_ID = 'no-such-bundle';

type Run = (name: string, script: string) => string;
type JsonRecord = Record<string, unknown>;

export function loaderExpression(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('__jsExpr' in value)) return undefined;
  const expr = value.__jsExpr;
  return typeof expr === 'string' ? expr : undefined;
}

function record(value: unknown): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(INVALID);
  // Composition rows are untyped JSON; each field below is checked before use.
  return value as JsonRecord;
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error(INVALID);
  return value;
}

/** Format-bound line scan (not a YAML parse): the top-level ids under the shipped `- insert:` row. */
function shippedInsertIds(): string[] {
  const lines = readFileSync(
    new URL('../../plugins/office-agents/cordis.patch.yml', import.meta.url),
    'utf8',
  ).split('\n');
  const start = lines.indexOf('- insert:');
  if (start === -1) throw new Error(INVALID);
  const ids: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('- ')) break;
    const match = /^ {4}- id: (\S+)$/.exec(line);
    if (match?.[1] !== undefined) ids.push(match[1]);
  }
  if (ids.length !== 2) throw new Error(INVALID);
  return ids;
}

function hasSkillDirExpression(entry: unknown): boolean {
  const plugins = list(record(record(entry).config).plugins);
  const skills = plugins.map(record).find((plugin) => plugin.id === 'skill-filesystem');
  if (skills === undefined) return false;
  const dirs = list(record(skills.config).customSkillDirs);
  return loaderExpression(dirs[0]) !== undefined;
}

async function proveOfficeRead(run: Run, prefix: string): Promise<void> {
  const composition = await readManagedComposition(
    (script) => Promise.resolve(run(`${prefix}-bundle-read`, script)),
    [OFFICE_ID],
  );
  const [bundle] = composition.bundles;
  if (composition.bundles.length !== 1 || bundle?.id !== OFFICE_ID || !bundle.present) {
    throw new Error(INVALID);
  }
  const [registry, inserted] = bundle.patch.map(record);
  if (bundle.patch.length !== 2 || registry === undefined || inserted === undefined) {
    throw new Error(INVALID);
  }
  if (
    registry.id !== 'agent-preset-registry' ||
    record(registry.config).default !== 'office-general'
  )
    throw new Error(INVALID);
  const entries = list(inserted.insert);
  const ids = entries.map((entry) => record(entry).id);
  const expected = shippedInsertIds();
  if (ids.length !== expected.length || ids.some((id, index) => id !== expected[index])) {
    throw new Error(INVALID);
  }
  if (!entries.some(hasSkillDirExpression)) throw new Error(INVALID);
}

async function proveMissingRejected(lifecycle: UserImageLifecycle, run: Run, prefix: string) {
  const name = `${prefix}-bundle-missing`;
  let rejection: unknown;
  try {
    await readManagedComposition((script) => Promise.resolve(run(name, script)), [MISSING_ID]);
  } catch (error) {
    rejection = error;
  }
  if (!(rejection instanceof Error) || rejection.message !== INVALID_COMPOSITION) {
    throw new Error(INVALID);
  }
  // The in-image script's own fail() path, not a Docker failure, produced the rejection.
  const logs = lifecycle.command(['logs', name], 30_000);
  if (logs.error !== undefined || logs.status !== 0) throw new Error(INVALID);
  if (logs.stdout !== '' || !logs.stderr.split(/\r?\n/).includes(INVALID_COMPOSITION)) {
    throw new Error(INVALID);
  }
}

/**
 * In-image forced-state bundle read (#407): the shipped office bundle resolves through
 * dsh-app-boot `bundlePatchPaths`/`loadOverlayPatches` and is composed; a missing bundle rejects.
 * Results stay in memory; nothing is printed.
 */
export async function proveBundleRead(
  lifecycle: UserImageLifecycle,
  run: Run,
  prefix: string,
): Promise<void> {
  await proveOfficeRead(run, prefix);
  await proveMissingRejected(lifecycle, run, prefix);
}
