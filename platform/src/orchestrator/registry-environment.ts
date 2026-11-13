/**
 * The instance's npm/pnpm defaults (#608): the first managed registry instead of the public one,
 * and no update-notifier lookup. Values come from validated settings; none is a secret.
 */
export function registryEnvironment(pluginRegistries: readonly string[]): Record<string, string> {
  const [registry] = pluginRegistries;
  if (registry === undefined) throw new Error('Instance registry list must be nonempty');
  return { npm_config_registry: registry, npm_config_update_notifier: 'false' };
}

/** npm/pnpm read `npm_config_*` case-insensitively; no other instance variable may use the prefix. */
export function isRegistryEnvironmentName(name: string): boolean {
  return /^npm_config_/i.test(name);
}
