// @ts-check
/** Host half: publishes the launch-time administrator flag into every served DSH page. */
export const name = 'dsh-team-platform-nav';
const GLOBAL = '__DSH_TEAM_PLATFORM_NAV__';

/**
 * @param {import('./types.js').PlatformNavHostContext} ctx
 * @param {unknown} config managed overlay row config; only a literal `admin: true` grants the link
 */
export function apply(ctx, config) {
  const admin =
    typeof config === 'object' && config !== null && Reflect.get(config, 'admin') === true;
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: GLOBAL, value: { admin } });
  });
}
