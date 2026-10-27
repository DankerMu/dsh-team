import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
export const inject = ['loader', 'llm', 'agentPresets', 'tools', 'skills'];

const FAIL = 'Invalid managed policy runtime observation';
const MARKER = 'DSH_TEAM_MANAGED_POLICY_OBSERVATION';
const ALPHA = 'alpha';
const BETA = 'beta';
const PROVIDER = 'intranet';
const CUSTOM_PRESET_ID = 'custom-office';
const TOOL_FS_MODULE = '@deepseek-ai/dsh-tool-fs';
const PLUGIN_PAGE_ID = 'ui-plugin-manager';

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

/** Live validated plugin page config; only the registry probe switch is reported. */
function pluginPage(ctx) {
  const value = entryConfig(ctx, PLUGIN_PAGE_ID).registryProbeEnabled;
  const enabled = typeof value?.get === 'function' ? value.get() : value;
  if (typeof enabled !== 'boolean') fail();
  return { registryProbeEnabled: enabled };
}

function toolNames(schemas) {
  if (!Array.isArray(schemas)) fail();
  const names = [];
  for (const schema of schemas) {
    if (typeof schema?.name !== 'string' || schema.name === '') fail();
    names.push(schema.name);
  }
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

function presetConfig(ctx, lease, presetId, entryId, moduleName) {
  const mounts = livePresetMounts(ctx.root.fiber).filter(
    (mount) => mount.key === lease.key && mount.presetId === presetId,
  );
  if (mounts.length !== 1) fail();
  // Loader entry.id is owner-qualified; options.id is the row's group-local identity.
  const entries = [...mounts[0].tree.entries()].filter(
    (entry) => entry.options.id === entryId && entry.options.name === moduleName,
  );
  if (entries.length !== 1) fail();
  const entry = entries[0];
  if (entry.options.group || entry.disabled || entry.fiber === undefined) fail();
  const config = entry.fiber.config;
  if (typeof config !== 'object' || config === null || Array.isArray(config)) fail();
  return config;
}

function effectiveReadLimit(ctx, lease, presetId) {
  const config = presetConfig(ctx, lease, presetId, 'tool-fs', TOOL_FS_MODULE);
  const readLimit = config.readLimit;
  if (typeof readLimit !== 'number' || !Number.isFinite(readLimit)) fail();
  return readLimit;
}

function textHash(value) {
  if (typeof value !== 'string' || value.trim() === '') fail();
  return createHash('sha256').update(value).digest('hex');
}

/** Eight-field check uses actual registered scopes; retain hashes, not instruction bodies. */
async function officeMetadata(ctx, lease, row) {
  const declaration = [...ctx.loader.entries()].find(
    (entry) => entry.options.id === `preset-${row.id}`,
  );
  if (!declaration || declaration.disabled || declaration.fiber === undefined) fail();
  const manifest = JSON.parse(
    readFileSync(
      '/data/home/profiles/web/node_modules/@dsh-team/office-agents/package.json',
      'utf8',
    ),
  );
  const persona = presetConfig(ctx, lease, row.id, 'persona', '@deepseek-ai/dsh-persona');
  const skills = [];
  for (const name of ['office-docx', 'official-writing']) {
    const skill = await ctx.skills.get(name, { cwd: '/data/work', scope: lease.key });
    if (!skill || skill.name !== name || !skill.invocation.modelInvocable) fail();
    skills.push({ name, bodySha256: textHash(skill.content) });
  }
  return {
    name: row.name,
    version: manifest.version,
    enabled: !declaration.disabled,
    instructionSha256: textHash(persona.prefix),
    skills,
  };
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
        ...(['office-general', 'office-writer'].includes(row.id)
          ? { office: await officeMetadata(ctx, lease, row) }
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
  process.stdout.write(
    `${MARKER}${JSON.stringify({ models, presets, pluginPage: pluginPage(ctx) })}\n`,
  );
}
