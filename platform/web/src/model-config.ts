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

const V1_HINT = 'OpenAI 兼容地址通常以 /v1 结尾';
const CONNECTION_TEXT: Readonly<Record<string, string>> = {
  unconfigured: '请先保存完整的模型配置',
  unauthorized: '密钥无效或无权访问该模型',
  'not-found': `地址或模型不存在。${V1_HINT}。`,
  'bad-response': `地址返回的不是模型接口。${V1_HINT}。`,
  timeout: '连接超时',
  unreachable: '无法连接到模型地址',
  'invalid-address': '模型地址格式无效，需以 http:// 或 https:// 开头',
  'invalid-key': '已保存的密钥包含无效字符',
};
const STATUS_TEXT: Readonly<Record<string, string>> = {
  rejected: '模型服务拒绝了请求',
  'server-error': '模型服务出错',
};

function isHttpStatus(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 100 && value <= 599)
  );
}

/** Validates a connection-test 200 body and returns its fixed Chinese explanation. */
export function connectionMessage(value: unknown): { ok: boolean; text: string } {
  const body = jsonObject(value);
  const { result, httpStatus, elapsedMs } = body;
  if (
    Object.keys(body).some((key) => !['result', 'httpStatus', 'elapsedMs'].includes(key)) ||
    typeof result !== 'string' ||
    !isHttpStatus(httpStatus) ||
    typeof elapsedMs !== 'number' ||
    !Number.isSafeInteger(elapsedMs) ||
    elapsedMs < 0
  )
    throw new Error('Invalid connection test response');
  if (result === 'ok') return { ok: true, text: `连接成功（用时 ${String(elapsedMs)} 毫秒）` };
  if (Object.hasOwn(CONNECTION_TEXT, result))
    return { ok: false, text: CONNECTION_TEXT[result] ?? '' };
  if (!Object.hasOwn(STATUS_TEXT, result) || httpStatus === null)
    throw new Error('Invalid connection test response');
  return { ok: false, text: `${STATUS_TEXT[result] ?? ''}（HTTP ${String(httpStatus)}）` };
}
