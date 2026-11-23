import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, expect, it } from 'vitest';
import {
  clearingForgottenOnError,
  FORGOTTEN_DIR,
  forgottenCopy,
  forgottenDirs,
  forgottenPresent,
  forgottenRecord,
  forgottenShape,
  registeredKey,
  removeForgotten,
} from './document-server-forgotten-fixture.ts';
import { DOCUMENT_SERVER } from './document-server-net-fixture.ts';
import { REGISTRY } from './office-isolation-stack-fixture.ts';
import { everythingPrinted } from './stack-browser-fixture.ts';

const KA = 'a1'.repeat(32);
const OTHER = 'b2'.repeat(32);
const hex = () => randomBytes(32).toString('hex');
const ROOT = mkdtempSync(join(tmpdir(), 'dsh-team-forgotten-store-'));
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

let stores = 0;
/** A fresh `files/forgotten` under ROOT with one `<name>/output.docx` copy per name. */
const store = (...names: string[]) => {
  const dir = join(ROOT, String(stores++), 'files', 'forgotten');
  mkdirSync(dir, { recursive: true });
  for (const name of names) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, 'output.docx'), 'forgotten-docx-bytes');
  }
  return dir;
};
/** Runs `step` with `dir` unreadable and unwritable, restoring it after. */
const sealed = async (dir: string, mode: number, step: () => Promise<unknown>) => {
  chmodSync(dir, mode);
  try {
    return await step();
  } finally {
    chmodSync(dir, 0o755);
  }
};

/**
 * Host Docker and the namespace holder as the delivered Document Server answers them: `docker exec
 * dsh-team-documentserver sh …` runs the same sh locally with the store at `dir`, and the namespace
 * list reports the key while `dir` holds its directory, unless `answers` says otherwise. Every
 * docker argv and namespace script is recorded.
 */
function storeLane(dir: string, answers: Record<string, unknown>[] = []) {
  const calls: string[][] = [];
  const scripts: string[] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    const [verb, container, shell, ...rest] = args;
    if (verb !== 'exec' || container !== DOCUMENT_SERVER || (shell !== 'sh' && shell !== 'python3'))
      throw new Error('stand-in answers only sh and python3 in the Document Server');
    const local = rest.map((arg) => (arg === FORGOTTEN_DIR ? dir : arg));
    return (await promisify(execFile)(shell, local)).stdout;
  };
  const namespaceRead = (script: string) => {
    scripts.push(script);
    const held = readdirSync(dir).includes(KA);
    return Promise.resolve(answers.shift() ?? { status: 200, error: 0, listed: held });
  };
  return { calls, scripts, run, namespaceRead };
}
const answering = (output: string) => ({ run: () => Promise.resolve(output) });
const secretFree = (lane: ReturnType<typeof storeLane>) =>
  JSON.stringify([lane.calls, lane.scripts]);

it('counts the directories in the store through host Docker, never its files', async () => {
  const dir = store(KA, OTHER);
  writeFileSync(join(dir, 'stray'), 'not a copy');
  const lane = storeLane(dir);

  const count = await forgottenDirs(lane);

  expect(count).toBe(2);
  expect(lane.calls).toEqual([
    ['exec', DOCUMENT_SERVER, 'sh', '-c', expect.any(String), 'sh', FORGOTTEN_DIR],
  ]);
});

it('counts 0 while the started server has not yet created its forgotten directory', async () => {
  const files = join(ROOT, String(stores++), 'files');
  mkdirSync(files, { recursive: true });

  const count = await forgottenDirs(storeLane(join(files, 'forgotten')));

  expect(count).toBe(0);
});

it('fails loudly when the store parent is missing or the store is unreadable', async () => {
  const dir = store(KA);

  const missing = forgottenDirs(storeLane(join(ROOT, 'absent', 'files', 'forgotten')));
  const unreadable = sealed(dir, 0o000, () => forgottenDirs(storeLane(dir)));

  await expect(missing).rejects.toThrow();
  await expect(unreadable).rejects.toThrow();
});

it.each(['NaN\n', '\n', '-1\n', '1.5\n', '2 3\n'])(
  'rejects a store count %j that is not a non-negative integer',
  async (output) => {
    await expect(forgottenDirs(answering(output))).rejects.toThrow(
      'Document Server forgotten store count unreadable',
    );
  },
);

it("removes only the entry named by the key, reports the count and carries only the key's digest", async () => {
  const dir = store(KA, OTHER);
  const lane = storeLane(dir);

  const removed = await removeForgotten(lane, KA, '(cleanup)');
  const again = await removeForgotten(lane, KA, '(cleanup)');

  expect([removed, again]).toEqual([1, 0]);
  expect(readdirSync(dir)).toEqual([OTHER]);
  expect(secretFree(lane)).not.toContain(KA);
  expect(secretFree(lane)).toContain(createHash('sha256').update(KA).digest('hex'));
  expect(lane.calls.map((args) => args.at(-1))).toEqual([FORGOTTEN_DIR, FORGOTTEN_DIR]);
});

it('fails without the key or the store error text when the entry cannot be removed', async () => {
  const dir = store(KA);
  const lane = storeLane(dir);

  const error = (await sealed(dir, 0o555, () =>
    removeForgotten(lane, KA, '(cleanup)').catch((caught: unknown) => caught),
  )) as Error;

  expect(error.message).toContain('Office isolation (cleanup) failed');
  expect(everythingPrinted(error)).not.toContain(KA);
  expect(error.message).not.toMatch(/permission denied/i);
  expect(readdirSync(dir)).toEqual([KA]);
});

it('removes nothing while the started server has not yet created its forgotten directory', async () => {
  const files = join(ROOT, String(stores++), 'files');
  mkdirSync(files, { recursive: true });

  const removed = await removeForgotten(storeLane(join(files, 'forgotten')), KA, '(cleanup)');

  expect(removed).toBe(0);
});

it.each(['{"removed":"1"}', '{"removed":-1}', '{}'])(
  'rejects a removal report %s that is not a non-negative count',
  async (output) => {
    await expect(removeForgotten(answering(output), KA, '(cleanup)')).rejects.toThrow(
      'Document Server forgotten removal count unreadable',
    );
  },
);

/** Sets `path`'s mtime `seconds` into the past. */
const aged = (path: string, seconds: number) => {
  const at = Date.now() / 1000 - seconds;
  utimesSync(path, at, at);
};

it("describes each store entry oldest first by shape and age, carrying only the key's digest", async () => {
  const dir = store(KA, OTHER);
  writeFileSync(join(dir, KA, `${OTHER}.bin`), 'another key inside');
  writeFileSync(join(dir, 'stray'), 'not a copy');
  aged(join(dir, KA), 120);
  aged(join(dir, OTHER), 600);
  aged(join(dir, 'stray'), 5);
  const lane = storeLane(dir);

  const shape = await forgottenShape(lane, KA, '(shape)');

  // Oldest first: OTHER's copy, then KA's, then the stray file.
  const entry = { hex64: true, length: 64, dir: true };
  expect(shape).toEqual([
    { ...entry, matchesKey: false, files: ['output.docx'], ageSeconds: 600 },
    { ...entry, matchesKey: true, files: ['<hex64>.bin', 'output.docx'], ageSeconds: 120 },
    { hex64: false, length: 5, dir: false, matchesKey: false, files: [], ageSeconds: 5 },
  ]);
  for (const secret of [KA, OTHER]) {
    expect(JSON.stringify(shape)).not.toContain(secret);
    expect(secretFree(lane)).not.toContain(secret);
  }
  expect(secretFree(lane)).toContain(createHash('sha256').update(KA).digest('hex'));
  expect(lane.calls.map((args) => args.at(-1))).toEqual([FORGOTTEN_DIR]);
});

it('describes the store as empty before its first copy, and matches no key when none is known', async () => {
  const files = join(ROOT, String(stores++), 'files');
  mkdirSync(files, { recursive: true });
  const dir = store(KA);

  const absent = await forgottenShape(storeLane(join(files, 'forgotten')), KA, '(shape)');
  const unknown = await forgottenShape(storeLane(dir), null, '(shape)');

  expect(absent).toEqual([]);
  expect(unknown).toMatchObject([{ hex64: true, matchesKey: false, files: ['output.docx'] }]);
});

it('fails without the key or the reader error text when an entry cannot be read', async () => {
  const dir = store(KA);
  const lane = storeLane(dir);

  const error = (await sealed(join(dir, KA), 0o000, () =>
    forgottenShape(lane, KA, '(shape)').catch((caught: unknown) => caught),
  )) as Error;

  expect(error.message).toContain('Office isolation (shape) failed');
  expect(everythingPrinted(error)).not.toContain(KA);
  expect(error.message).not.toMatch(/traceback|permission/i);
});

it.each(['{}', '{"entries":{}}'])(
  'rejects a shape report %s that is not a list',
  async (output) => {
    await expect(forgottenShape(answering(output), KA, '(shape)')).rejects.toThrow(
      'Document Server forgotten store shape unreadable',
    );
  },
);

it('records the directory delta over the baseline and whether the list holds the key', async () => {
  const lane = storeLane(store(KA, OTHER));

  const copy = await forgottenCopy(lane, KA, 1, '(observe)');

  expect(copy).toEqual({ added: 1, listed: true });
  expect(secretFree(lane)).not.toContain(KA);
});

it('counts a <key>/output list entry as the key listed', async () => {
  const lane = storeLane(store(), [{ status: 200, error: 0, listed: false, contains: true }]);

  const copy = await forgottenCopy(lane, KA, 0, '(observe)');

  expect(copy).toEqual({ added: 0, listed: true });
});

it.each([
  ['a bad token', { status: 200, error: 6, listed: false }],
  ['a refusal', { status: 403, error: null, listed: false }],
  ['a script failure', { error: `connect ECONNREFUSED for ${KA}` }],
])('throws on %s from the list instead of reading it as not listed', async (_case, answer) => {
  const lane = storeLane(store(), [answer]);

  const error = (await forgottenCopy(lane, KA, 0, '(observe)').catch((e: unknown) => e)) as Error;

  expect(error.message).toContain('Document Server forgotten list (observe) unreadable');
  expect(everythingPrinted(error)).not.toContain(KA);
});

it('removes the copy it observed, returning the store to its baseline and the key unlisted', async () => {
  const dir = store(OTHER);
  const lane = storeLane(dir);
  mkdirSync(join(dir, KA));

  const record = await forgottenRecord(lane, KA, 1, '(rewrite)');

  expect(record).toEqual({ added: 1, listed: true, cleared: true });
  expect(readdirSync(dir)).toEqual([OTHER]);
});

it('records an absent copy as nothing added, not listed and cleared', async () => {
  const dir = store(OTHER);

  const record = await forgottenRecord(storeLane(dir), KA, 1, '(rewrite)');

  expect(record).toEqual({ added: 0, listed: false, cleared: true });
  expect(readdirSync(dir)).toEqual([OTHER]);
});

it('is not cleared when another copy keeps the store above its baseline', async () => {
  const dir = store(KA, OTHER);

  const record = await forgottenRecord(storeLane(dir), KA, 0, '(rewrite)');

  expect(record).toEqual({ added: 2, listed: true, cleared: false });
  expect(readdirSync(dir)).toEqual([OTHER]);
});

it('is not cleared when the copy landed after the store was counted', async () => {
  const dir = store();
  const lane = storeLane(dir);
  let landed = false;
  // The late close-time save lands once, between the count and the first list read.
  const namespaceRead = (script: string) => {
    if (!landed) mkdirSync(join(dir, KA));
    landed = true;
    return lane.namespaceRead(script);
  };
  const landing = { ...lane, namespaceRead };

  const record = await forgottenRecord(landing, KA, 0, '(rewrite)');

  expect(record).toEqual({ added: 0, listed: true, cleared: false });
  expect(readdirSync(dir)).toEqual([]);
});

it('is not cleared when the list still holds the key after the removal', async () => {
  const listed = { status: 200, error: 0, listed: true };
  const lane = storeLane(store(KA), [listed, listed]);

  const record = await forgottenRecord(lane, KA, 0, '(rewrite)');

  expect(record).toEqual({ added: 1, listed: true, cleared: false });
});

it("removes a known key's copy after the settle window and rethrows the same error", async () => {
  const dir = store(KA, OTHER);
  const lane = storeLane(dir);
  const original = new Error('case failed after its key was read');
  const started = performance.now();

  const caught = await clearingForgottenOnError(
    lane,
    '(failed case)',
    (held) => {
      held.key = KA;
      return Promise.reject(original);
    },
    40,
  ).catch((error: unknown) => error);

  expect(caught).toBe(original);
  expect(caught).toHaveProperty('message', 'case failed after its key was read');
  expect(performance.now() - started).toBeGreaterThanOrEqual(40);
  expect(readdirSync(dir)).toEqual([OTHER]);
  expect(everythingPrinted(caught)).not.toContain(KA);
  expect(secretFree(lane)).not.toContain(KA);
});

it('rethrows the original error unchanged when the best-effort cleanup fails', async () => {
  const original = new Error('case failed');
  const lane = { run: () => Promise.reject(new Error(`docker exec failed for ${KA}`)) };

  const caught = await clearingForgottenOnError(
    lane,
    '(failed case)',
    (held) => {
      held.key = KA;
      return Promise.reject(original);
    },
    0,
  ).catch((error: unknown) => error);

  expect(caught).toBe(original);
  expect(caught).not.toBeInstanceOf(AggregateError);
  expect(everythingPrinted(caught)).not.toContain(KA);
});

it('neither waits nor touches the store when the case failed before its key was known', async () => {
  const lane = storeLane(store(KA));
  const original = new Error('browser failed before the key');

  // A settle window longer than the test timeout: waiting at all would time the test out.
  const caught = await clearingForgottenOnError(
    lane,
    '(failed case)',
    () => Promise.reject(original),
    60_000,
  ).catch((error: unknown) => error);

  expect(caught).toBe(original);
  expect(lane.calls).toEqual([]);
});

it('returns the case evidence and leaves the store to the case on success', async () => {
  const lane = storeLane(store(KA));

  const evidence = await clearingForgottenOnError(
    lane,
    '(case)',
    (held) => {
      held.key = KA;
      return Promise.resolve('evidence');
    },
    60_000,
  );

  expect(evidence).toBe('evidence');
  expect(lane.calls).toEqual([]);
});

it('treats a <key>/output entry as present via contains, and a 403 or empty list as absent', () => {
  expect(forgottenPresent({ status: 200, listed: true, contains: false })).toBe(true);
  expect(forgottenPresent({ status: 200, listed: false, contains: true })).toBe(true);
  expect(forgottenPresent({ status: 200, listed: false, contains: false })).toBe(false);
  expect(forgottenPresent({ status: 403, listed: true, contains: true })).toBe(false);
});

/** A's registry query answering `replies` in turn; each call's argv goes to `calls`. */
const registryLane = (calls: (readonly string[])[], ...replies: (() => Promise<string>)[]) => ({
  exec: (args: readonly string[]) => {
    calls.push(args);
    return (replies.shift() ?? (() => Promise.reject(new Error('no reply'))))();
  },
});
const FILE = '/data/work/忘记恢复.docx';
const FORGOTTEN_ARGV = ['python3', '-I', '-c', REGISTRY, FILE];

it("polls A's registry until it names the DOCX and returns the first of its keys", async () => {
  const calls: (readonly string[])[] = [];
  const replies = [() => Promise.resolve('[]'), () => Promise.resolve(JSON.stringify([KA, hex()]))];

  const key = await registeredKey(registryLane(calls, ...replies), FILE);

  expect(key).toBe(KA);
  expect(calls.map((args) => args.filter((_, i) => i !== 3))).toEqual([
    FORGOTTEN_ARGV,
    FORGOTTEN_ARGV,
  ]);
});

it('fails with the registry query rejection instead of polling it as no key', async () => {
  const calls: (readonly string[])[] = [];
  const refused = () => Promise.reject(new Error('registry format mismatch: version'));
  // A caller that counted the failure as no key would poll again and return KA.
  const lane = registryLane(calls, refused, () => Promise.resolve(JSON.stringify([KA])));

  const key = registeredKey(lane, FILE);

  await expect(key).rejects.toThrow(new Error('registry format mismatch: version'));
  expect(calls).toHaveLength(1);
});
