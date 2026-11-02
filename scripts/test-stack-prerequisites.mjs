export const MIN_DOCKER_MEM_TOTAL = 15_032_385_536;
export const EXPECTED_RAGFLOW_VERSION = 'v1.0.0-rc2';
export const STACK_CONFIG_RELATIVE_PATH = '.config/dsh-team/stack.json';

const KEYS = ['ragflowUrl', 'ragflowApiKey', 'embeddingApiKey'];
const DOCKER_UNAVAILABLE = 'local Docker daemon unavailable';
// The delivered compose file needs endpoint `gw_priority` (AGENTS.md Compose deployment).
const MIN_COMPOSE_VERSION = [2, 33, 1];

/**
 * @typedef {{present: false} | {present: true, value: unknown} | 'invalid'} ConfigFact
 * @typedef {{status: number | null, stdout: string}} DockerInfoFact
 * @typedef {{status: number, body: string} | 'unreachable'} VersionFact
 * @typedef {{
 *   dockerHost?: string | undefined, dockerContext?: string | undefined,
 *   platform: string, arch: string,
 *   config?: ConfigFact, dockerInfo?: DockerInfoFact,
 *   compose?: DockerInfoFact, buildx?: DockerInfoFact, python?: boolean,
 *   version?: VersionFact,
 * }} StackFacts
 * @typedef {{ok: false, reason: string} | {ok: true, ragflowUrl: string}
 *   | {ok: undefined, ragflowUrl?: string}} StackAssessment
 * @typedef {{ragflowUrl: string, ragflowApiKey: string}} ConfiguredStack
 * @typedef {{config: ConfigFact, version?: VersionFact}} SeedFacts
 * @typedef {{ok: false, reason: string} | {ok: true, stack: ConfiguredStack}
 *   | {ok: undefined, stack: ConfiguredStack}} SeedAssessment
 */

/** @param {unknown} value @returns {Record<string, unknown> | undefined} */
function record(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * A literal loopback origin only: no resolver-dependent name, credentials, query or path.
 * @param {ConfigFact} config
 * @returns {ConfiguredStack | undefined} the origin without a trailing slash, and the RAGFlow key
 */
export function configuredStack(config) {
  const value = config === 'invalid' || !config.present ? undefined : record(config.value);
  if (value === undefined || Object.keys(value).length !== KEYS.length) return undefined;
  const fields = KEYS.map((key) => value[key]);
  if (!fields.every((field) => typeof field === 'string' && field !== '' && !/\p{Cc}/u.test(field)))
    return undefined;
  const url = String(value.ragflowUrl);
  if (!/^https?:\/\/(?:127\.0\.0\.1|\[::1\])(?::\d{1,5})?\/?$/.test(url) || !URL.canParse(url))
    return undefined;
  return { ragflowUrl: url.replace(/\/$/, ''), ragflowApiKey: String(value.ragflowApiKey) };
}

/** @param {DockerInfoFact} info @returns {string | undefined} */
function dockerFailure(info) {
  let document;
  try {
    document = info.status === 0 ? record(JSON.parse(info.stdout)) : undefined;
  } catch {
    document = undefined;
  }
  if (document?.OSType !== 'linux' || typeof document.MemTotal !== 'number')
    return DOCKER_UNAVAILABLE;
  return document.MemTotal < MIN_DOCKER_MEM_TOTAL ? 'docker info MemTotal below 14 GiB' : undefined;
}

/** @param {DockerInfoFact} compose */
function composeSupported(compose) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][\x21-\x7e]*)?\r?\n?$/.exec(compose.stdout);
  if (compose.status !== 0 || match === null) return false;
  const version = match.slice(1).map(Number);
  const index = version.findIndex((part, position) => part !== MIN_COMPOSE_VERSION[position]);
  return index === -1 || (version[index] ?? 0) > (MIN_COMPOSE_VERSION[index] ?? 0);
}

/**
 * ④ `docker info`, then the builder and locking tools the local lane needs, before RAGFlow.
 * @param {StackFacts} facts
 * @returns {{ok: false, reason: string} | {ok: undefined} | undefined}
 */
function localFailure(facts) {
  if (facts.dockerInfo === undefined) return { ok: undefined };
  const docker = dockerFailure(facts.dockerInfo);
  if (docker !== undefined) return { ok: false, reason: docker };
  if (facts.compose === undefined) return { ok: undefined };
  if (!composeSupported(facts.compose))
    return { ok: false, reason: 'docker compose 2.33.1 or newer required' };
  if (facts.buildx === undefined) return { ok: undefined };
  if (facts.buildx.status !== 0) return { ok: false, reason: 'docker buildx unavailable' };
  if (facts.platform !== 'darwin') return undefined;
  if (facts.python === undefined) return { ok: undefined };
  return facts.python ? undefined : { ok: false, reason: '/usr/bin/python3 with fcntl required' };
}

/** @param {VersionFact} version @returns {string | undefined} */
function versionFailure(version) {
  if (version === 'unreachable' || version.status !== 200) return 'RAGFlow test stack unreachable';
  let document;
  try {
    document = record(JSON.parse(version.body));
  } catch {
    document = undefined;
  }
  const data = document?.data;
  if (document?.code !== 0 || typeof data !== 'string')
    return 'RAGFlow test stack version response malformed';
  if (data === EXPECTED_RAGFLOW_VERSION) return undefined;
  const shown = /^[\x21-\x7e]{1,64}$/.test(data) ? data : 'unparseable';
  return `RAGFlow test stack version is ${shown}, expected ${EXPECTED_RAGFLOW_VERSION}`;
}

/**
 * Ordered ①→④, compose/buildx/python3, then ⑤; the first failure wins. An absent later fact
 * yields `ok: undefined` so the caller gathers it only after every earlier prerequisite passed.
 * Reasons never carry configuration.
 * @param {StackFacts} facts
 * @returns {StackAssessment}
 */
export function assessStackPrerequisites(facts) {
  if (facts.dockerHost || facts.dockerContext)
    return { ok: false, reason: 'local default Docker daemon required' };
  if (facts.platform !== 'darwin' || facts.arch !== 'arm64')
    return { ok: false, reason: 'macOS arm64 host required' };
  if (facts.config === undefined) return { ok: undefined };
  if (facts.config !== 'invalid' && !facts.config.present)
    return { ok: false, reason: 'private configuration missing' };
  const ragflowUrl = configuredStack(facts.config)?.ragflowUrl;
  if (ragflowUrl === undefined) return { ok: false, reason: 'private configuration invalid' };
  const local = localFailure(facts);
  if (local?.ok === false) return local;
  if (local !== undefined) return { ok: undefined, ragflowUrl };
  if (facts.version === undefined) return { ok: undefined, ragflowUrl };
  const version = versionFailure(facts.version);
  return version === undefined ? { ok: true, ragflowUrl } : { ok: false, reason: version };
}

/**
 * The seed entry creates no Docker resource: only ③ configuration and ⑤ version apply, with the
 * same reasons as `assessStackPrerequisites`. Reasons never carry configuration.
 * @param {SeedFacts} facts
 * @returns {SeedAssessment}
 */
export function assessSeedPrerequisites(facts) {
  if (facts.config !== 'invalid' && !facts.config.present)
    return { ok: false, reason: 'private configuration missing' };
  const stack = configuredStack(facts.config);
  if (stack === undefined) return { ok: false, reason: 'private configuration invalid' };
  if (facts.version === undefined) return { ok: undefined, stack };
  const version = versionFailure(facts.version);
  return version === undefined ? { ok: true, stack } : { ok: false, reason: version };
}
