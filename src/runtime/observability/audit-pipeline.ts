// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { Logger } from '../../core/types/logger.types.js'
import type { AuditEvent, AuditSink, ExecutionStateSnapshot } from '../../spi/observability/audit-sink.js'
import type { ExecutionInspection } from '../execution/execution-manager.js'
import { errorMessage } from '../../core/utils/errors.js'

/**
 * Fans every audit event out to each configured sink. One sink failing never
 * stops the others and never fails the request: the failure is logged with
 * the sink's name. With no sinks (ENABLE_AUDIT=false) publishing is a no-op.
 */
export class AuditPipeline {
  constructor(private readonly sinks: readonly AuditSink[], private readonly logger: Logger) {}

  get sinkNames(): string[] {
    return this.sinks.map(s => s.name)
  }

  async publish(event: AuditEvent): Promise<void> {
    await Promise.all(this.sinks.map(async sink => {
      try {
        await sink.write(event)
      } catch (err) {
        this.logger.error({ sink: sink.name, kind: event.kind, error: errorMessage(err) }, 'Audit sink failed — event not delivered to this sink')
      }
    }))
  }

  async close(): Promise<void> {
    for (const sink of this.sinks) {
      try {
        await sink.close?.()
      } catch (err) {
        this.logger.warn({ sink: sink.name, error: errorMessage(err) }, 'Audit sink close failed')
      }
    }
  }
}

/** The audit view of an execution: statuses, approvals and decisions — no request/response bodies, no program text. */
export function executionStateOf(inspection: ExecutionInspection): ExecutionStateSnapshot {
  const { execution: e, activities, approvals, decisions } = inspection
  return {
    executionId: e.executionId,
    service: e.service,
    status: e.status,
    userIdHash: e.userIdHash,
    runCount: e.runCount,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    ...(e.finishedAt !== undefined ? { finishedAt: e.finishedAt } : {}),
    ...(e.expiresAt !== undefined ? { expiresAt: e.expiresAt } : {}),
    ...(e.terminalReason !== undefined ? { terminalReason: e.terminalReason } : {}),
    ...(e.pendingApprovalId !== undefined ? { pendingApprovalId: e.pendingApprovalId } : {}),
    activities: activities.map(a => ({
      sequence: a.sequence,
      method: a.request.method,
      specPath: a.request.specPath,
      ...(a.request.operationId !== undefined ? { operationId: a.request.operationId } : {}),
      status: a.status,
      runIndex: a.runIndex,
      ...(a.response !== undefined ? { httpStatus: a.response.status } : {}),
      ...(a.approvalId !== undefined ? { approvalId: a.approvalId } : {}),
      ...(a.failure !== undefined ? { failure: { code: a.failure.code, outcomeKnown: a.failure.outcomeKnown } } : {})
    })),
    approvals: approvals.map(ap => ({
      approvalId: ap.approvalId,
      activitySequence: ap.activitySequence,
      status: ap.status,
      createdAt: ap.createdAt,
      ...(ap.decidedAt !== undefined ? { decidedAt: ap.decidedAt } : {}),
      ...(ap.decidedVia !== undefined ? { decidedVia: ap.decidedVia } : {})
    })),
    decisions: decisions.map(d => ({
      activitySequence: d.activitySequence,
      decision: d.decision,
      reason: d.reason,
      matchedRules: d.matchedRules,
      ruleVersions: d.ruleVersions,
      ...(d.decidingRule !== undefined ? { decidingRule: d.decidingRule } : {}),
      evaluatedAt: d.evaluatedAt
    }))
  }
}
