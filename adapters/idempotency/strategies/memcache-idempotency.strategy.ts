// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type memjs from 'memjs'
import type { IdempotencyStrategy } from '../../../core/types/idempotency.types.js'
import type { MemcacheConnectionConfig } from '../../../core/types/config.types.js'
import type { Logger } from '../../../core/types/logger.types.js'
import { createMemcacheClient } from '../../infra/memcache-client.js'
import { generateIdempotencyKey } from './keygen.js'
import { STORE_TYPE } from '../../../core/constants.js'
import { errorMessage } from '../../../core/utils/errors.js'

export class MemcacheIdempotencyStrategy implements IdempotencyStrategy {
  readonly name = STORE_TYPE.MEMCACHE
  private readonly client: memjs.Client

  constructor(config: MemcacheConnectionConfig, private readonly logger?: Logger) {
    this.client = createMemcacheClient(config)
  }

  async checkAndExecute<T>(key: string, fn: () => Promise<T>, idempotencyKeyTtlMs: number): Promise<T> {
    // Read failure: log and fall through to both execution AND write —
    // matches the Couchbase strategy so retries still populate the cache
    // when memcache recovers. Write failure: log and return result —
    // the operation already succeeded, so failing the request would be worse.
    try {
      const cached = await this.client.get(key)
      if (cached.value !== null) {
        return JSON.parse(cached.value.toString()) as T
      }
    } catch (err) {
      this.logger?.warn(
        { key, error: errorMessage(err) },
        'Memcache idempotency read failed — executing without cache'
      )
    }

    const result = await fn()

    try {
      await this.client.set(key, JSON.stringify(result), { expires: Math.ceil(idempotencyKeyTtlMs / 1000) })
    } catch (err) {
      this.logger?.warn(
        { key, error: errorMessage(err) },
        'Memcache idempotency write failed — retries will re-execute'
      )
    }

    return result
  }

  generateKey(userIdHash: string): string {
    return generateIdempotencyKey(userIdHash)
  }
}

export function memcacheIdempotency(config: MemcacheConnectionConfig, logger?: Logger): IdempotencyStrategy {
  return new MemcacheIdempotencyStrategy(config, logger)
}
