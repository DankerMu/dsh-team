import { expect, it } from 'vitest';
import {
  assertManagedPolicyRuntime,
  assertRuntimeRejected,
  parseManagedPolicyRuntime,
  controlEmployeePolicyFailure,
  controlExposesEmployeePolicy,
  type ManagedPolicyRuntimeObservation,
  type ManagedPolicyRuntimeExpectation,
} from './managed-policy-oracle.ts';

const EXPECTED: Omit<ManagedPolicyRuntimeExpectation, 'presetIds'> = {
  intranetAddress: 'http://127.0.0.1:9/v1',
  defaultModel: 'beta',
  catalog: [{ id: 'intranet', models: ['alpha', 'beta'] }],
  alphaContextWindow: 500_000,
  betaContextWindow: 262_144,
};

it('accepts a tool-less preset alongside independently required built-in tools', () => {
  const observation = {
    models: EXPECTED,
    presets: [
      { id: 'office-general', description: '综合办公', toolNames: [] },
      { id: 'standard', description: '', toolNames: ['bash', 'read'] },
    ],
  };

  assertManagedPolicyRuntime(observation, {
    ...EXPECTED,
    presetIds: ['office-general', 'standard'],
    retainedTools: { standard: ['bash', 'read'] },
  });

  expect(parseManagedPolicyRuntime(observation).presets).toEqual([
    { id: 'office-general', description: '综合办公', toolNames: [] },
    { id: 'standard', description: '', toolNames: ['bash', 'read'] },
  ]);
});

it.each([
  { reason: 'non-array tools', office: null, standard: ['bash', 'read'] },
  { reason: 'empty tool name', office: [''], standard: ['bash', 'read'] },
  { reason: 'non-string tool name', office: [42], standard: ['bash', 'read'] },
  { reason: 'missing required built-in tools', office: [], standard: [] },
  { reason: 'forbidden network tool', office: ['web_search'], standard: ['bash', 'read'] },
])('rejects $reason while permitting genuinely tool-less presets', ({ office, standard }) => {
  const observation = {
    models: EXPECTED,
    presets: [
      { id: 'office-general', description: '综合办公', toolNames: office },
      { id: 'standard', description: '', toolNames: standard },
    ],
  };

  expect(() => {
    assertManagedPolicyRuntime(observation, {
      ...EXPECTED,
      presetIds: ['office-general', 'standard'],
      retainedTools: { standard: ['bash', 'read'] },
    });
  }).toThrow('Invalid managed policy runtime observation');
});

it('rejects office capability evidence that omits its required definition metadata', () => {
  const observation = {
    models: EXPECTED,
    presets: [{ id: 'office-general', description: '办公职责', toolNames: ['read', 'write'] }],
  };
  const expected = {
    ...EXPECTED,
    presetIds: ['office-general'],
    officeNames: { 'office-general': '综合办公' },
  };

  expect(() => {
    assertManagedPolicyRuntime(observation, expected);
  }).toThrow('Invalid managed policy runtime observation');
});

const OFFICE_METADATA = {
  name: '公文与材料写作',
  version: '0.2.0',
  enabled: true,
  instructionSha256: 'a'.repeat(64),
  skills: [
    { name: 'office-docx', bodySha256: 'b'.repeat(64) },
    { name: 'official-writing', bodySha256: 'c'.repeat(64) },
  ],
};
const OFFICE_RUNTIME = {
  models: EXPECTED,
  presets: [
    {
      id: 'office-writer',
      description: '公文职责',
      toolNames: ['read', 'write'],
      office: OFFICE_METADATA,
    },
  ],
};
const OFFICE_EXPECTED = {
  ...EXPECTED,
  presetIds: ['office-writer'],
  retainedTools: { 'office-writer': ['read', 'write'] },
  officeNames: { 'office-writer': '公文与材料写作' },
};

it('refuses to count a complete enabled office preset as rejected policy', () => {
  expect(() => {
    assertRuntimeRejected(OFFICE_RUNTIME, OFFICE_EXPECTED);
  }).toThrow('Invalid managed policy runtime observation');
});

it.each([
  { id: 'unexpected-office' },
  { description: '' },
  { toolNames: [] },
  { toolNames: ['read', 'write', 'web_fetch'] },
  { office: { ...OFFICE_METADATA, name: '' } },
  { office: { ...OFFICE_METADATA, version: '' } },
  { office: { ...OFFICE_METADATA, enabled: false } },
  { office: { ...OFFICE_METADATA, instructionSha256: '' } },
  { office: { ...OFFICE_METADATA, skills: [] } },
  { office: { ...OFFICE_METADATA, skills: [{ name: 'office-docx', bodySha256: '' }] } },
])('rejects incomplete or disabled office definition evidence %#', (changed) => {
  const observation = {
    ...OFFICE_RUNTIME,
    presets: [{ ...OFFICE_RUNTIME.presets[0], ...changed }],
  };
  expect(() => {
    assertManagedPolicyRuntime(observation, OFFICE_EXPECTED);
  }).toThrow('Invalid managed policy runtime observation');
});

it('rejects a live runtime observation that omits the required custom grouped preset', () => {
  const observation = {
    models: {
      intranetAddress: EXPECTED.intranetAddress,
      defaultModel: EXPECTED.defaultModel,
      catalog: EXPECTED.catalog,
      alphaContextWindow: EXPECTED.alphaContextWindow,
      betaContextWindow: EXPECTED.betaContextWindow,
    },
    presets: [
      { id: 'standard', description: '', toolNames: ['bash', 'read'] },
      { id: 'minimal', description: '', toolNames: ['bash'] },
    ],
  };

  expect(() => {
    assertManagedPolicyRuntime(observation, {
      ...EXPECTED,
      presetIds: ['standard', 'minimal', 'custom-office'],
    });
  }).toThrow();
});

it.each([
  {
    label: 'an extra registered provider that advertises no models',
    catalog: [
      { id: 'intranet', models: ['alpha', 'beta'] },
      { id: 'deepseek-account', models: [] },
    ],
  },
  {
    label: 'a same-size catalog that substitutes another provider for intranet',
    catalog: [{ id: 'personal', models: ['alpha', 'beta'] }],
  },
  {
    label: 'an extra model on the sole intranet provider',
    catalog: [{ id: 'intranet', models: ['alpha', 'beta', 'gamma'] }],
  },
] as const)('rejects $label', ({ catalog }) => {
  const observation = {
    models: {
      intranetAddress: EXPECTED.intranetAddress,
      defaultModel: EXPECTED.defaultModel,
      catalog,
      alphaContextWindow: EXPECTED.alphaContextWindow,
      betaContextWindow: EXPECTED.betaContextWindow,
    },
    presets: [
      { id: 'standard', description: '', toolNames: ['bash', 'read'] },
      { id: 'minimal', description: '', toolNames: ['bash'] },
      { id: 'custom-office', description: 'brief-zh', toolNames: ['read', 'present'] },
    ],
  };

  expect(() => {
    assertManagedPolicyRuntime(observation, {
      ...EXPECTED,
      presetIds: ['standard', 'minimal', 'custom-office'],
    });
  }).toThrow();
});

const QUALIFIED_CONTROL: ManagedPolicyRuntimeObservation = {
  models: {
    intranetAddress: 'http://127.0.0.1:8/v1',
    defaultModel: 'alpha',
    catalog: [
      { id: 'intranet', models: ['alpha', 'beta'] },
      { id: 'personal', models: ['gamma'] },
      { id: 'deepseek-official', models: [] },
      { id: 'deepseek-account', models: [] },
    ],
    alphaContextWindow: 500_000,
    betaContextWindow: 262_144,
  },
  presets: [
    {
      id: 'custom-office',
      description: 'brief-zh',
      toolNames: ['read', 'present', 'web_search', 'web_fetch'],
      readLimit: 500,
    },
  ],
};

it.each([
  ['intranet-address', { intranetAddress: 'http://127.0.0.1:9/v1' }],
  ['default-model', { defaultModel: 'beta' }],
  ['intranet-models', { catalog: QUALIFIED_CONTROL.models.catalog.slice(1) }],
  [
    'intranet-models',
    {
      catalog: [
        { id: 'intranet', models: ['alpha'] },
        ...QUALIFIED_CONTROL.models.catalog.slice(1),
      ],
    },
  ],
  [
    'personal-model',
    { catalog: QUALIFIED_CONTROL.models.catalog.filter((row) => row.id !== 'personal') },
  ],
  [
    'official-provider',
    { catalog: QUALIFIED_CONTROL.models.catalog.filter((row) => row.id !== 'deepseek-official') },
  ],
  [
    'account-provider',
    { catalog: QUALIFIED_CONTROL.models.catalog.filter((row) => row.id !== 'deepseek-account') },
  ],
] as const)('identifies the failed employee control %s condition', (failure, models) => {
  const observation = {
    ...QUALIFIED_CONTROL,
    models: { ...QUALIFIED_CONTROL.models, ...models },
  };
  expect(controlEmployeePolicyFailure(observation, 'http://127.0.0.1:8/v1', 'alpha')).toBe(failure);
  expect(controlExposesEmployeePolicy(observation, 'http://127.0.0.1:8/v1', 'alpha')).toBe(false);
});

it.each([
  ['custom-preset', []],
  [
    'custom-web-search',
    [{ id: 'custom-office', description: '', toolNames: ['web_fetch'], readLimit: 500 }],
  ],
  [
    'custom-web-fetch',
    [{ id: 'custom-office', description: '', toolNames: ['web_search'], readLimit: 500 }],
  ],
] as const)('identifies the failed employee control %s preset condition', (failure, presets) => {
  const observation = { ...QUALIFIED_CONTROL, presets };
  expect(controlEmployeePolicyFailure(observation, 'http://127.0.0.1:8/v1', 'alpha')).toBe(failure);
  expect(controlExposesEmployeePolicy(observation, 'http://127.0.0.1:8/v1', 'alpha')).toBe(false);
});

it('qualifies employee control only when every provider and custom web tool is exposed', () => {
  expect(
    controlEmployeePolicyFailure(QUALIFIED_CONTROL, 'http://127.0.0.1:8/v1', 'alpha'),
  ).toBeUndefined();
  expect(controlExposesEmployeePolicy(QUALIFIED_CONTROL, 'http://127.0.0.1:8/v1', 'alpha')).toBe(
    true,
  );
});

it('reports only the first static control failure rather than employee-supplied values', () => {
  const observation = {
    ...QUALIFIED_CONTROL,
    models: {
      ...QUALIFIED_CONTROL.models,
      intranetAddress: 'https://employee:secret@invalid.example',
      defaultModel: 'employee-secret',
      catalog: [],
    },
    presets: [],
  };
  expect(controlEmployeePolicyFailure(observation, 'http://127.0.0.1:8/v1', 'alpha')).toBe(
    'intranet-address',
  );
});

it.each([undefined, 2000, 499] as const)(
  'rejects employee control with custom readLimit %s despite the retained read tool',
  (readLimit) => {
    const observation = {
      ...QUALIFIED_CONTROL,
      presets: [
        {
          id: 'custom-office',
          description: 'brief-zh',
          toolNames: ['read', 'present', 'web_search', 'web_fetch'],
          ...(readLimit === undefined ? {} : { readLimit }),
        },
      ],
    };

    expect(controlEmployeePolicyFailure(observation, 'http://127.0.0.1:8/v1', 'alpha')).toBe(
      'custom-read-limit',
    );
    expect(controlExposesEmployeePolicy(observation, 'http://127.0.0.1:8/v1', 'alpha')).toBe(false);
  },
);

it.each([undefined, 2000, 499, '500', { __jsExpr: '250 + 250' }] as const)(
  'rejects managed restart with custom readLimit %s despite all other policy criteria',
  (readLimit) => {
    const observation = {
      models: {
        intranetAddress: EXPECTED.intranetAddress,
        defaultModel: EXPECTED.defaultModel,
        catalog: EXPECTED.catalog,
        alphaContextWindow: EXPECTED.alphaContextWindow,
        betaContextWindow: EXPECTED.betaContextWindow,
      },
      presets: [
        { id: 'standard', description: '', toolNames: ['bash', 'read'] },
        { id: 'minimal', description: '', toolNames: ['bash'] },
        {
          id: 'custom-office',
          description: 'brief-zh',
          toolNames: ['read', 'present'],
          ...(readLimit === undefined ? {} : { readLimit }),
        },
      ],
    };

    expect(() => {
      assertManagedPolicyRuntime(observation, {
        ...EXPECTED,
        presetIds: ['standard', 'minimal', 'custom-office'],
        descriptions: { 'custom-office': 'brief-zh' },
        retainedTools: {
          standard: ['bash', 'read'],
          minimal: ['bash'],
          'custom-office': ['read', 'present'],
        },
        readLimits: { 'custom-office': 500 },
      });
    }).toThrow('Invalid managed policy runtime observation');
  },
);
