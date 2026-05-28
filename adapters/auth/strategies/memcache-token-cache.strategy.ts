// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type memjs from 'memjs'
import type { TokenCacheStrategy } from '../../../core/types/auth.types.js'
import type { MemcacheConnectionConfig } from '../../../core/types/config.types.js'
import type { Logger } from '../../../core/types/logger.types.js'
import { AbstractTokenCache, type CacheEntry } from '../../../spi/auth/abstract-token-cache.js'
import { createMemcacheClient } from '../../infra/memcache-client.js'
import { STORE_TYPE } from '../../../core/constants.js'
import { errorMessage } from '../../../core/utils/errors.js'

export class MemcacheTokenCache extends AbstractTokenCache {
  readonly name = STORE_TYPE.MEMCACHE
  private readonly client: memjs.Client

  constructor(configTtlMs: number, config: MemcacheConnectionConfig, logger?: Logger) {
    super(configTtlMs, logger)
    this.client = createMemcacheClient(config)
  }

  protected async readEntry(key: string): Promise<CacheEntry | undefined> {
    try {
      const cached = await this.client.get(key)
      if (cached.value !== null) {
        const entry = JSON.parse(cached.value.toString()) as CacheEntry
        if (Date.now() < entry.expiresAt) {
          return entry
        }
      }
    } catch (err) {
      this.logger?.warn(
        { key, error: errorMessage(err) },
        'Memcache token cache read failed — falling through to auth server'
      )
    }
    return undefined
  }

  protected async writeEntry(key: string, entry: CacheEntry): Promise<void> {
    const ttlSec = Math.ceil((entry.expiresAt - Date.now()) / 1000)
    try {
      await this.client.set(key, JSON.stringify(entry), { expires: ttlSec })
    } catch (err) {
      this.logger?.warn(
        { key, error: errorMessage(err) },
        'Memcache token cache write failed — token usable for this request but not cached'
      )
    }
  }

  protected async deleteEntry(key: string): Promise<void> {
    try {
      await this.client.delete(key)
    } catch (err) {
      this.logger?.warn(
        { key, error: errorMessage(err) },
        'Memcache token cache delete failed'
      )
    }
  }

  destroy(): void {
    this.client.close()
  }
}

export function memcacheTokenCache(
  tokenCacheTtlMs: number,
  config: MemcacheConnectionConfig,
  logger?: Logger
): TokenCacheStrategy {
  return new MemcacheTokenCache(tokenCacheTtlMs, config, logger)
}
