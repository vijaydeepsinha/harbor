// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { TokenCacheStrategy } from '../../../core/types/auth.types.js'
import type { CouchbaseConnectionConfig } from '../../../core/types/config.types.js'
import type { Logger } from '../../../core/types/logger.types.js'
import { AbstractTokenCache, type CacheEntry } from '../../../spi/auth/abstract-token-cache.js'
import { CouchbaseRestClient } from '../../infra/couchbase-client.js'
import { STORE_TYPE } from '../../../core/constants.js'
import { errorMessage } from '../../../core/utils/errors.js'

export class CouchbaseTokenCache extends AbstractTokenCache {
  readonly name = STORE_TYPE.COUCHBASE
  private readonly client: CouchbaseRestClient

  constructor(configTtlMs: number, config: CouchbaseConnectionConfig, logger?: Logger) {
    super(configTtlMs, logger)
    this.client = new CouchbaseRestClient(config)
  }

  protected async readEntry(key: string): Promise<CacheEntry | undefined> {
    try {
      const doc = await this.client.getDoc<CacheEntry>(key)
      if (doc && Date.now() < doc.expiresAt) {
        return doc
      }
    } catch (err) {
      this.logger?.warn(
        { key, error: errorMessage(err) },
        'Couchbase token cache read failed — falling through to auth server'
      )
    }
    return undefined
  }

  protected async writeEntry(key: string, entry: CacheEntry): Promise<void> {
    const ttlSec = Math.ceil((entry.expiresAt - Date.now()) / 1000)
    try {
      await this.client.setDoc(key, entry, ttlSec)
    } catch (err) {
      this.logger?.warn(
        { key, error: errorMessage(err) },
        'Couchbase token cache write failed — token usable for this request but not cached'
      )
    }
  }

  protected async deleteEntry(key: string): Promise<void> {
    try {
      await this.client.deleteDoc(key)
    } catch (err) {
      this.logger?.warn(
        { key, error: errorMessage(err) },
        'Couchbase token cache delete failed'
      )
    }
  }

  destroy(): void {
    // No persistent connection to close with REST-based access
  }
}

export function couchbaseTokenCache(
  tokenCacheTtlMs: number,
  config: CouchbaseConnectionConfig,
  logger?: Logger
): TokenCacheStrategy {
  return new CouchbaseTokenCache(tokenCacheTtlMs, config, logger)
}
