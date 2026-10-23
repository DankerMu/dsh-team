import { deepStrictEqual } from 'node:assert';
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { canonicalImageReference, isAbsentResource } from './docker-command.ts';
import type { DockerCommand, DockerCommandResult } from './docker-command.ts';

export const OWNER_LABEL = 'dsh-team.test-run';
export interface CleanupTarget {
  readonly kind: 'container' | 'image' | 'volume' | 'network';
  readonly name: string;
  readonly ownership?: Readonly<Record<string, string>>;
  networkId?: string;
}
export function output(result: DockerCommandResult, args: readonly string[]): string {
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `docker ${args.join(' ')} failed (${String(result.status)}): ` +
        `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}
function networkDocument(
  result: DockerCommandResult,
  args: readonly string[],
): Record<string, unknown> {
  const rows: unknown = JSON.parse(output(result, args));
  if (!Array.isArray(rows) || rows.length !== 1)
    throw new Error('Owned network inspection unavailable');
  const value: unknown = rows[0];
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Owned network inspection malformed');
  // Docker JSON is untyped; destructive callers validate the consumed identity fields.
  return value as Record<string, unknown>;
}

function removeOwnedNetwork(
  command: DockerCommand,
  name: string,
  ownership: Readonly<Record<string, string>>,
  expectedId?: string,
): void {
  const args = ['network', 'inspect', name];
  const result = command(args, 30_000);
  if (isAbsentResource(result, 'network', name)) {
    if (
      expectedId !== undefined &&
      !isAbsentResource(command(['network', 'inspect', expectedId], 30_000), 'network', expectedId)
    )
      throw new Error('Owned network ID remains after its name disappeared');
    return;
  }
  const network = networkDocument(result, args);
  const id = network.Id;
  const identityError = 'Refusing network cleanup: immutable identity does not match';
  deepStrictEqual(network.Name, name, identityError);
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error(identityError);
  deepStrictEqual(id, expectedId ?? id, identityError);
  const labels = network.Labels;
  if (typeof labels !== 'object' || labels === null || Array.isArray(labels))
    throw new Error('Refusing network cleanup: invocation label does not match');
  for (const [label, expected] of Object.entries(ownership)) {
    deepStrictEqual(
      Reflect.get(labels, label),
      expected,
      'Refusing network cleanup: invocation label does not match',
    );
  }
  deepStrictEqual(
    network.Containers,
    {},
    'Refusing network cleanup: network is not verified empty',
  );
  const exact = ['network', 'inspect', id];
  deepStrictEqual(networkDocument(command(exact, 30_000), exact), network);
  const remove = ['network', 'rm', id];
  output(command(remove, 30_000), remove);
  for (const target of [name, id]) {
    if (!isAbsentResource(command(['network', 'inspect', target], 30_000), 'network', target))
      throw new Error('Owned network remains after cleanup');
  }
}

export function removeOwned(
  command: DockerCommand,
  kind: 'container' | 'image' | 'volume' | 'network',
  name: string,
  runId: string,
  ownership?: Readonly<Record<string, string>>,
  networkId?: string,
): void {
  if (kind === 'network') {
    removeOwnedNetwork(command, name, ownership ?? { [OWNER_LABEL]: runId }, networkId);
    return;
  }
  const labels = kind === 'volume' ? '.Labels' : '.Config.Labels';
  const expected = ownership ?? { [OWNER_LABEL]: runId };
  // One retirement names one object; diagnostics keep the caller's name.
  const reference = kind === 'image' ? canonicalImageReference(name) : name;
  for (const [label, value] of Object.entries(expected)) {
    const args = [kind, 'inspect', '--format', `{{ index ${labels} "${label}" }}`, reference];
    const result = command(args, 30_000);
    if (isAbsentResource(result, kind, reference)) return;
    if (output(result, args).replace(/\r?\n$/, '') !== value) {
      throw new Error(`Refusing cleanup of ${kind} ${name}: invocation label does not match`);
    }
  }
  const remove = [kind, 'rm', ...(kind === 'container' ? ['--force'] : []), reference];
  output(command(remove, 30_000), remove);
  if (ownership !== undefined) {
    const absent = command([kind, 'inspect', reference], 30_000);
    if (!isAbsentResource(absent, kind, reference)) {
      throw new Error(`Owned ${kind} remains after cleanup`);
    }
  }
}
export function cleanupTargets(
  command: DockerCommand,
  targets: readonly CleanupTarget[],
  runId: string,
  failures: unknown[],
): void {
  // Containers before networks, then their persistent volumes and images; each remains exact-owned.
  for (const kind of ['container', 'network', 'volume', 'image'] as const) {
    for (const target of targets.filter((candidate) => candidate.kind === kind).reverse()) {
      try {
        removeOwned(command, kind, target.name, runId, target.ownership, target.networkId);
      } catch (error) {
        failures.push(error);
      }
    }
  }
}

/** Publish before creation so an independent finalizer survives the test process. */
export function registerCleanupTarget(
  targets: CleanupTarget[],
  runId: string,
  target: CleanupTarget,
): void {
  const journal = process.env.DSH_TEAM_CI_RESOURCE_JOURNAL;
  if (journal) {
    appendFileSync(
      journal,
      `${JSON.stringify({ runId, target: { ...target, ownership: target.ownership ?? { [OWNER_LABEL]: runId } } })}\n`,
      { encoding: 'utf8', mode: 0o600, flush: true },
    );
  }
  targets.push(target);
}

function cleanupOwnership(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Missing cleanup ownership');
  const labels: Record<string, string> = {};
  for (const [key, label] of Object.entries(value)) {
    if (
      !/^dsh-team\.[a-z-]+$/.test(key) ||
      typeof label !== 'string' ||
      !/^[a-zA-Z0-9-]{1,80}$/.test(label)
    )
      throw new Error('Invalid cleanup ownership');
    labels[key] = label;
  }
  if (Object.keys(labels).length === 0) throw new Error('Empty cleanup ownership');
  return labels;
}

function cleanupTarget(value: unknown): CleanupTarget {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid cleanup target');
  if (!('kind' in value) || !('name' in value) || !('ownership' in value))
    throw new Error('Incomplete cleanup target');
  const { kind, name, ownership } = value;
  if (kind !== 'container' && kind !== 'network' && kind !== 'volume' && kind !== 'image')
    throw new Error('Invalid cleanup resource kind');
  if (typeof name !== 'string' || !/^dsh-team-[a-zA-Z0-9_.:-]+$/.test(name))
    throw new Error('Invalid cleanup resource name');
  return { kind, name, ownership: cleanupOwnership(ownership) };
}

/** A journal grants only exact registered label/name authority, never prefix-wide deletion. */
export function readCleanupJournal(path: string): { runId: string; target: CleanupTarget }[] {
  if (statSync(path).size > 1_048_576) throw new Error('Cleanup journal exceeds bound');
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const entry: unknown = JSON.parse(line);
      if (
        typeof entry !== 'object' ||
        entry === null ||
        !('runId' in entry) ||
        !('target' in entry)
      )
        throw new Error('Invalid cleanup journal entry');
      if (typeof entry.runId !== 'string' || !/^[a-f0-9-]{36}$/.test(entry.runId))
        throw new Error('Invalid cleanup invocation');
      return { runId: entry.runId, target: cleanupTarget(entry.target) };
    });
}
