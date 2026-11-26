// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/** Control-plane client for the deterministic mock downstream API (`tests/e2e/mock-api/server.mjs`). */

export interface MockRequest {
    seq: number
    receivedAt: string
    method: string
    path: string
    query: Record<string, string>
    body: unknown
    identity: string | null
    tokenFingerprint: string | null
    headers: Record<string, string | null>
    status: number | string | null
}

export class MockApi {
    constructor(readonly baseUrl: string) {
    }

    async reset(): Promise<void> {
        const res = await fetch(`${this.baseUrl}/__admin/reset`, {method: 'POST', signal: AbortSignal.timeout(5000)})
        if (!res.ok) throw new Error(`mock reset failed: ${res.status}`)
    }

    async requests(filter: { method?: string; path?: string } = {}): Promise<MockRequest[]> {
        const q = new URLSearchParams()
        if (filter.method) q.set('method', filter.method)
        if (filter.path) q.set('path', filter.path)
        const res = await fetch(`${this.baseUrl}/__admin/requests?${q.toString()}`, {signal: AbortSignal.timeout(5000)})
        return await res.json() as MockRequest[]
    }

    async count(method: string, path: string): Promise<number> {
        return (await this.requests({method, path})).length
    }

    /** `"POST /orders"` style labels in arrival order — handy for exactly-once assertions. */
    async calls(): Promise<string[]> {
        return (await this.requests()).map(r => `${r.method} ${r.path}`)
    }

    async state(): Promise<Record<string, unknown>> {
        const res = await fetch(`${this.baseUrl}/__admin/state`, {signal: AbortSignal.timeout(5000)})
        return await res.json() as Record<string, unknown>
    }

    async health(): Promise<boolean> {
        try {
            return (await fetch(`${this.baseUrl}/health`, {signal: AbortSignal.timeout(2000)})).ok
        } catch {
            return false
        }
    }
}
