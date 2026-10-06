/** Fixture-only read-only observer. Does not change model, permission, or tool policy. */
export const name = 'dsh-team-managed-policy-observer';
export const inject = ['loader', 'llm', 'agentPresets', 'tools'];

const FAIL = 'Invalid managed policy runtime observation';
const MARKER = 'DSH_TEAM_MANAGED_POLICY_OBSERVATION';
const ALPHA = 'alpha';
const BETA = 'beta';
const PROVIDER = 'intranet';

function fail() {
  process.stderr.write(`${FAIL}\n`);
  process.exit(1);
}

function entryConfig(ctx, id) {
  for (const entry of ctx.loader.entries()) {
    if (entry.options?.group) continue;
    if (entry.id === id || entry.options?.id === id) {
      return entry.config;
    }
  }
  fail();
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

async function observeModels(ctx, llm) {
  const provider = entryConfig(ctx, 'llm-pi-ai')?.providers?.[PROVIDER];
  const defaultModel = entryConfig(ctx, 'agent-default-model');
  const alpha = await llm.resolveModelInfo(PROVIDER, ALPHA);
  const beta = await llm.resolveModelInfo(PROVIDER, BETA);
  return {
    intranetAddress: provider?.baseURL ?? '',
    defaultModel: defaultModel?.model ?? '',
    allowedModels: (provider?.models ?? []).map((model) => model.id ?? model.name),
    alphaContextWindow: alpha?.context?.contextWindow ?? 0,
    betaContextWindow: beta?.context?.contextWindow ?? 0,
  };
}

async function observePresets(agentPresets, tools) {
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
  const presets = await observePresets(agentPresets, tools);
  process.stdout.write(`${MARKER}${JSON.stringify({ models, presets })}\n`);
}
