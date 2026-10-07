import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// This fixture runs only inside the image; resolve the same installation-owned ESM
// module used by DSH, not a second package under the writable profile.
const require = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json');
const { livePresetMounts } = await import(
  pathToFileURL(require.resolve('@deepseek-ai/dsh-agent-preset-registry')).href
);

/** Fixture-only read-only observer. Does not change model, permission, or tool policy. */
export const name = 'dsh-team-managed-policy-observer';
export const inject = ['loader', 'llm', 'agentPresets', 'tools'];

const FAIL = 'Invalid managed policy runtime observation';
const MARKER = 'DSH_TEAM_MANAGED_POLICY_OBSERVATION';
const ALPHA = 'alpha';
const BETA = 'beta';
const PROVIDER = 'intranet';
const CUSTOM_PRESET_ID = 'custom-office';
const TOOL_FS_MODULE = '@deepseek-ai/dsh-tool-fs';

function fail() {
  process.stderr.write(`${FAIL}\n`);
  process.exit(1);
}

function entryConfig(ctx, id) {
  for (const entry of ctx.loader.entries()) {
    if (entry.options?.group) continue;
    if (entry.id === id || entry.options?.id === id) {
      const fiber = entry.fiber;
      if (!fiber) fail();
      const config = fiber.config;
      if (typeof config !== 'object' || config === null || Array.isArray(config)) fail();
      return config;
    }
  }
  fail();
}

function intranetAddress(ctx) {
  const providersRef = entryConfig(ctx, 'llm-pi-ai').providers;
  if (typeof providersRef?.get !== 'function') fail();
  const providers = providersRef.get();
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) fail();
  const provider = providers[PROVIDER];
  if (typeof provider !== 'object' || provider === null || Array.isArray(provider)) fail();
  if (typeof provider.baseURL !== 'string' || provider.baseURL === '') fail();
  return provider.baseURL;
}

function defaultModelId(ctx) {
  const modelRef = entryConfig(ctx, 'agent-default-model').model;
  if (typeof modelRef?.get !== 'function') fail();
  const model = modelRef.get();
  if (typeof model !== 'string' || model === '') fail();
  return model;
}

function toolNames(schemas) {
  if (!Array.isArray(schemas)) fail();
  const names = [];
  for (const schema of schemas) {
    if (typeof schema?.name !== 'string' || schema.name === '') fail();
    names.push(schema.name);
  }
  if (names.length === 0) fail();
  return names;
}

function descriptionOf(row) {
  return typeof row.description === 'string' ? row.description : '';
}

async function observeRegisteredCatalog(llm) {
  const catalog = [];
  for (const registered of llm.listProviders()) {
    if (typeof registered?.id !== 'string' || registered.id === '') fail();
    const listed = await llm.listModels(registered.id);
    if (!Array.isArray(listed)) fail();
    const models = [];
    for (const model of listed) {
      if (typeof model?.id !== 'string' || model.id === '') fail();
      models.push(model.id);
    }
    catalog.push({ id: registered.id, models });
  }
  return catalog;
}

async function observeModels(ctx, llm) {
  const alpha = await llm.resolveModelInfo(PROVIDER, ALPHA);
  const beta = await llm.resolveModelInfo(PROVIDER, BETA);
  return {
    intranetAddress: intranetAddress(ctx),
    defaultModel: defaultModelId(ctx),
    catalog: await observeRegisteredCatalog(llm),
    alphaContextWindow: alpha?.context?.contextWindow ?? 0,
    betaContextWindow: beta?.context?.contextWindow ?? 0,
  };
}

function effectiveReadLimit(ctx, lease, presetId) {
  const mounts = livePresetMounts(ctx.root.fiber).filter(
    (mount) => mount.key === lease.key && mount.presetId === presetId,
  );
  if (mounts.length !== 1) fail();
  // Loader entry.id is owner-qualified; options.id is the row's group-local identity.
  const entries = [...mounts[0].tree.entries()].filter(
    (entry) => entry.options.id === 'tool-fs' && entry.options.name === TOOL_FS_MODULE,
  );
  if (entries.length !== 1) fail();
  const entry = entries[0];
  if (entry.options.group || entry.disabled || entry.fiber === undefined) fail();
  const config = entry.fiber.config;
  if (typeof config !== 'object' || config === null || Array.isArray(config)) fail();
  const readLimit = config.readLimit;
  if (typeof readLimit !== 'number' || !Number.isFinite(readLimit)) fail();
  return readLimit;
}

async function observePresets(ctx, agentPresets, tools) {
  const listed = await agentPresets.list();
  const presets = [];
  for (const row of listed) {
    if (typeof row.broken === 'string' && row.broken !== '') fail();
    const lease = await agentPresets.acquireScope(row.id);
    try {
      presets.push({
        id: row.id,
        description: descriptionOf(row),
        toolNames: toolNames(tools.schemas(lease.key)),
        ...(row.id === CUSTOM_PRESET_ID
          ? { readLimit: effectiveReadLimit(ctx, lease, row.id) }
          : {}),
      });
    } finally {
      await lease[Symbol.asyncDispose]();
    }
  }
  return presets;
}

export function apply(ctx) {
  queueMicrotask(() => {
    void observe(ctx).catch(fail);
  });
}

async function observe(ctx) {
  await ctx.loader.await();
  const llm = ctx.get('llm');
  const agentPresets = ctx.get('agentPresets');
  const tools = ctx.get('tools');
  if (llm === undefined || agentPresets === undefined || tools === undefined) fail();
  const models = await observeModels(ctx, llm);
  const presets = await observePresets(ctx, agentPresets, tools);
  process.stdout.write(`${MARKER}${JSON.stringify({ models, presets })}\n`);
}
