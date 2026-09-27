// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { TOOL, AuditOutcome } from '../constants.js'

/** One `api_execute` call, as written to the audit trail. */
export interface AuditRecord {
  auditId: string
  timestamp: string
  service: string
  environment: string
  userIdHash: string
  sessionId: string
  correlationId: string
  tool: typeof TOOL.API_EXECUTE
  authStrategy: string
  idempotencyStrategy: string
  circuitBreakerStrategy: string
  codeSubmitted: string
  endpointsAccessed: string[]
  apiCallCount: number
  durationMs: number
  outcome: AuditOutcome
  errorType?: string
  errorCode?: string
  /** Durable Code Mode execution this call belonged to (absent on the legacy, store-less path). */
  executionId?: string
}
