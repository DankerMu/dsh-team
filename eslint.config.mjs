import { fileURLToPath } from 'node:url';
import { includeIgnoreFile } from '@eslint/compat';
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { constraintNumber, forbiddenSuffixPatterns } from './scripts/constraints.mjs';

// Thresholds and naming patterns come from constraints.yaml; do not hardcode them here.
const maxFileLines = constraintNumber('size_limits', 'max_file_lines');
const maxComplexity = constraintNumber('size_limits', 'max_complexity');
const maxFunctionLines = constraintNumber('size_limits', 'max_function_lines');
const [snakeSuffix, pascalSuffix] = forbiddenSuffixPatterns();

export default tseslint.config(
  includeIgnoreFile(fileURLToPath(new URL('.gitignore', import.meta.url))),
  {
    // docs/ and verify/ are registered in constraints.yaml `exemptions`; schemas/ is generated.
    ignores: ['docs/**', 'verify/**', 'schemas/**'],
  },
  js.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'max-lines': ['error', { max: maxFileLines, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': [
        'error',
        { max: maxFunctionLines, skipBlankLines: true, skipComments: true },
      ],
      complexity: ['error', maxComplexity],
      // Server code logs through the Fastify/pino logger so redaction always applies.
      'no-console': 'error',
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'default',
          format: ['camelCase', 'PascalCase', 'UPPER_CASE'],
          leadingUnderscore: 'allow',
          custom: { regex: snakeSuffix, match: false },
        },
        {
          selector: 'typeLike',
          format: ['PascalCase'],
          custom: { regex: pascalSuffix, match: false },
        },
        // HTTP headers, JSON Schema keywords and env variable names are external spellings.
        { selector: ['objectLiteralProperty', 'typeProperty'], format: null },
      ],
    },
  },
  {
    // Test suites nest many cases in one describe callback; the limit targets production code.
    files: ['**/*.test.ts'],
    rules: { 'max-lines-per-function': 'off' },
  },
  prettier,
);
