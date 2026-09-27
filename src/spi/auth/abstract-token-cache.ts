// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { createHash } from 'node:crypto'
import type { TokenPayload, TokenCacheStrategy } from '../../core/types/auth.types.js'
import type { Logger } from '../../core/types/logger.types.js'

export interface CacheEntry {
  payload: TokenPayload
  expiresAt: number
}

export abstract class AbstractTokenCache implements TokenCacheStrategy {
  abstract readonly name: string

  protected static readonly KEY_PREFIX = 'mcp-tok:'

  constructor(
    protected readonly configTtlMs: number,
    protected readonly logger?: Logger
  ) {}

  hashToken(service: string, rawToken: string): string {
    return createHash('sha256').update(`${service}:${rawToken}`).digest('hex')
  }

  protected cacheKey(service: string, rawToken: string): string {
    return `${AbstractTokenCache.KEY_PREFIX}${this.hashToken(service, rawToken)}`
  }

  protected computeTtlMs(payload: TokenPayload): number {
    return Math.min(payload.expires_in * 1000, this.configTtlMs)
  }

  protected buildEntry(payload: TokenPayload): CacheEntry {
    return { payload, expiresAt: Date.now() + this.computeTtlMs(payload) }
  }

  async getOrValidate(
    service: string,
    rawToken: string,
    validatorFn: (token: string) => Promise<TokenPayload>
  ): Promise<TokenPayload> {
    const key = this.cacheKey(service, rawToken)
    const entry = await this.readEntry(key)

    if (entry && Date.now() < entry.expiresAt) {
      return entry.payload
    }

    const payload = await validatorFn(rawToken)
    await this.writeEntry(key, this.buildEntry(payload))
    return payload
  }

  async get(service: string, rawToken: string): Promise<{ payload: TokenPayload; expiresAt: number } | undefined> {
    const entry = await this.readEntry(this.cacheKey(service, rawToken))
    if (entry && Date.now() < entry.expiresAt) {
      return entry
    }
    return undefined
  }

  async update(service: string, rawToken: string, payload: TokenPayload): Promise<void> {
    await this.writeEntry(this.cacheKey(service, rawToken), this.buildEntry(payload))
  }

  async invalidate(tokenHash: string): Promise<void> {
    await this.deleteEntry(`${AbstractTokenCache.KEY_PREFIX}${tokenHash}`)
  }

  abstract destroy(): void

  protected abstract readEntry(key: string): Promise<CacheEntry | undefined>
  protected abstract writeEntry(key: string, entry: CacheEntry): Promise<void>
  protected abstract deleteEntry(key: string): Promise<void>
}
