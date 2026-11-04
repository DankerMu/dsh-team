// @ts-check
/**
 * Host half of the knowledge-base plugin. In 15.1 it only validates the platform address the
 * managed overlay may give it; reading the instance token and registering routes belong to 15.2.
 */
export const name = 'dsh-team-knowledge-base';

// Fixed text: a rejected config is never echoed (it is overlay-written, but may be tampered with).
const REJECTED =
  'knowledge-base config must be absent or exactly { platformUrl: "http://<instance +3 IPv4>:<port>" }';
const ADDRESS = /^http:\/\/([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3}):([0-9]{1,5})$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;

/**
 * `http://<canonical dotted IPv4>:<port>` with the instance bridge's +3 last octet (the same
 * modulo-16 rule the generator applies to +2), a canonical port 1..65535 and nothing else.
 * @param {unknown} value
 */
function platformAddress(value) {
  const match = typeof value === 'string' ? ADDRESS.exec(value) : null;
  if (match === null) return false;
  const [octets, port] = [match.slice(1, 5), match[5] ?? ''];
  if (!octets.every((octet) => DECIMAL.test(octet) && Number(octet) <= 255)) return false;
  if (Number(octets[3]) % 16 !== 3) return false;
  return DECIMAL.test(port) && Number(port) >= 1 && Number(port) <= 65535;
}

/**
 * The overlay row's config: absent (no address, the designed published-loopback and 15.1 state)
 * or exactly `{ platformUrl }`. Anything else fails the plugin loudly.
 * @param {unknown} config
 * @returns {import('./types.js').KnowledgeBaseConfig | undefined}
 */
function platformConfig(config) {
  if (config === undefined || config === null) return undefined;
  const prototype = typeof config === 'object' ? Object.getPrototypeOf(config) : undefined;
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(REJECTED);
  const keys = Reflect.ownKeys(/** @type {object} */ (config));
  if (keys.length === 0) return undefined;
  // A data property only: an accessor would run code while being validated.
  const platformUrl = Object.getOwnPropertyDescriptor(config, 'platformUrl')?.value;
  if (keys.length !== 1 || !platformAddress(platformUrl)) throw new TypeError(REJECTED);
  return { platformUrl: /** @type {string} */ (platformUrl) };
}

/**
 * @param {unknown} _ctx host context; 15.1 registers nothing
 * @param {unknown} config managed overlay row config
 */
export function apply(_ctx, config) {
  platformConfig(config);
}
