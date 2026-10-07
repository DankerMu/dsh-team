export function employeeHomePatch(apiKeyEnv: string, altAddress: string): string {
  return `- id: llm-deepseek
  disabled: false
- id: llm-deepseek-account
  disabled: false
- id: llm-pi-ai
  config:
    providers:
      intranet:
        displayName: employee
        apiKeyEnv: ${apiKeyEnv}
        api: openai-completions
        baseURL: ${altAddress}
        models:
          - id: alpha
            name: alpha
          - id: beta
            name: beta
      personal:
        displayName: personal
        apiKeyEnv: ${apiKeyEnv}
        api: openai-completions
        baseURL: ${altAddress}
        models:
          - id: gamma
            name: gamma
- id: agent-default-model
  config:
    provider: intranet
    model: alpha
`;
}

export function customOfficeInsert(presetId: string): {
  readonly id: string;
  readonly name: string;
  readonly group: true;
  readonly config: readonly unknown[];
} {
  return {
    id: 'office-group',
    name: 'cordis:group',
    group: true,
    config: [
      {
        id: presetId,
        name: '@deepseek-ai/dsh-agent-preset',
        config: {
          id: presetId,
          order: 9,
          description: { __jsExpr: "'brief-' + 'zh'" },
          plugins: [
            { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
            { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
            {
              id: 'planning',
              name: 'cordis:group',
              group: true,
              config: [
                { id: 'renamed-web', name: '@deepseek-ai/dsh-tool-web' },
                { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
              ],
            },
          ],
        },
      },
    ],
  };
}
