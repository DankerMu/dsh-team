interface ManagedPolicyCatalogObservation {
  readonly id: string;
  readonly models: readonly string[];
}

interface ManagedPolicyModelObservation {
  readonly intranetAddress: string;
  readonly defaultModel: string;
  readonly catalog: readonly ManagedPolicyCatalogObservation[];
  readonly alphaContextWindow: number;
  readonly betaContextWindow: number;
}

interface ManagedPolicyPresetObservation {
  readonly id: string;
  readonly description: string;
  readonly toolNames: readonly string[];
  readonly readLimit?: number;
}

export interface ManagedPolicyRuntimeObservation {
  readonly models: ManagedPolicyModelObservation;
  readonly presets: readonly ManagedPolicyPresetObservation[];
}

export interface ManagedPolicyRuntimeExpectation {
  readonly intranetAddress: string;
  readonly defaultModel: string;
  readonly catalog: readonly ManagedPolicyCatalogObservation[];
  readonly alphaContextWindow: number;
  readonly betaContextWindow: number;
  readonly presetIds: readonly string[];
  readonly descriptions?: Readonly<Record<string, string>>;
  readonly retainedTools?: Readonly<Record<string, readonly string[]>>;
  readonly readLimits?: Readonly<Record<string, number>>;
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

function parseCatalog(value: unknown): ManagedPolicyCatalogObservation[] {
  if (!Array.isArray(value) || value.length === 0) {
    invalid();
  }
  return value.map((entry) => {
    const row = asObject(entry);
    if (!Array.isArray(row.models)) {
      invalid();
    }
    return {
      id: requireString(row.id),
      models: row.models.map(requireString),
    };
  });
}

function parseModels(value: unknown): ManagedPolicyModelObservation {
  const models = asObject(value);
  return {
    intranetAddress: requireString(models.intranetAddress),
    defaultModel: requireString(models.defaultModel),
    catalog: parseCatalog(models.catalog),
    alphaContextWindow: requireNumber(models.alphaContextWindow),
    betaContextWindow: requireNumber(models.betaContextWindow),
  };
}

function parsePreset(value: unknown): ManagedPolicyPresetObservation {
  const preset = asObject(value);
  const description = preset.description;
  return {
    id: requireString(preset.id),
    description: typeof description === 'string' ? description : '',
    toolNames: requireStringList(preset.toolNames),
    ...(preset.readLimit === undefined ? {} : { readLimit: requireNumber(preset.readLimit) }),
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

function sameCatalog(
  left: readonly ManagedPolicyCatalogObservation[],
  right: readonly ManagedPolicyCatalogObservation[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const expected = right[index];
    return expected?.id === entry.id && sameStrings(entry.models, expected.models);
  });
}

function retainsExpectedTools(
  preset: ManagedPolicyPresetObservation,
  expected: ManagedPolicyRuntimeExpectation,
): boolean {
  const retained = expected.retainedTools?.[preset.id];
  return retained === undefined || retained.every((name) => preset.toolNames.includes(name));
}

function matchesExpectedPreset(
  preset: ManagedPolicyPresetObservation,
  expected: ManagedPolicyRuntimeExpectation,
): boolean {
  const description = expected.descriptions?.[preset.id];
  const readLimit = expected.readLimits?.[preset.id];
  return (
    (description === undefined || preset.description === description) &&
    (readLimit === undefined || preset.readLimit === readLimit) &&
    retainsExpectedTools(preset, expected)
  );
}

export function assertManagedPolicyRuntime(
  observation: unknown,
  expected: ManagedPolicyRuntimeExpectation,
): void {
  const observed = parseManagedPolicyRuntime(observation);
  if (
    observed.models.intranetAddress !== expected.intranetAddress ||
    observed.models.defaultModel !== expected.defaultModel ||
    !sameCatalog(observed.models.catalog, expected.catalog) ||
    observed.models.alphaContextWindow !== expected.alphaContextWindow ||
    observed.models.betaContextWindow !== expected.betaContextWindow ||
    observed.models.betaContextWindow !== RELEASED_BETA_CONTEXT_WINDOW
  ) {
    invalid();
  }
  const observedIds = observed.presets.map((preset) => preset.id);
  if (!sameStrings([...observedIds].sort(), [...expected.presetIds].sort())) {
    invalid();
  }
  for (const preset of observed.presets) {
    if (preset.toolNames.some((name) => NETWORK_TOOLS.has(name))) {
      invalid();
    }
    if (!matchesExpectedPreset(preset, expected)) {
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

export type EmployeeControlFailure =
  | 'intranet-address'
  | 'default-model'
  | 'intranet-models'
  | 'personal-model'
  | 'official-provider'
  | 'account-provider'
  | 'custom-preset'
  | 'custom-web-search'
  | 'custom-web-fetch'
  | 'custom-read-limit';

function customPresetFailure(
  presets: readonly ManagedPolicyPresetObservation[],
): EmployeeControlFailure | undefined {
  const custom = presets.find((preset) => preset.id === 'custom-office');
  if (custom === undefined) return 'custom-preset';
  if (!custom.toolNames.includes('web_search')) return 'custom-web-search';
  if (!custom.toolNames.includes('web_fetch')) return 'custom-web-fetch';
  if (custom.readLimit !== 500) return 'custom-read-limit';
  return undefined;
}

/** Returns only the first failed condition's static identifier, never observed values. */
export function controlEmployeePolicyFailure(
  observation: ManagedPolicyRuntimeObservation,
  address: string,
  defaultModel: string,
): EmployeeControlFailure | undefined {
  if (observation.models.intranetAddress !== address) return 'intranet-address';
  if (observation.models.defaultModel !== defaultModel) return 'default-model';
  const catalog = observation.models.catalog;
  const intranet = catalog.find((row) => row.id === 'intranet');
  const personal = catalog.find((row) => row.id === 'personal');
  if (!intranet?.models.includes('alpha') || !intranet.models.includes('beta')) {
    return 'intranet-models';
  }
  if (!personal?.models.includes('gamma')) return 'personal-model';
  if (!catalog.some((row) => row.id === 'deepseek-official')) return 'official-provider';
  if (!catalog.some((row) => row.id === 'deepseek-account')) return 'account-provider';
  return customPresetFailure(observation.presets);
}

export function controlExposesEmployeePolicy(
  observation: ManagedPolicyRuntimeObservation,
  address: string,
  defaultModel: string,
): boolean {
  return controlEmployeePolicyFailure(observation, address, defaultModel) === undefined;
}

export function liveCopyReenablesPersonalModels(observation: unknown): boolean {
  if (typeof observation !== 'object' || observation === null || Array.isArray(observation)) {
    return false;
  }
  const record = observation as Record<string, unknown>;
  const roster = record.bootRoster;
  if (typeof roster !== 'object' || roster === null || Array.isArray(roster)) return false;
  const ids = (roster as Record<string, unknown>).ids;
  return Array.isArray(ids) && ids.includes('@deepseek-ai/dsh-client-ui-settings-models');
}
