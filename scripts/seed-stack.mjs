/** Local RAGFlow test-stack seed: fixed small datasets, list before write, no delete path. */
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPrivateJsonFile } from './docker-proxy-environment.mjs';
import {
  STACK_CONFIG_RELATIVE_PATH,
  assessSeedPrerequisites,
} from './test-stack-prerequisites.mjs';
import { probeRagflowVersion } from './test-stack.mjs';

/** Directory names under `scripts/seed-stack/`; 10.3 checks these names for readable seed data. */
export const SEED_DATASETS = [
  { name: 'dsh-team-seed-policies', files: ['attendance-policy.txt', 'expense-policy.txt'] },
  { name: 'dsh-team-seed-products', files: ['product-catalog.txt', 'after-sales-terms.txt'] },
  { name: 'dsh-team-seed-minutes', files: ['weekly-minutes-01.txt', 'weekly-minutes-02.txt'] },
];

const BODY_LIMIT = 1_048_576;
const PAGE_SIZE = 100;
const POLL_INTERVAL = 2000;
const SEED_ROOT = new URL('./seed-stack/', import.meta.url);
// RAGFlow's text run states, indexed by their numeric synonyms 0..5.
const RUN_STATES = ['UNSTART', 'RUNNING', 'CANCEL', 'DONE', 'FAIL', 'SCHEDULE'];
const PARSEABLE = ['UNSTART', 'FAIL', 'CANCEL'];

/**
 * @typedef {import('./test-stack-prerequisites.mjs').ConfiguredStack} Stack
 * @typedef {import('./test-stack-prerequisites.mjs').SeedAssessment} SeedAssessment
 * @typedef {{id: string, name: string} & Record<string, unknown>} DatasetItem
 * @typedef {{id: string, name: string, run: string}} DocumentItem
 * @typedef {{name: string, files: string[]}} SeedDataset
 * @typedef {{
 *   argv: string[], home: string, uid: number,
 *   sleep: (ms: number) => Promise<void>, now: () => number, parseDeadline: number,
 *   stdout: (text: string) => void, stderr: (text: string) => void,
 * }} SeedRun
 * @typedef {{method?: string, json?: unknown, form?: FormData}} CallRequest
 */

/** Its message is the complete fixed stderr line; it never carries an address, key, id or body. */
class SeedFailure extends Error {}

/** @param {string} text */
const fail = (text) => new SeedFailure(`seed:stack failed: ${text}`);
/** @param {string} op */
const malformed = (op) => fail(`RAGFlow ${op} response malformed`);

/** @param {unknown} value @returns {Record<string, unknown> | undefined} */
function record(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {Response} response @param {string} op */
async function readBounded(response, op) {
  const reader = response.body?.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let size = 0;
  for (let chunk = await reader?.read(); chunk?.done === false; chunk = await reader?.read()) {
    size += chunk.value.length;
    if (size > BODY_LIMIT) {
      await reader?.cancel();
      throw malformed(op);
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** @param {Stack} stack @param {string} op @param {string} path @param {CallRequest} request */
async function send(stack, op, path, { method = 'GET', json, form }) {
  try {
    const response = await fetch(`${stack.ragflowUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${stack.ragflowApiKey}`,
        ...(json === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: form ?? (json === undefined ? undefined : JSON.stringify(json)),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw fail('RAGFlow rejected the configured key');
    }
    return { status: response.status, body: await readBounded(response, op) };
  } catch (error) {
    // Transport errors may name the address; only the fixed operation line survives.
    if (error instanceof SeedFailure) throw error;
    throw fail(`RAGFlow ${op} request unreachable`);
  }
}

/**
 * HTTP status and body `code` are judged separately: only HTTP 200 with `code === 0` succeeds.
 * @param {Stack} stack @param {string} op @param {string} path @param {CallRequest} [request]
 * @returns {Promise<unknown>} the success `data`
 */
async function call(stack, op, path, request = {}) {
  const { status, body } = await send(stack, op, path, request);
  let document;
  try {
    document = record(JSON.parse(body));
  } catch {
    document = undefined;
  }
  if (status !== 200 || (document !== undefined && document.code !== 0)) {
    const code = Number.isSafeInteger(document?.code) ? String(document?.code) : 'none';
    throw fail(`RAGFlow ${op} request failed (HTTP ${String(status)}, code ${code})`);
  }
  if (document === undefined) throw malformed(op);
  return document.data;
}

/** @param {unknown} value @returns {string | undefined} */
function runState(value) {
  if (typeof value === 'string' && RUN_STATES.includes(value)) return value;
  const index = typeof value === 'string' && /^[0-5]$/.test(value) ? Number(value) : value;
  return typeof index === 'number' && Number.isInteger(index) ? RUN_STATES[index] : undefined;
}

/** @param {unknown} data @param {string} op @returns {DocumentItem[]} */
function documentList(data, op) {
  if (!Array.isArray(data)) throw malformed(op);
  return data.map((value) => {
    const item = record(value);
    const run = runState(item?.run);
    if (typeof item?.id !== 'string' || typeof item.name !== 'string' || run === undefined)
      throw malformed(op);
    return { id: item.id, name: item.name, run };
  });
}

/** @param {Stack} stack @param {string} query @returns {Promise<DatasetItem[]>} */
async function listDatasets(stack, query) {
  const data = await call(stack, 'list datasets', `/api/v1/datasets?${query}`);
  if (!Array.isArray(data)) throw malformed('list datasets');
  return data.map((value) => {
    const item = record(value);
    if (typeof item?.id !== 'string' || typeof item.name !== 'string')
      throw malformed('list datasets');
    return /** @type {DatasetItem} */ (item);
  });
}

/** @param {Stack} stack @param {string} base */
async function listDocuments(stack, base) {
  const data = record(await call(stack, 'list documents', `${base}/documents?page_size=100`));
  return documentList(data?.docs, 'list documents');
}

/**
 * Exact-name match after rejecting case-only lookalikes: RAGFlow folds case and suffixes repeats.
 * @template {{name: string}} T
 * @param {T[]} items @param {string} name @param {string} collides @param {string} repeated
 * @returns {T | undefined}
 */
function exactlyNamed(items, name, collides, repeated) {
  const folded = name.toLowerCase();
  if (items.some((item) => item.name !== name && item.name.toLowerCase() === folded))
    throw fail(collides);
  const matches = items.filter((item) => item.name === name);
  if (matches.length > 1) throw fail(repeated);
  return matches[0];
}

/** @param {DatasetItem[]} listed @param {string} name */
const namedDataset = (listed, name) =>
  exactlyNamed(
    listed,
    name,
    `dataset ${name} collides with an existing name`,
    `dataset ${name} is ambiguous`,
  );

/** @param {Stack} stack @param {string} name @returns {Promise<DatasetItem>} */
async function createDataset(stack, name) {
  const json = { name };
  const data = record(
    await call(stack, 'create dataset', '/api/v1/datasets', { method: 'POST', json }),
  );
  if (typeof data?.id !== 'string' || typeof data.name !== 'string')
    throw malformed('create dataset');
  if (data.name !== name) throw fail(`dataset ${name} was created as a different name`);
  return /** @type {DatasetItem} */ (data);
}

/** @param {Stack} stack @param {string} base @param {string} name @param {string[]} files */
async function upload(stack, base, name, files) {
  const form = new FormData();
  for (const file of files) {
    const bytes = readFileSync(new URL(`${name}/${file}`, SEED_ROOT));
    form.append('file', new Blob([bytes], { type: 'text/plain' }), file);
  }
  const data = await call(stack, 'upload documents', `${base}/documents`, { method: 'POST', form });
  const uploaded = documentList(data, 'upload documents');
  const names = uploaded.map((item) => item.name).sort();
  if (names.join('/') !== [...files].sort().join('/')) throw malformed('upload documents');
  return uploaded;
}

/**
 * Waits until every seed document is DONE; FAIL/CANCEL while polling are terminal.
 * @param {Stack} stack @param {SeedRun} options @param {number} start @param {string} base
 * @param {SeedDataset} seed @param {DocumentItem[]} documents
 */
async function settle(stack, options, start, base, seed, documents) {
  if (documents.every((item) => item.run === 'DONE')) return;
  for (;;) {
    await options.sleep(POLL_INTERVAL);
    const listed = await listDocuments(stack, base);
    const states = documents.map(({ id }) => listed.find((item) => item.id === id)?.run);
    for (const [index, state] of states.entries()) {
      const target = `${seed.name}/${String(seed.files[index])}`;
      if (state === undefined) throw malformed('list documents');
      if (state === 'FAIL') throw fail(`parsing failed for ${target}`);
      if (state === 'CANCEL') throw fail(`parsing was cancelled for ${target}`);
    }
    if (states.every((state) => state === 'DONE')) return;
    if (options.now() - start > options.parseDeadline)
      throw fail('parsing did not finish within 600s');
  }
}

/** @param {Stack} stack @param {string} id */
async function datasetSummary(stack, id) {
  const [item, ...rest] = await listDatasets(
    stack,
    `id=${encodeURIComponent(id)}&include_parsing_status=true`,
  );
  const counts = ['document_count', 'chunk_count', 'done_count', 'fail_count'].map(
    (key) => item?.[key],
  );
  const model = item?.embedding_model;
  if (item?.id !== id || rest.length > 0 || typeof model !== 'string' || model === '')
    throw malformed('list datasets');
  if (!counts.every((count) => Number.isSafeInteger(count))) throw malformed('list datasets');
  const [documents, chunks, done, failed] = counts.map(String);
  return `documents ${documents}; chunks ${chunks}; done ${done}; failed ${failed}; embedding ${model}`;
}

/** @param {DocumentItem[]} listed @param {SeedDataset} seed */
const presentDocuments = (listed, { name, files }) =>
  files.map((file) =>
    exactlyNamed(
      listed,
      file,
      `document ${file} in ${name} collides with an existing name`,
      `document ${file} in ${name} is duplicated`,
    ),
  );

/**
 * @param {Stack} stack @param {SeedRun} options @param {number} start
 * @param {DatasetItem[]} listed @param {SeedDataset} seed
 * @returns {Promise<string>} the dataset's stdout line
 */
async function seedDataset(stack, options, start, listed, seed) {
  const existing = namedDataset(listed, seed.name);
  const dataset = existing ?? (await createDataset(stack, seed.name));
  if (typeof dataset.embedding_model !== 'string' || dataset.embedding_model === '')
    throw fail(
      `dataset ${seed.name} has no embedding model; set the tenant default in the RAGFlow UI`,
    );
  const base = `/api/v1/datasets/${encodeURIComponent(dataset.id)}`;
  const docs = await listDocuments(stack, base);
  if (docs.length >= PAGE_SIZE) throw fail('RAGFlow list documents listing is full');
  const present = presentDocuments(docs, seed);
  const missing = seed.files.filter((_file, index) => present[index] === undefined);
  const uploaded = missing.length === 0 ? [] : await upload(stack, base, seed.name, missing);
  const documents = seed.files.map(
    (file, index) =>
      present[index] ?? /** @type {DocumentItem} */ (uploaded.find((item) => item.name === file)),
  );
  // DONE never enters a parse request; RUNNING/SCHEDULE are only awaited.
  const parse = documents.filter((item) => PARSEABLE.includes(item.run)).map((item) => item.id);
  if (parse.length > 0) {
    const json = { document_ids: parse };
    await call(stack, 'parse documents', `${base}/chunks`, { method: 'POST', json });
  }
  await settle(stack, options, start, base, seed, documents);
  const counts = await datasetSummary(stack, dataset.id);
  const state = existing === undefined ? 'created' : 'existing';
  return `${seed.name}: ${state}; uploaded ${String(missing.length)}; parsed ${String(parse.length)}; ${counts}\n`;
}

/** @param {SeedAssessment} assessment @returns {Stack} */
function admitted(assessment) {
  if (assessment.ok === false)
    throw new SeedFailure(`seed:stack prerequisite failed: ${assessment.reason}`);
  return assessment.stack;
}

/** @param {SeedRun} options */
async function seed(options) {
  if (options.argv.length > 1)
    throw new SeedFailure('seed:stack usage: pnpm seed:stack [<ragflowUrl>]');
  /** @type {import('./test-stack-prerequisites.mjs').ConfigFact} */
  let config;
  try {
    config = readPrivateJsonFile(join(options.home, STACK_CONFIG_RELATIVE_PATH), options.uid);
  } catch {
    config = 'invalid';
  }
  const configured = admitted(assessSeedPrerequisites({ config }));
  const [address] = options.argv;
  // Before any network request, the version probe included.
  if (address !== undefined && address.replace(/\/$/, '') !== configured.ragflowUrl)
    throw new SeedFailure('seed:stack refused: address does not match the private configuration');
  const version = await probeRagflowVersion(configured.ragflowUrl);
  const stack = admitted(assessSeedPrerequisites({ config, version }));
  const start = options.now();
  // One unfiltered listing: `?name=` answers code 102 for an absent dataset.
  const listed = await listDatasets(stack, 'page_size=100&include_parsing_status=true');
  if (listed.length >= PAGE_SIZE) throw fail('RAGFlow list datasets listing is full');
  for (const { name } of SEED_DATASETS) namedDataset(listed, name);
  for (const dataset of SEED_DATASETS)
    options.stdout(await seedDataset(stack, options, start, listed, dataset));
}

/**
 * @param {SeedRun} options
 * @returns {Promise<number>} process exit status
 */
export async function runSeedStack(options) {
  try {
    await seed(options);
  } catch (error) {
    if (!(error instanceof SeedFailure)) throw error;
    options.stderr(`${error.message}\n`);
    return 1;
  }
  options.stdout('seed:stack complete\n');
  return 0;
}

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runSeedStack({
    argv: process.argv.slice(2),
    home: homedir(),
    uid: process.getuid?.() ?? -1,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    now: () => performance.now(),
    parseDeadline: 600_000,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
