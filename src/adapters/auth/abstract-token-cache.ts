// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {createHash} from 'node:crypto'
import type {TokenPayload} from '../../core/types/auth.types.js'
import type {TokenCacheStrategy} from '../../spi/auth/token-cache.js'
import type {Logger} from '../../core/types/logger.types.js'

export interface CacheEntry {
    payload: TokenPayload
    /** When this entry stops being served and the caller's own token is validated again. */
    expiresAt: number
    /** When `payload.access_token` expires — what the refresh window is measured against. Absent on entries written before it existed. */
    tokenExpiresAt?: number
}

export abstract class AbstractTokenCache implements TokenCacheStrategy {
    protected static readonly KEY_PREFIX = 'mcp-tok:'
    abstract readonly name: string

    constructor(
        protected readonly configTtlMs: number,
        protected readonly logger?: Logger
    ) {
    }

    hashToken(service: string, rawToken: string): string {
        return createHash('sha256').update(`${service}:${rawToken}`).digest('hex')
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

    async get(service: string, rawToken: string): Promise<CacheEntry | undefined> {
        const entry = await this.readEntry(this.cacheKey(service, rawToken))
        if (entry && Date.now() < entry.expiresAt) {
            return entry
        }
        return undefined
    }

    /**
     * Stores a refreshed payload for the caller's token. A refresh rotates the
     * *backend* token; it says nothing about the caller's own credential. So a
     * live entry keeps its expiry: the caller's token is validated again when
     * it would have been anyway, and a token revoked at the auth server stops
     * working then — however often the client calls and refreshes land.
     */
    async update(service: string, rawToken: string, payload: TokenPayload): Promise<void> {
        const key = this.cacheKey(service, rawToken)
        const existing = await this.readEntry(key)
        const notAfter = existing && Date.now() < existing.expiresAt ? existing.expiresAt : undefined
        await this.writeEntry(key, this.buildEntry(payload, notAfter))
    }

    async invalidate(tokenHash: string): Promise<void> {
        await this.deleteEntry(`${AbstractTokenCache.KEY_PREFIX}${tokenHash}`)
    }

    abstract destroy(): void

    protected cacheKey(service: string, rawToken: string): string {
        return `${AbstractTokenCache.KEY_PREFIX}${this.hashToken(service, rawToken)}`
    }

    protected computeTtlMs(payload: TokenPayload): number {
        return Math.min(payload.expires_in * 1000, this.configTtlMs)
    }

    protected buildEntry(payload: TokenPayload, notAfter?: number): CacheEntry {
        const now = Date.now()
        return {
            payload,
            expiresAt: Math.min(now + this.computeTtlMs(payload), notAfter ?? Number.POSITIVE_INFINITY),
            tokenExpiresAt: now + payload.expires_in * 1000
        }
    }

    protected abstract readEntry(key: string): Promise<CacheEntry | undefined>

    protected abstract writeEntry(key: string, entry: CacheEntry): Promise<void>

    protected abstract deleteEntry(key: string): Promise<void>
}
