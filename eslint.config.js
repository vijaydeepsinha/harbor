// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import tseslint from 'typescript-eslint'

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/spi/**/strategies/**'],
          message: 'SPI contains contracts only; concrete strategies live in adapters.',
        }],
      }],
    },
  },
  {
    files: ['src/runtime/**/*.ts', 'src/tools/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/adapters/**', '**/spi/**/strategies/**'],
          message: 'Use provider contracts or wiring; runtime/tools must not select concrete adapters.',
        }],
      }],
    },
  },
  {
    ignores: [
      '**/dist/',
      '**/node_modules/',
      '**/coverage/',
      '**/.venv/',
      '**/.pytest_cache/',
      '**/.ruff_cache/',
    ],
  }
)
