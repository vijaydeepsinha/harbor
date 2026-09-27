// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { defineConfig } from 'vitest/config'

/**
 * Governance E2E suite: real MCP calls against a running gateway. Needs the
 * environment from `npm run governance:up` (or `--local`); `npm test` never
 * includes these files (see vitest.config.ts).
 */
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // The files share two gateway instances and one mock request log; run one file at a time, tests in order.
    fileParallelism: false,
    sequence: { concurrent: false, shuffle: false },
    retry: 0,
    setupFiles: ['tests/e2e/helpers/setup.ts'],
    reporters: [
      'default',
      ['junit', { outputFile: 'artifacts/e2e/junit.xml', suiteName: 'governance-e2e' }],
      ['json', { outputFile: 'artifacts/e2e/results.json' }]
    ]
  }
})
