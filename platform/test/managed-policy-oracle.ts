interface ManagedPolicyModelObservation {
  readonly intranetAddress: string;
  readonly defaultModel: string;
  readonly allowedModels: readonly string[];
  readonly alphaContextWindow: number;
  readonly betaContextWindow: number;
}

interface ManagedPolicyPresetObservation {
  readonly id: string;
  readonly greeting: string;
  readonly toolNames: readonly string[];
}

export interface ManagedPolicyRuntimeObservation {
  readonly models: ManagedPolicyModelObservation;
  readonly presets: readonly ManagedPolicyPresetObservation[];
}

export interface ManagedPolicyRuntimeExpectation {
  readonly intranetAddress: string;
  readonly defaultModel: string;
  readonly allowedModels: readonly string[];
  readonly alphaContextWindow: number;
  readonly betaContextWindow: number;
  readonly presetIds: readonly string[];
  readonly greetings?: Readonly<Record<string, string>>;
}

const INVALID_RUNTIME = 'Invalid managed policy runtime observation';
const RELEASED_BETA_CONTEXT_WINDOW = 262_144;
const NETWORK_TOOLS = new Set(['web_search', 'web_fetch']);

function invalid(): never {
  throw new Error(INVALID_RUNTIME);
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid();
  }
  // JSON observations arrive untyped; field checks below are the contract.
  return value as Record<string, unknown>;
}

function requireString(value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    invalid();
  }
  return value;
}

function requireNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalid();
  }
  return value;
}

function requireStringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    invalid();
  }
  return value.map(requireString);
}

function parseModels(value: unknown): ManagedPolicyModelObservation {
  const models = asObject(value);
  return {
    intranetAddress: requireString(models.intranetAddress),
    defaultModel: requireString(models.defaultModel),
    allowedModels: requireStringList(models.allowedModels),
    alphaContextWindow: requireNumber(models.alphaContextWindow),
    betaContextWindow: requireNumber(models.betaContextWindow),
  };
}

function parsePreset(value: unknown): ManagedPolicyPresetObservation {
  const preset = asObject(value);
  const greeting = preset.greeting;
  return {
    id: requireString(preset.id),
    greeting: typeof greeting === 'string' ? greeting : '',
    toolNames: requireStringList(preset.toolNames),
  };
}

export function parseManagedPolicyRuntime(value: unknown): ManagedPolicyRuntimeObservation {
  const record = asObject(value);
  if (!Array.isArray(record.presets)) {
    invalid();
  }
  return {
    models: parseModels(record.models),
    presets: record.presets.map(parsePreset),
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

export function assertManagedPolicyRuntime(
  observation: unknown,
  expected: ManagedPolicyRuntimeExpectation,
): void {
  const observed = parseManagedPolicyRuntime(observation);
  if (
    observed.models.intranetAddress !== expected.intranetAddress ||
    observed.models.defaultModel !== expected.defaultModel ||
    !sameStrings(observed.models.allowedModels, expected.allowedModels) ||
    observed.models.alphaContextWindow !== expected.alphaContextWindow ||
    observed.models.betaContextWindow !== expected.betaContextWindow ||
    observed.models.betaContextWindow !== RELEASED_BETA_CONTEXT_WINDOW
  ) {
    invalid();
  }
  const observedIds = observed.presets.map((preset) => preset.id);
  if (!sameStrings(sorted(observedIds), sorted(expected.presetIds))) {
    invalid();
  }
  for (const preset of observed.presets) {
    if (preset.toolNames.some((name) => NETWORK_TOOLS.has(name))) {
      invalid();
    }
    const greeting = expected.greetings?.[preset.id];
    if (greeting !== undefined && preset.greeting !== greeting) {
      invalid();
    }
  }
}

export function assertRuntimeRejected(
  observation: unknown,
  expected: ManagedPolicyRuntimeExpectation,
): void {
  let accepted = false;
  try {
    assertManagedPolicyRuntime(observation, expected);
    accepted = true;
  } catch (error) {
    if (!(error instanceof Error) || error.message !== INVALID_RUNTIME) throw error;
  }
  if (accepted) invalid();
}

export function controlExposesEmployeePolicy(
  observation: ManagedPolicyRuntimeObservation,
  address: string,
  defaultModel: string,
): boolean {
  if (observation.models.intranetAddress !== address) return false;
  if (observation.models.defaultModel !== defaultModel) return false;
  return observation.presets.some((preset) => {
    const names = new Set(preset.toolNames);
    return names.has('web_search') && names.has('web_fetch');
  });
}
