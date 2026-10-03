// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type {MemcacheKv} from '../../src/adapters/execution/memcache-execution-store.js'

/**
 * An in-memory memcache with the semantics the memcache execution store relies
 * on: atomic `add`, TTLs against an injectable clock, and memcached's rule that
 * an `expires` above 30 days is an absolute Unix time. Several store instances
 * sharing one fake behave like several pods sharing one memcache.
 */
export class FakeMemcache implements MemcacheKv {
    private readonly items = new Map<string, { value: string; expiresAtMs?: number }>()

    constructor(private readonly nowMs: () => number = Date.now) {
    }

    async get(key: string): Promise<{ value: Buffer | null }> {
        const item = this.live(key)
        return {value: item ? Buffer.from(item.value) : null}
    }

    async set(key: string, value: string, options?: { expires?: number }): Promise<boolean> {
        this.items.set(key, {value, ...this.expiry(options?.expires)})
        return true
    }

    async add(key: string, value: string, options?: { expires?: number }): Promise<boolean> {
        if (this.live(key)) return false
        return this.set(key, value, options)
    }

    async delete(key: string): Promise<boolean> {
        return this.items.delete(key)
    }

    async touch(key: string, expires: number): Promise<boolean> {
        const item = this.live(key)
        if (!item) return false
        this.items.set(key, {value: item.value, ...this.expiry(expires)})
        return true
    }

    /** Live keys, for assertions. */
    keys(): string[] {
        return [...this.items.keys()].filter(k => this.live(k) !== undefined)
    }

    /** The TTL deadline of a key, for assertions. */
    expiresAtMs(key: string): number | undefined {
        return this.live(key)?.expiresAtMs
    }

    private live(key: string): { value: string; expiresAtMs?: number } | undefined {
        const item = this.items.get(key)
        if (item?.expiresAtMs !== undefined && item.expiresAtMs <= this.nowMs()) {
            this.items.delete(key)
            return undefined
        }
        return item
    }

    private expiry(expires: number | undefined): { expiresAtMs?: number } {
        if (!expires) return {}
        return {expiresAtMs: expires > 30 * 24 * 3600 ? expires * 1000 : this.nowMs() + expires * 1000}
    }
}
