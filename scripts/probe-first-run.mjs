#!/usr/bin/env node
/** First-run UI observation, discovery, and mapped-host acceptance. */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import {
  errorCode,
  FIRST_RUN_HOST,
  observeFirstRun,
  remainingMs,
  setupFirstRun,
  waitFor,
} from './probe-dsh-api-ui.mjs';
import { prepareComposition } from './probe-first-run-composition.mjs';
import {
  acceptObservation,
  closeMapped,
  collectObservation,
  exchangeLaunchToken,
  mappedFlags,
  navigateReady,
  openMappedPage,
} from './probe-mapped-host.mjs';

const out = (line) => process.stdout.write(`${line}\n`);
const fail = (message, code = 1) => {
  process.stderr.write(`probe-first-run: ${message}\n`);
  process.exitCode = code;
  throw Object.assign(new Error(message), { code, probeFail: true });
};
const env = (name) => {
  const value = process.env[name];
  if (!value) fail(`${name} is missing`, 2);
  return value;
};
const optionalEnv = (name) => process.env[name] ?? '';
const readSecret = async (name) => (await readFile(env(name), 'utf8')).trim();

const chromeOptions = () => ({
  chromeBin: env('CHROME_BIN'),
  profile: env('PROBE_PROFILE'),
  pidFile: env('PROBE_PID_FILE'),
});

const exchange = async () => {
  const host = env('PROBE_HOST');
  const port = Number(env('PROBE_PORT'));
  const token = await readSecret('PROBE_TOKEN_FILE');
  const cookieHost = optionalEnv('PROBE_COOKIE_HOST') || host;
  try {
    process.stdout.write(await exchangeLaunchToken({ host, port, token, cookieHost }));
  } catch (error) {
    fail(error?.message ?? 'token exchange failed', 1);
  }
};

const observe = async () => {
  const port = Number(env('PROBE_PORT'));
  const cookie = await readSecret('PROBE_COOKIE_FILE');
  const origin = `http://${FIRST_RUN_HOST}:${port}`;
  const result = await collectObservation({
    origin,
    cookie,
    extraFlags: mappedFlags(FIRST_RUN_HOST),
    screenshot: env('PROBE_SCREENSHOT'),
    browserMs: Number(env('PROBE_BROWSER_SECONDS')) * 1000,
    ...chromeOptions(),
  });
  if (result.initialized === false) fail('stage=initialization error=unknown', 2);
  out(JSON.stringify({ mode: 'observe', ...result }));
};

const discover = async () => {
  const port = Number(env('PROBE_PORT'));
  const cookie = await readSecret('PROBE_COOKIE_FILE');
  const origin = `http://${FIRST_RUN_HOST}:${port}`;
  const home = env('PROBE_HOME');
  const beforeRoot = env('PROBE_DISCOVER_BEFORE');
  const afterRoot = env('PROBE_DISCOVER_AFTER');
  const browserMs = Number(env('PROBE_BROWSER_SECONDS')) * 1000;
  const extraFlags = mappedFlags(FIRST_RUN_HOST);
  const { chrome, page } = await openMappedPage({
    origin,
    cookie,
    extraFlags,
    ...chromeOptions(),
  });
  try {
    await navigateReady(page, origin, browserMs);
    await setupFirstRun(page, Date.now() + browserMs);
    await waitFor(
      async () => {
        const state = await observeFirstRun(page);
        return state.editable ? state : null;
      },
      remainingMs(Date.now() + browserMs, 'discover-composer'),
      'discover-composer',
    );
  } finally {
    await closeMapped(page, chrome);
  }
  out(
    JSON.stringify({
      mode: 'discover',
      before: relative(home, beforeRoot) || beforeRoot,
      after: relative(home, afterRoot) || afterRoot,
      hostname: FIRST_RUN_HOST,
    }),
  );
};

const accept = async () => {
  const port = Number(env('PROBE_PORT'));
  const cookie = await readSecret('PROBE_COOKIE_FILE');
  const origin = `http://${FIRST_RUN_HOST}:${port}`;
  const result = await acceptObservation({
    origin,
    cookie,
    extraFlags: mappedFlags(FIRST_RUN_HOST),
    screenshot: env('PROBE_SCREENSHOT'),
    browserMs: Number(env('PROBE_BROWSER_SECONDS')) * 1000,
    composition: command === 'accept-composition',
    preserveModels: optionalEnv('PROBE_COMPOSITION_PRESERVE_MODELS') || undefined,
    expectedDefault: optionalEnv('PROBE_COMPOSITION_DEFAULT_MODEL') || undefined,
    ...chromeOptions(),
  });
  out(JSON.stringify({ mode: 'accept', ...result }));
};

const walkFiles = async (root) => {
  const files = [];
  const visit = async (dir, depth = 0) => {
    if (depth > 5 || files.length > 256) throw new Error('snapshot-discovery-bound');
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await visit(full, depth + 1);
      else if (entry.isFile()) files.push(full);
    }
  };
  await visit(root);
  return files;
};

const copyFile = async (from, to) => {
  await mkdir(dirname(to), { recursive: true });
  await writeFile(to, await readFile(from));
};

const diffHomes = async () => {
  const beforeRoot = env('PROBE_DISCOVER_BEFORE');
  const afterRoot = env('PROBE_DISCOVER_AFTER');
  const outDir = env('PROBE_DISCOVER_OUT');
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const before = new Map();
  for (const file of await walkFiles(beforeRoot)) {
    before.set(relative(beforeRoot, file), await readFile(file));
  }
  const copied = [];
  for (const file of await walkFiles(afterRoot)) {
    const rel = relative(afterRoot, file);
    const previous = before.get(rel);
    const next = await readFile(file);
    if (!previous || !previous.equals(next)) {
      if (rel === 'cordis.patch.yml' || rel.startsWith('storages/')) {
        await copyFile(file, join(outDir, rel));
        copied.push(rel);
      }
    }
  }
  out(JSON.stringify({ mode: 'diff-home', copied }));
};

const workspaceStateShape = (value) =>
  typeof value?.initialized === 'boolean' && Array.isArray(value.workspaceIds);

const workspaceRecordShape = (value) =>
  typeof value?.path === 'string' &&
  typeof value?.title === 'string' &&
  Array.isArray(value?.sessionIds) &&
  typeof value?.createdAt === 'string' &&
  typeof value?.updatedAt === 'string';

const hasWorkspaceData = (value) => {
  if (!value || typeof value !== 'object') return false;
  if (workspaceStateShape(value) || workspaceRecordShape(value)) return true;
  return Object.values(value).some(hasWorkspaceData);
};

const hasCredentialFields = (value) => {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, item]) =>
      /token|cookie|password|secret|credential|api.?key/i.test(key) || hasCredentialFields(item),
  );
};

const containsWorkRecord = (value) => {
  if (!value || typeof value !== 'object') return false;
  if (workspaceRecordShape(value)) return value.path === '/data/work';
  return Object.values(value).some(containsWorkRecord);
};

const snapshotHome = async () => {
  const root = env('PROBE_HOME');
  const target = env('PROBE_SNAPSHOT');
  const files = await walkFiles(join(root, 'storages'));
  if (files.length > 256) throw new Error('snapshot-file-bound');
  let workBound = false;
  for (const file of files) {
    const bytes = await readFile(file);
    if (bytes.length > 1_048_576) throw new Error('snapshot-byte-bound');
    let value;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      continue;
    }
    if (hasWorkspaceData(value) && !hasCredentialFields(value)) {
      await copyFile(file, join(target, relative(root, file)));
      if (containsWorkRecord(value)) workBound = true;
    }
  }
  await writeFile(
    join(target, 'workspace-evidence.json'),
    JSON.stringify({ available: true, workBound }),
  );
};

const command = process.argv[2];
const run = async () => {
  if (command === 'exchange') await exchange();
  else if (command === 'observe') await observe();
  else if (command === 'discover') await discover();
  else if (command === 'accept' || command === 'accept-composition') await accept();
  else if (command === 'diff-home') await diffHomes();
  else if (command === 'snapshot-home') await snapshotHome();
  else if (command === 'prepare-composition') {
    out(
      JSON.stringify(
        await prepareComposition({
          home: env('PROBE_HOME'),
          seed: env('PROBE_DISCOVER_OUT'),
          pluginDir: env('PROBE_PLUGIN_DIR'),
          overlay: env('PROBE_COMPOSITION_OVERLAY'),
          fault: optionalEnv('PROBE_COMPOSITION_FAULT'),
          extraPatch: optionalEnv('PROBE_COMPOSITION_EXTRA_PATCH'),
        }),
      ),
    );
  } else
    fail(
      'usage: probe-first-run.mjs exchange|observe|discover|accept|accept-composition|prepare-composition|diff-home|snapshot-home',
      2,
    );
};
run().catch((error) => {
  if (!error?.probeFail) {
    process.stderr.write(`probe-first-run: ${errorCode(error)}\n`);
    process.exitCode ||=
      command === 'accept-composition' || command === 'prepare-composition' ? 2 : 1;
  }
});
