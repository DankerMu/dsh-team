export const MIN_DOCKER_MEM_TOTAL = 15_032_385_536;
export const EXPECTED_RAGFLOW_VERSION = 'v1.0.0-rc2';
export const STACK_CONFIG_RELATIVE_PATH = '.config/dsh-team/stack.json';

const KEYS = ['ragflowUrl', 'ragflowApiKey', 'embeddingApiKey'];
const DOCKER_UNAVAILABLE = 'local Docker daemon unavailable';

/**
 * @typedef {{present: false} | {present: true, value: unknown} | 'invalid'} ConfigFact
 * @typedef {{status: number | null, stdout: string}} DockerInfoFact
 * @typedef {{status: number, body: string} | 'unreachable'} VersionFact
 * @typedef {{
 *   dockerHost?: string | undefined, dockerContext?: string | undefined,
 *   platform: string, arch: string,
 *   config?: ConfigFact, dockerInfo?: DockerInfoFact, version?: VersionFact,
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
 * Ordered ①→⑤; the first failure wins. An absent later fact yields `ok: undefined` so the caller
 * gathers it only after every earlier prerequisite passed. Reasons never carry configuration.
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
  if (facts.dockerInfo === undefined) return { ok: undefined, ragflowUrl };
  const docker = dockerFailure(facts.dockerInfo);
  if (docker !== undefined) return { ok: false, reason: docker };
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
