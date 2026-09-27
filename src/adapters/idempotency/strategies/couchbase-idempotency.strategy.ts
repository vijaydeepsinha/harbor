// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { IdempotencyStrategy } from '../../../core/types/idempotency.types.js'
import type { CouchbaseConnectionConfig } from '../../../core/types/config.types.js'
import type { Logger } from '../../../core/types/logger.types.js'
import { CouchbaseRestClient } from '../../infra/couchbase-client.js'
import { generateIdempotencyKey } from './keygen.js'
import { STORE_TYPE } from '../../../core/constants.js'
import { errorMessage } from '../../../core/utils/errors.js'

export class CouchbaseIdempotencyStrategy implements IdempotencyStrategy {
  readonly name = STORE_TYPE.COUCHBASE
  private readonly client: CouchbaseRestClient
  /**
   * Per-pod single-flight map. Concurrent callers with the same key reuse the
   * same in-flight Promise instead of racing two identical executions. The
   * Couchbase doc is still the source of truth across pods; this map only
   * dedupes within a single node.
   */
  private readonly inflight = new Map<string, Promise<unknown>>()

  constructor(config: CouchbaseConnectionConfig, private readonly logger?: Logger) {
    this.client = new CouchbaseRestClient(config)
  }

  async checkAndExecute<T>(key: string, fn: () => Promise<T>, idempotencyKeyTtlMs: number): Promise<T> {
    const pending = this.inflight.get(key)
    if (pending) return pending as Promise<T>

    // Read failure: log and fall through. Write failure: log and return result —
    // the operation already succeeded, so failing the request would be worse.
    let cached: T | undefined
    try {
      cached = await this.client.getDoc<T>(key)
    } catch (err) {
      this.logger?.warn(
        { key, error: errorMessage(err) },
        'Couchbase idempotency read failed — executing without cache'
      )
    }
    if (cached !== undefined) return cached

    const work = (async () => {
      const result = await fn()
      const expirySecs = Math.ceil(idempotencyKeyTtlMs / 1000)
      try {
        await this.client.setDoc(key, result, expirySecs)
      } catch (err) {
        this.logger?.warn(
          { key, error: errorMessage(err) },
          'Couchbase idempotency write failed — retries will re-execute'
        )
      }
      return result
    })()

    this.inflight.set(key, work)
    try {
      return await work
    } finally {
      this.inflight.delete(key)
    }
  }

  generateKey(userIdHash: string): string {
    return generateIdempotencyKey(userIdHash)
  }
}

export function couchbaseIdempotency(config: CouchbaseConnectionConfig, logger?: Logger): IdempotencyStrategy {
  return new CouchbaseIdempotencyStrategy(config, logger)
}
