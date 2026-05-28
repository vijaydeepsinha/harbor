// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { TokenPayload } from './auth.types.js'

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
  correlationId: string
  sessionId: string
  signal?: AbortSignal
}
