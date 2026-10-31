import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Fixture-only read-only observer. Does not change model, permission, or tool policy. */
export const name = 'dsh-team-managed-policy-observer';
export const inject = [
  'loader',
  'llm',
  'agentPresets',
  'tools',
  'skills',
  'systemPrompt',
  'permissionPresets',
];

const FAIL = 'Invalid managed policy runtime observation';
const MARKER = 'DSH_TEAM_MANAGED_POLICY_OBSERVATION';
const OBSERVER_FILE = 'managed-policy-observer.js';
// Bounds adapter/transport error text so an upstream response body cannot be echoed whole.
const FAIL_MESSAGE_LIMIT = 256;
const ALPHA = 'alpha';
const BETA = 'beta';
const PROVIDER = 'intranet';
const CUSTOM_PRESET_ID = 'custom-office';
const TOOL_FS_MODULE = '@deepseek-ai/dsh-tool-fs';
const PERSONA_MODULE = '@deepseek-ai/dsh-persona';
const PLUGIN_PAGE_ID = 'ui-plugin-manager';
// dsh-system-prompt 0.2.1-rc.2 lib/index.js:59
//   const PERSONA_PREFIX_SECTION = "deployment:persona-prefix";
const PERSONA_PREFIX_SECTION = 'deployment:persona-prefix';
// dsh-tool-fs 0.2.1-rc.2 lib/index.js:1215-1216 passes `limit: resolved.readLimit` to the read
// tool, whose schema (lib/index.js:263-266) declares
//   description: `Maximum number of lines to return. Defaults to ${caps.limit}.`
// and parseReadArgs (lib/index.js:231-232) enforces the same cap.
const READ_LIMIT_DESCRIPTION = /^Maximum number of lines to return\. Defaults to ([1-9]\d*)\.$/;
// cordis 0.2.1-rc.2 Fiber state 2 is active: dsh-agent-preset-registry lib/index.js:247 skips
// `entry.fiber?.state !== 2` when listing active composition modules.
const ACTIVE_FIBER_STATE = 2;

/**
 * Prints the fixed line, then `FAIL <name>: <message>` and the first observer stack frame only.
 * A bare call reports its caller's frame; tokens and request bodies never reach these fields.
 */
function fail(reason) {
  let error = reason;
  if (!(error instanceof Error)) {
    error = new Error('observation check failed');
    Error.captureStackTrace(error, fail);
  }
  const frame = (error.stack ?? '')
    .split('\n')
    .find((line) => line.trimStart().startsWith('at ') && line.includes(OBSERVER_FILE));
  process.stderr.write(
    `${FAIL}\nFAIL ${error.name}: ${JSON.stringify(String(error.message).slice(0, FAIL_MESSAGE_LIMIT))}\n${frame?.trim() ?? 'at <no observer frame>'}\n`,
  );
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

/**
 * DSH 0.2.1 removed `livePresetMounts`; no released surface exposes a mounted preset's Loader
 * subtree or a row's config:
 * - dsh-agent-preset-registry lib/index.js:811 exports only AgentPresetRegistry,
 *   agentPresetProjectionDefinition, auditRows, entryListProblem and leakedServices;
 *   `generations` is `private readonly` (lib/types/index.d.ts).
 * - PresetTree (lib/index.js:63-75) restores the owner's `subtree`, so preset rows never appear
 *   in `ctx.loader.entries()` (cordis-plugin-loader lib/index.js:135-136, 142-148).
 * - serviceFor (lib/index.js:725-728) reads only services a mount publishes; persona and
 *   tool-fs publish none.
 * Row identity therefore comes from the documented `compositionInventory()`
 * (lib/index.js:791-807 -> mountedCompositionRows 330-345: `entryId`, `moduleName`,
 * `enabled: !entry.disabled`, `fiberState`), and the effective values from the row's
 * registrations read within the lease scope. `entryId` strips the same `tree.ctx.fiber.entry`
 * prefix that Entry.id adds (cordis-plugin-loader lib/index.js:330-334), so it equals a
 * top-level row's `options.id`.
 */
function requireActiveRow(composition, entryId, moduleName) {
  if (composition.broken !== undefined || !Array.isArray(composition.rows)) fail();
  const rows = composition.rows.filter(
    (row) => row.entryId === entryId && row.moduleName === moduleName,
  );
  if (rows.length !== 1) fail();
  const row = rows[0];
  if (row.enabled !== true || row.fiberState !== ACTIVE_FIBER_STATE) fail();
}

function compositionOf(inventory, presetId) {
  const matches = inventory.filter((composition) => composition.id === presetId);
  if (matches.length !== 1) fail();
  return matches[0];
}

/**
 * The scoped read schema's model-visible cap is the row's resolved `readLimit`. Scoped
 * definitions shadow inherited ones (dsh-tools lib/index.js:3071-3074), `schemas(scope)` projects
 * them (3119-3121) and the schema compiler retains property descriptions (549).
 */
function effectiveReadLimit(composition, schemas) {
  requireActiveRow(composition, 'tool-fs', TOOL_FS_MODULE);
  const reads = schemas.filter((schema) => schema.name === 'read');
  if (reads.length !== 1) fail();
  const description = reads[0].parameters?.properties?.limit?.description;
  if (typeof description !== 'string') fail();
  const match = READ_LIMIT_DESCRIPTION.exec(description);
  if (match === null) fail();
  return Number(match[1]);
}

/**
 * dsh-persona lib/index.js:36-41 registers `text: config.prefix` as the scoped
 * PERSONA_PREFIX_SECTION. `assemble({ scope })` (dsh-system-prompt lib/index.js:356-397) copies
 * section text uninterpolated and the scoped entry shadows the global persona by name (363;
 * dsh-scope lib/index.js:177-181), so this text is exactly the row's prefix config.
 */
async function personaPrefix(ctx, lease, composition) {
  requireActiveRow(composition, 'persona', PERSONA_MODULE);
  const assembly = await ctx.get('systemPrompt').assemble({ scope: lease.key });
  if (!Array.isArray(assembly?.sections)) fail();
  const sections = assembly.sections.filter((section) => section.name === PERSONA_PREFIX_SECTION);
  if (sections.length !== 1 || typeof sections[0].text !== 'string') fail();
  return sections[0].text;
}

function textHash(value) {
  if (typeof value !== 'string' || value.trim() === '') fail();
  return createHash('sha256').update(value).digest('hex');
}

/** Eight-field check uses actual registered scopes; retain hashes, not instruction bodies. */
async function officeMetadata(ctx, lease, row, composition) {
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
  const prefix = await personaPrefix(ctx, lease, composition);
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
    instructionSha256: textHash(prefix),
    skills,
  };
}

async function observePresets(ctx, agentPresets, tools) {
  const listed = await agentPresets.list();
  const inventory = await agentPresets.compositionInventory();
  if (!Array.isArray(inventory)) fail();
  const presets = [];
  for (const row of listed) {
    if (typeof row.broken === 'string' && row.broken !== '') fail();
    const lease = await agentPresets.acquireScope(row.id);
    try {
      const schemas = tools.schemas(lease.key);
      const composition = compositionOf(inventory, row.id);
      presets.push({
        id: row.id,
        description: descriptionOf(row),
        toolNames: toolNames(schemas),
        ...(row.id === CUSTOM_PRESET_ID
          ? { readLimit: effectiveReadLimit(composition, schemas) }
          : {}),
        ...(['office-general', 'office-writer'].includes(row.id)
          ? { office: await officeMetadata(ctx, lease, row, composition) }
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
  if (
    llm === undefined ||
    agentPresets === undefined ||
    tools === undefined ||
    ctx.get('systemPrompt') === undefined
  )
    fail();
  const models = await observeModels(ctx, llm);
  const presets = await observePresets(ctx, agentPresets, tools);
  // Host-only permission-tiers: its effect is the managed default and the injected service.
  const permissions = {
    managedPermissions: ctx.get('managedPermissions') !== undefined,
    defaultPreset: ctx.get('permissionPresets').catalog().defaultPreset,
  };
  process.stdout.write(
    `${MARKER}${JSON.stringify({ models, presets, pluginPage: pluginPage(ctx), permissions })}\n`,
  );
}
