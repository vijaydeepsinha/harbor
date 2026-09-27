// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The governance E2E suite needs a running environment — it has its own config (vitest.e2e.config.ts).
    exclude: ['tests/e2e/**', '**/node_modules/**'],
    environment: 'node',
    globals: true,
    testTimeout: 30000
  }
})
