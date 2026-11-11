import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

const OBSERVER = new URL('./managed-policy-observer.js', import.meta.url).href;
const MARKER = 'DSH_TEAM_MANAGED_POLICY_OBSERVATION';
const FAIL = 'Invalid managed policy runtime observation';
// dsh-plugin-manager 0.2.1-rc.2 lib/index.js:938 and :1580-1581: `registry` has no default, and
// `fallbackRegistries` defaults to [NPMMIRROR_REGISTRY].
const NPMMIRROR = 'https://registry.npmmirror.com/';

/**
 * Runs the observer's `apply` in its own process (its `fail` exits) against a synthetic loader
 * holding the rows every observer user has, with `pluginManager` as the plugin-manager row's
 * resolved config. Real cordis/DSH services and their resolved configs need Docker proof.
 */
function observe(pluginManager: unknown) {
  const driver = `
const { apply } = await import(${JSON.stringify(OBSERVER)});
const row = (id, config) => ({ id, options: { id }, disabled: false, fiber: { state: 2, config } });
const entries = [
  row('llm-pi-ai', { providers: { get: () => ({ intranet: { baseURL: 'http://127.0.0.1:9/v1' } }) } }),
  row('agent-default-model', { model: { get: () => 'beta' } }),
  row('ui-plugin-manager', { registryProbeEnabled: true }),
  row('plugin-manager', ${JSON.stringify(pluginManager)}),
  row('agent-preset-registry', { default: 'standard', selectedDefault: { get: () => undefined } }),
];
const services = {
  llm: { resolveModelInfo: async () => undefined, listProviders: () => [], listModels: async () => [] },
  agentPresets: { list: async () => [], compositionInventory: async () => [], defaultId: 'standard' },
  tools: {},
  systemPrompt: {},
  permissionPresets: { catalog: () => ({ defaultPreset: 'danger-full-access' }) },
};
apply({ loader: { await: async () => {}, entries: () => entries }, get: (name) => services[name] });
`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', driver], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  const line = run.stdout.split('\n').find((text) => text.startsWith(MARKER));
  return {
    status: run.status,
    stderr: run.stderr,
    observation:
      line === undefined
        ? undefined
        : (JSON.parse(line.slice(MARKER.length)) as Record<string, unknown>),
  };
}

// The managed-policy control stage publishes no plugin-manager row: dsh-base's row has no config.
it.each([
  [{ fallbackRegistries: [NPMMIRROR] }, { registry: null, fallbackRegistries: [NPMMIRROR] }],
  [{}, { registry: null, fallbackRegistries: null }],
])('reports an unconfigured plugin manager %j as unset', (config, expected) => {
  const run = observe(config);
  expect(run.status).toBe(0);
  expect(run.observation?.pluginManager).toEqual(expected);
});

it('reports the overlay plugin-manager sources and the preset default', () => {
  const run = observe({ registry: 'https://registry.npmjs.org/', fallbackRegistries: [NPMMIRROR] });
  expect(run.status).toBe(0);
  expect(run.observation?.pluginManager).toEqual({
    registry: 'https://registry.npmjs.org/',
    fallbackRegistries: [NPMMIRROR],
  });
  expect(run.observation?.presetRegistry).toEqual({ default: 'standard', defaultId: 'standard' });
});

it.each([
  { registry: 42, fallbackRegistries: [] },
  { registry: null, fallbackRegistries: [] },
  { registry: 'https://registry.npmjs.org/', fallbackRegistries: NPMMIRROR },
  { registry: 'https://registry.npmjs.org/', fallbackRegistries: [7] },
  { fallbackRegistries: [null] },
])('rejects a present plugin-manager value of the wrong type %j', (config) => {
  const run = observe(config);
  expect(run.status).toBe(1);
  expect(run.observation).toBeUndefined();
  expect(run.stderr.startsWith(`${FAIL}\nFAIL Error: "observation check failed"\nat `)).toBe(true);
});
