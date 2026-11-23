import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { DockerOutput } from './deployment-compose-fixture.ts';
import { DOCUMENT_SERVER } from './document-server-net-fixture.ts';
import type { NamespaceRead } from './document-server-net-fixture.ts';
import { guarded, registryKeys, script } from './office-isolation-stack-fixture.ts';
import { exchangeJs, JWT_JS, READ_JS } from './onlyoffice-probe-script.ts';
import type { ArchiveLane } from './sidebar-archive-stack-fixture.ts';
import { redactSecrets } from './stack-browser-fixture.ts';

/** The delivered Document Server's forgotten store (fs storage, default folderPath). */
export const FORGOTTEN_DIR = '/var/lib/onlyoffice/documentserver/App_Data/cache/files/forgotten';
// A refused close-time save reaches the store seconds after the session closes, as a notice, the
// refresh or a late status 2 follow a rewrite: 15s is a quarter of the 60s session timeout.
export const OBSERVE_MS = 15_000;

/** Host Docker, which reaches the Document Server container. */
interface StoreLane {
  readonly run: DockerOutput;
}
/** Host Docker and the Document Server's own loopback (the namespace holder). */
interface ForgottenLane extends StoreLane {
  readonly namespaceRead: NamespaceRead;
}
/** Where a case leaves the key it read, so a failure can clear its copy without carrying it. */
export interface ForgottenKey {
  key: string | null;
}

const digestOf = (key: string) => createHash('sha256').update(key).digest('hex');

/** In the Document Server (sh, find; no node): the store's directory count. The server creates
 * `cache/files` at startup but `forgotten` only with its first copy, so a missing leaf counts 0 and
 * a missing parent or an unreadable store exits nonzero. */
const COUNT_SH = `test -d "$(dirname "$1")" || exit 3
test -d "$1" || { echo 0; exit 0; }
found=$(find "$1" -mindepth 1 -maxdepth 1 -type d -exec printf . ';') || exit 4
echo "\${#found}"`;

/** The current directory count under the Document Server's forgotten store (a delta across the
 * trigger attributes a copy to this scenario). An unreadable store or count rejects. */
export async function forgottenDirs(lane: StoreLane): Promise<number> {
  const output = await lane.run([
    'exec',
    DOCUMENT_SERVER,
    'sh',
    '-c',
    COUNT_SH,
    'sh',
    FORGOTTEN_DIR,
  ]);
  if (!/^\d+$/.test(output.trim()))
    throw new Error('Document Server forgotten store count unreadable');
  return Number(output.trim());
}

/** In the Document Server: removes every store entry whose name hashes to `digest` and prints how
 * many (none before the store's first copy). Only the digest is in the script; stderr is
 * discarded, since it would name the entry. */
const removeSh = (digest: string) => `exec 2>/dev/null
test -d "$1" || { printf '{"removed":0}\\n'; exit 0; }
list=$(find "$1" -mindepth 1 -maxdepth 1) || exit 4
removed=0
while IFS= read -r entry; do
  [ -n "$entry" ] || continue
  [ "$(printf %s "$(basename "$entry")" | sha256sum | cut -d ' ' -f 1)" = '${digest}' ] || continue
  rm -rf "$entry" || exit 5
  removed=$((removed + 1))
done <<EOF
$list
EOF
printf '{"removed":%s}\\n' "$removed"`;

/** Removes `key`'s copy from the store and returns the number of entries removed; guarded, so no
 * failure carries the key (the directory name is the key). */
export async function removeForgotten(lane: StoreLane, key: string, label: string) {
  const args = ['exec', DOCUMENT_SERVER, 'sh', '-c', removeSh(digestOf(key)), 'sh', FORGOTTEN_DIR];
  const { removed } = await guarded(label, [key], () => lane.run(args));
  if (typeof removed !== 'number' || !Number.isInteger(removed) || removed < 0)
    throw new Error('Document Server forgotten removal count unreadable');
  return removed;
}

/** In the Document Server's namespace (the holder's loopback, as 51-e's `info` probe): one
 * `getForgottenList` with a body-`token` JWT signed by the secret on stdin. Only A's key's SHA-256
 * is embedded, so the script (docker argv, quoted by a failed exec) never carries the key. Reports
 * DS's numeric `error`, whether an entry is A's key (`listed`) or a `<key>/…` path under it
 * (`contains`), the list length and the first entry's shape — never a key or token value (§55.5
 * positive control, with §55.6 attribution diagnostics). */
export const namespaceForgottenListScript = (kA: string, port = 80): string =>
  script(`const jwtSecret = readFileSync(0, 'utf8');
${JWT_JS}
${exchangeJs('127.0.0.1', '127.0.0.1', port)}
${READ_JS}
const digest = ${JSON.stringify(digestOf(kA))};
const isKey = (entry) => typeof entry === 'string' && createHash('sha256').update(entry).digest('hex') === digest;
const { status, body } = json(await exchange('POST', '/command', { c: 'getForgottenList', token: jwt({ c: 'getForgottenList' }) }));
const keys = Array.isArray(body?.keys) ? body.keys : [];
const first = keys[0];
Object.assign(observed, { status, error: typeof body?.error === 'number' ? body.error : null });
observed.listed = keys.some(isKey);
observed.contains = keys.some((entry) => typeof entry === 'string' && isKey(entry.split('/')[0]));
observed.length = keys.length;
observed.shape = typeof first === 'string'
  ? { type: 'string', slash: first.includes('/'), dotExt: /\\.[a-z0-9]+$/i.test(first) }
  : { type: typeof first };`);

/** A forgotten copy A key names is present: either a bare-key entry (`listed`) or a `<key>/output`
 * entry (`contains`); the shape diagnostics stay in evidence but are not asserted. */
export function forgottenPresent(observed: Record<string, unknown>): boolean {
  return observed.status === 200 && (observed.listed === true || observed.contains === true);
}

/** One namespace `getForgottenList` for A's key; guarded, so no failure path quotes A's key. */
export const forgottenList = (
  lane: Pick<ForgottenLane, 'namespaceRead'>,
  label: string,
  kA: string,
) =>
  guarded(label, [kA], async () =>
    JSON.stringify(await lane.namespaceRead(namespaceForgottenListScript(kA))),
  );

/** Whether the list holds `key`; a read that is not status 200, error 0 throws, never "absent". */
async function listed(lane: ForgottenLane, key: string, label: string) {
  // The observation as plain values: DS's numeric `error`, or a script failure's message.
  const seen: Record<string, unknown> = await forgottenList(lane, label, key);
  if (seen.status !== 200 || seen.error !== 0) {
    const detail = JSON.stringify({ status: seen.status, error: seen.error });
    const message = `Document Server forgotten list ${label} unreadable: ${detail}`;
    throw new Error(redactSecrets(message, [key]));
  }
  return forgottenPresent(seen);
}

/** `key`'s copy against the store's `baseline`: the directory delta and whether the list holds it. */
export async function forgottenCopy(
  lane: ForgottenLane,
  key: string,
  baseline: number,
  label: string,
) {
  return {
    added: (await forgottenDirs(lane)) - baseline,
    listed: await listed(lane, key, label),
  };
}

/** `key`'s copy observed, then removed: `cleared` when exactly `added` entries went, the store is
 * back at `baseline` and the list no longer holds the key. Counts and booleans only. */
export async function forgottenRecord(
  lane: ForgottenLane,
  key: string,
  baseline: number,
  label: string,
) {
  const copy = await forgottenCopy(lane, key, baseline, label);
  const removed = await removeForgotten(lane, key, label);
  const back = (await forgottenDirs(lane)) === baseline;
  const cleared = removed === copy.added && back && !(await listed(lane, key, label));
  return { ...copy, cleared };
}

/** `body`'s result. When it fails once it has set `held.key`: waits `settle` for the refused
 * close-time save, removes that key's copy best-effort and rethrows the same error untouched. */
export async function clearingForgottenOnError<T>(
  lane: StoreLane,
  label: string,
  body: (held: ForgottenKey) => Promise<T>,
  settle = OBSERVE_MS,
): Promise<T> {
  const held: ForgottenKey = { key: null };
  try {
    return await body(held);
  } catch (error) {
    const { key } = held;
    if (key !== null) {
      await delay(settle);
      // Swallowed: the case's own failure is the one to report; this cleanup is best-effort.
      await removeForgotten(lane, key, label).catch(() => undefined);
    }
    throw error;
  }
}

/** Polls A's registry for the key the plugin minted for the open file at `path` — the exact docId
 * the Document Server uses, so a forgotten copy is keyed by it (up to 10s); `null` if none. A
 * failed or malformed registry read rejects, never counting as no key. */
export async function registeredKey(lane: Pick<ArchiveLane, 'exec'>, path: string) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const key = (await registryKeys(lane, path))[0] ?? null;
    if (key !== null) return key;
    if (Date.now() >= deadline) return null;
    await delay(500);
  }
}
