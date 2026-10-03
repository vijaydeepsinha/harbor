// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type {TokenPayload} from './auth.types.js'

export interface ApiRequest {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    path: string
    params?: Record<string, unknown>
    body?: unknown
    headers?: Record<string, string>
}

export interface ApiResponse {
    data: unknown
    status: number
    ok: boolean
}

export interface ExecuteRequestContext {
    tokenPayload: TokenPayload
    invalidate: () => Promise<void>
    idempotencyKey: string
    idempotencyKeyTtlMs: number
    /** Sent as X-Correlation-ID: the MCP request id, shared by this sandbox run's calls; approval resumes use a new request id. */
    correlationId: string
    /** Sent as X-Harbor-Execution-ID for governed runs; stable across approval turns and absent on legacy runs. */
    executionId?: string
    /** Sent as X-Harbor-Client-ID: the external caller's id from the inbound request, when it sent one. */
    clientId?: string
    /**
     * The endpoint identity the bridge used for this call — the OpenAPI
     * template in a governed run — so the connector records breaker failures
     * under the same key the bridge checks and credits. Absent ⇒ the
     * connector derives one from the path.
     */
    endpoint?: string
    signal?: AbortSignal
}
