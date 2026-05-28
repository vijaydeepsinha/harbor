// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { IdempotencyStrategy } from '../../../core/types/idempotency.types.js'
import type { Logger } from '../../../core/types/logger.types.js'
import { generateIdempotencyKey } from './keygen.js'
import { STORE_TYPE } from '../../../core/constants.js'
import { errorMessage } from '../../../core/utils/errors.js'

type CacheEntry =
  | { kind: 'pending'; promise: Promise<unknown> }
  | { kind: 'resolved'; result: unknown; expiresAt: number }

export class InMemoryIdempotencyStrategy implements IdempotencyStrategy {
  readonly name = STORE_TYPE.IN_MEMORY
  private readonly cache = new Map<string, CacheEntry>()
  private cleanupTimer: ReturnType<typeof setInterval>

  constructor(private readonly logger?: Logger) {
    this.cleanupTimer = setInterval(() => {
      this.evictExpired()
    }, 10 * 60 * 1000)

    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref()
    }
  }

  async checkAndExecute<T>(key: string, fn: () => Promise<T>, idempotencyKeyTtlMs: number): Promise<T> {
    const entry = this.cache.get(key)
    if (entry) {
      if (entry.kind === 'pending') {
        // Concurrent caller already started `fn` — wait for the same result
        // instead of executing twice.
        return entry.promise as Promise<T>
      }
      if (Date.now() < entry.expiresAt) {
        return entry.result as T
      }
    }

    // Insert a pending sentinel BEFORE awaiting so other callers see it.
    const pending = (async () => {
      try {
        const result = await fn()
        this.cache.set(key, { kind: 'resolved', result, expiresAt: Date.now() + idempotencyKeyTtlMs })
        return result
      } catch (err) {
        // On failure, drop the sentinel so retries are free to re-execute.
        // The IIFE swallows stack traces at the call site, so log the failure
        // here — otherwise ops has no signal when backend `fn()` blows up
        // inside the single-flight path. Parity with the Couchbase strategy.
        this.cache.delete(key)
        this.logger?.warn(
          { key, error: errorMessage(err) },
          'Idempotency execution failed — dropping sentinel so retries can proceed'
        )
        throw err
      }
    })()
    this.cache.set(key, { kind: 'pending', promise: pending })
    return pending as Promise<T>
  }

  generateKey(userIdHash: string): string {
    return generateIdempotencyKey(userIdHash)
  }

  private evictExpired(): void {
    const now = Date.now()
    for (const [key, entry] of this.cache.entries()) {
      if (entry.kind === 'resolved' && now >= entry.expiresAt) {
        this.cache.delete(key)
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer)
  }
}

export function inMemoryIdempotency(logger?: Logger): IdempotencyStrategy {
  return new InMemoryIdempotencyStrategy(logger)
}
