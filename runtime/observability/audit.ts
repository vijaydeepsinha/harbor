// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { Logger } from './logger.js'
import type { GlobalConfig } from '../../core/types/config.types.js'
import { TOOL } from '../../core/constants.js'
import type { AuditOutcome } from '../../core/constants.js'

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
}

/**
 * Collects endpoints accessed during a single execute() call.
 * Instantiate once per execute call, pass to runApiInSandbox.
 */
export class AuditCollector {
  private readonly endpointsAccessed: string[] = []
  private apiCallCount = 0

  record(method: string, normalizedPath: string): void {
    this.endpointsAccessed.push(`${method} ${normalizedPath}`)
    this.apiCallCount++
  }

  getEndpoints(): string[] {
    return [...this.endpointsAccessed]
  }

  getCallCount(): number {
    return this.apiCallCount
  }
}

export function writeAuditRecord(
  record: AuditRecord,
  logger: Logger,
  globalConfig: GlobalConfig
): void {
  if (!globalConfig.observability.enableAudit) return
  logger.info(record, 'audit')
}
