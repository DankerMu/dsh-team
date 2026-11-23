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

/** In the Document Server (sh, find; no node): counts, or with `remove` removes, the store entries
 * whose name hashes to `digest`, and prints how many. Counts are per key: other sessions close
 * asynchronously and land their own copies at any time. None before the store's first copy; an
 * unreadable store exits nonzero. Only the digest is in the script; stderr is discarded, since it
 * would name the entry. */
const keyedSh = (digest: string, remove: boolean) => `exec 2>/dev/null
test -d "$1" || { printf '{"matched":0}\\n'; exit 0; }
list=$(find "$1" -mindepth 1 -maxdepth 1) || exit 4
matched=0
while IFS= read -r entry; do
  [ -n "$entry" ] || continue
  [ "$(printf %s "$(basename "$entry")" | sha256sum | cut -d ' ' -f 1)" = '${digest}' ] || continue
  ${remove ? 'rm -rf "$entry" || exit 5' : ':'}
  matched=$((matched + 1))
done <<EOF
$list
EOF
printf '{"matched":%s}\\n' "$matched"`;

/** `key`'s entries in the store, counted or removed; guarded, so no failure carries the key (the
 * directory name is the key). */
async function keyed(lane: StoreLane, key: string, label: string, remove: boolean) {
  const script = keyedSh(digestOf(key), remove);
  const args = ['exec', DOCUMENT_SERVER, 'sh', '-c', script, 'sh', FORGOTTEN_DIR];
  const { matched } = await guarded(label, [key], () => lane.run(args));
  if (typeof matched !== 'number' || !Number.isInteger(matched) || matched < 0)
    throw new Error('Document Server forgotten key count unreadable');
  return matched;
}

/** The number of `key`'s copies in the store (one directory named by the key, as measured). */
export const forgottenCopies = (lane: StoreLane, key: string, label: string) =>
  keyed(lane, key, label, false);

/** Removes `key`'s copies from the store and returns how many entries went. */
export const removeForgotten = (lane: StoreLane, key: string, label: string) =>
  keyed(lane, key, label, true);

/** In the Document Server (python3; no node): each store entry's shape, oldest first. A 64-hex run
 * in any name prints as `<hex64>`; only the key's digest is in the script, and stderr (a traceback
 * would quote a path) goes to /dev/null. */
const shapePy = (digest: string | null) => `import hashlib, json, os, re, sys, time
sys.stderr = open(os.devnull, 'w')
root, digest = sys.argv[1], ${digest === null ? 'None' : `'${digest}'`}
HEX = re.compile(r'[0-9a-f]{64}')
name_digest = lambda name: hashlib.sha256(name.encode('utf-8', 'surrogateescape')).hexdigest()
entries = []
for name in os.listdir(root) if os.path.isdir(root) else []:
    path = os.path.join(root, name)
    inside = os.path.isdir(path) and not os.path.islink(path)
    entries.append({'hex64': HEX.fullmatch(name) is not None, 'length': len(name),
        'matchesKey': digest is not None and name_digest(name) == digest, 'dir': inside,
        'files': sorted(HEX.sub('<hex64>', f) for f in os.listdir(path)) if inside else [],
        'ageSeconds': round(time.time() - os.lstat(path).st_mtime)})
entries.sort(key=lambda entry: -entry['ageSeconds'])
print(json.dumps({'entries': entries}))`;

/** A diagnostic of the store for a failure message: per entry whether its name is 64 hex, its
 * length, whether it is `key`'s (never when `key` is null), whether it is a directory, the names
 * inside and its age in seconds; guarded, so no failure carries the key. */
export async function forgottenShape(lane: StoreLane, key: string | null, label: string) {
  const digest = key === null ? null : digestOf(key);
  const args = ['exec', DOCUMENT_SERVER, 'python3', '-I', '-c', shapePy(digest), FORGOTTEN_DIR];
  const { entries } = await guarded(label, [key ?? undefined], () => lane.run(args));
  if (!Array.isArray(entries)) throw new Error('Document Server forgotten store shape unreadable');
  return entries as unknown[]; // printed only, never asserted field by field
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

/** `key`'s copies in the store and whether the list holds it. */
export async function forgottenCopy(lane: ForgottenLane, key: string, label: string) {
  return {
    copies: await forgottenCopies(lane, key, label),
    listed: await listed(lane, key, label),
  };
}

/** `key`'s copy observed, then removed: `cleared` when exactly `copies` entries went, none of the
 * key's remain and the list no longer holds it. Counts and booleans only. */
export async function forgottenRecord(lane: ForgottenLane, key: string, label: string) {
  const copy = await forgottenCopy(lane, key, label);
  const removed = await removeForgotten(lane, key, label);
  const none = (await forgottenCopies(lane, key, label)) === 0;
  const cleared = removed === copy.copies && none && !(await listed(lane, key, label));
  return { ...copy, cleared };
}

/** The settle window: the refused close-time save lands seconds after the session closes. */
export const settleForgotten = () => delay(OBSERVE_MS);

/** `body`'s result. When it fails once it has set `held.key`: awaits `settle` for the refused
 * close-time save, removes that key's copy best-effort and rethrows the same error untouched. */
export async function clearingForgottenOnError<T>(
  lane: StoreLane,
  label: string,
  body: (held: ForgottenKey) => Promise<T>,
  settle: () => Promise<unknown> = settleForgotten,
): Promise<T> {
  const held: ForgottenKey = { key: null };
  try {
    return await body(held);
  } catch (error) {
    const { key } = held;
    if (key !== null) {
      await settle();
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
