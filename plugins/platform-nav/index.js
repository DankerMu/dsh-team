// @ts-check
/** Host half: publishes the launch-time role flag and forced catalog states into every served DSH page. */
export const name = 'dsh-team-platform-nav';
const GLOBAL = '__DSH_TEAM_PLATFORM_NAV__';
// npm package names as the catalog writes them; anything else could break the client's selectors.
const PACKAGE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/**
 * The overlay row's forced states by package. A missing field is an older admin-only row; a present
 * one that is not exactly such a map is a tampered row and fails the plugin loudly.
 * @param {unknown} config
 * @returns {Record<string, 'forced-on' | 'forced-off'>}
 */
function pluginCatalog(config) {
  const value =
    typeof config === 'object' && config !== null
      ? Reflect.get(config, 'pluginCatalog')
      : undefined;
  if (value === undefined) return {};
  const prototype =
    typeof value === 'object' && value !== null ? Object.getPrototypeOf(value) : undefined;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('platform-nav config.pluginCatalog must be a plain object');
  }
  /** @type {Record<string, 'forced-on' | 'forced-off'>} */
  const states = {};
  for (const [key, state] of Object.entries(/** @type {object} */ (value))) {
    if (!PACKAGE.test(key) || (state !== 'forced-on' && state !== 'forced-off')) {
      throw new TypeError('platform-nav config.pluginCatalog holds an invalid package state');
    }
    states[key] = state;
  }
  return states;
}

/**
 * @param {import('./types.js').PlatformNavHostContext} ctx
 * @param {unknown} config managed overlay row config; only a literal `admin: true` grants the link
 */
export function apply(ctx, config) {
  const admin =
    typeof config === 'object' && config !== null && Reflect.get(config, 'admin') === true;
  const forced = pluginCatalog(config);
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: GLOBAL, value: { admin, pluginCatalog: forced } });
  });
}
