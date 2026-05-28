// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { TokenCacheStrategy } from '../../../core/types/auth.types.js'
import { AbstractTokenCache, type CacheEntry } from '../../../spi/auth/abstract-token-cache.js'
import { STORE_TYPE } from '../../../core/constants.js'

export class InMemoryTokenCache extends AbstractTokenCache {
  readonly name = STORE_TYPE.IN_MEMORY
  private readonly cache = new Map<string, CacheEntry>()
  private cleanupTimer: ReturnType<typeof setInterval>

  constructor(configTtlMs: number) {
    super(configTtlMs)
    this.cleanupTimer = setInterval(() => {
      this.evictExpired()
    }, 5 * 60 * 1000)

    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref()
    }
  }

  protected async readEntry(key: string): Promise<CacheEntry | undefined> {
    return this.cache.get(key)
  }

  protected async writeEntry(key: string, entry: CacheEntry): Promise<void> {
    this.cache.set(key, entry)
  }

  protected async deleteEntry(key: string): Promise<void> {
    this.cache.delete(key)
  }

  private evictExpired(): void {
    const now = Date.now()
    for (const [key, entry] of this.cache.entries()) {
      if (now >= entry.expiresAt) {
        this.cache.delete(key)
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer)
  }
}

export function inMemoryTokenCache(tokenCacheTtlMs: number): TokenCacheStrategy {
  return new InMemoryTokenCache(tokenCacheTtlMs)
}
