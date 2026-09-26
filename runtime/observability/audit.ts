// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { Logger } from './logger.js'
import type { GlobalConfig } from '../../core/types/config.types.js'
import { TOOL } from '../../core/constants.js'
import type { AuditOutcome } from '../../core/constants.js'
import type { CallLogSource, JournalEntry } from '../execution/activity-journal.js'

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

/**
 * The endpoints one execute() call actually called — a read-only projection
 * of the run's CallLog (the execution's activity journal when governed): the
 * calls that went out and returned a response, in completion order. A
 * replayed activity was not called in this run and is not counted. Keeps no
 * state of its own.
 */
export class AuditCollector {
  constructor(private readonly calls: CallLogSource) {}

  getEndpoints(): string[] {
    return this.executed().map(e => `${e.method} ${e.endpoint}`)
  }

  getCallCount(): number {
    return this.executed().length
  }

  private executed(): JournalEntry[] {
    return this.calls.entries().filter(e => e.outcome === 'EXECUTED')
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
