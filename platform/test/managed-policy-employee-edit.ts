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
          description: 'brief-zh',
          plugins: [
            {
              id: 'tool-fs',
              name: '@deepseek-ai/dsh-tool-fs',
              config: { readLimit: { __jsExpr: '250 + 250' } },
            },
            { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
            {
              id: 'planning',
              name: 'cordis:group',
              group: true,
              config: [
                { id: 'renamed-web', name: '@deepseek-ai/dsh-tool-web' },
                { id: 'renamed-plugins', name: '@deepseek-ai/dsh-plugin-manager/tools' },
                { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
              ],
            },
          ],
        },
      },
    ],
  };
}

/**
 * Script fragment for a uid1001 edit of the Web profile patch: binds `profile`, the installed
 * js-yaml's `load`/`dump`, `require`, `readFileSync`/`writeFileSync`, and `parsed`, the current row
 * list. Callers push rows and write the whole file back, so rows already there survive.
 */
export const PROFILE_ROWS_READ = `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json');
const { load, dump } = require('js-yaml');
const profile = '/data/home/profiles/web/cordis.patch.yml';
const parsed = existsSync(profile) ? load(readFileSync(profile, 'utf8')) ?? [] : [];
if (!Array.isArray(parsed)) throw new Error('Invalid managed policy runtime observation');
`;
