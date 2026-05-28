// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { randomBytes } from 'node:crypto'

export function generateIdempotencyKey(userIdHash: string): string {
  const hex = randomBytes(3).toString('hex')
  return `mcp-${userIdHash}-${Date.now()}-${hex}`
}
