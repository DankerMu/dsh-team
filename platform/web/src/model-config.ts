export const MODEL_CONFIG_API = '/_platform/api/admin/model-config';

export interface ModelConfig {
  baseURL: string;
  apiKeyConfigured: boolean;
  models: { name: string; contextWindow?: number }[];
  defaultModel: string;
  /** Present only on a saved (PUT) response; null for a read. */
  runningInstances: number | null;
}

export function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid configuration response');
  // The runtime object/array check establishes a JSON object, but not its field domains.
  return value as Record<string, unknown>;
}

function saveCount(value: unknown, baseURL: string, defaultModel: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    baseURL.trim() === '' ||
    defaultModel.trim() === ''
  )
    throw new Error('Invalid save response');
  return value;
}

function parseModel(value: unknown): ModelConfig['models'][number] {
  const model = jsonObject(value);
  if (
    typeof model.name !== 'string' ||
    model.name.trim() === '' ||
    Object.keys(model).some((key) => key !== 'name' && key !== 'contextWindow') ||
    (model.contextWindow !== undefined &&
      (typeof model.contextWindow !== 'number' ||
        !Number.isSafeInteger(model.contextWindow) ||
        model.contextWindow < 1))
  )
    throw new Error('Invalid model response');
  return model.contextWindow === undefined
    ? { name: model.name }
    : { name: model.name, contextWindow: model.contextWindow };
}

/** Validates a model-config GET (saved=false) or PUT (saved=true) 200 body; throws otherwise. */
export function parseModelConfig(value: unknown, saved: boolean): ModelConfig {
  const body = jsonObject(value);
  const allowed = [
    'baseURL',
    'apiKeyConfigured',
    'models',
    'defaultModel',
    ...(saved ? ['runningInstances'] : []),
  ];
  if (
    Object.keys(body).some((key) => !allowed.includes(key)) ||
    typeof body.baseURL !== 'string' ||
    typeof body.apiKeyConfigured !== 'boolean' ||
    typeof body.defaultModel !== 'string' ||
    !Array.isArray(body.models)
  )
    throw new Error('Invalid configuration response');
  const models = body.models.map(parseModel);
  const runningInstances = saved
    ? saveCount(body.runningInstances, body.baseURL, body.defaultModel)
    : null;
  if (body.defaultModel !== '' && !models.some((model) => model.name === body.defaultModel))
    throw new Error('Invalid save response');
  return {
    baseURL: body.baseURL,
    apiKeyConfigured: body.apiKeyConfigured,
    models,
    defaultModel: body.defaultModel,
    runningInstances,
  };
}

/** Mirrors the server's hasCompleteModelSettings over the fields this API exposes. */
export function isCompleteModelConfig(config: ModelConfig): boolean {
  return (
    config.baseURL.trim() !== '' &&
    config.apiKeyConfigured &&
    config.models.length > 0 &&
    config.defaultModel.trim() !== ''
  );
}
