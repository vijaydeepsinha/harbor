// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { Logger } from './logger.js'
import type { GlobalConfig } from '../../core/types/config.types.js'
import type { AuditRecord } from '../../core/types/audit.types.js'
import type { CallLogSource, JournalEntry } from '../execution/activity-journal.js'
import type { AuditPipeline } from './audit-pipeline.js'

export type { AuditRecord } from '../../core/types/audit.types.js'

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

/**
 * Writes one `api_execute` audit record — to the audit pipeline's sinks when
 * one is wired (AUDIT_SINKS), or straight to `logger` otherwise.
 */
export function writeAuditRecord(
  record: AuditRecord,
  logger: Logger,
  globalConfig: GlobalConfig,
  pipeline?: AuditPipeline
): void {
  if (!globalConfig.observability.enableAudit) return
  if (pipeline) {
    void pipeline.publish({ kind: 'audit', record })
    return
  }
  logger.info(record, 'audit')
}
