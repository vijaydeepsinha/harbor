// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { IdempotencyStrategy } from '../../../core/types/idempotency.types.js'
import { STORE_TYPE } from '../../../core/constants.js'

export class NoopIdempotencyStrategy implements IdempotencyStrategy {
  readonly name = STORE_TYPE.NOOP

  async checkAndExecute<T>(_key: string, fn: () => Promise<T>, _idempotencyKeyTtlMs: number): Promise<T> {
    return fn()
  }

  generateKey(userIdHash: string): string {
    return `mcp-${userIdHash}-${Date.now()}`
  }
}

export function noopIdempotency(): IdempotencyStrategy {
  return new NoopIdempotencyStrategy()
}
