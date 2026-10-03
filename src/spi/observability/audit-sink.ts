// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type {AuditRecord} from '../../core/types/audit.types.js'
import type {
    ActivityStatus,
    AllowedHttpMethod,
    ApprovalStatus,
    ExecutionStatus,
    GovernanceDecisionType
} from '../../core/constants.js'

/**
 * The durable state of one execution after a run ended or a human decided —
 * statuses, approvals and governance decisions, enough to prove what happened
 * and why. Request and response bodies and the program text are not included:
 * they may carry personal or business data that the sink's destination should
 * not receive by default.
 */
export interface ExecutionStateSnapshot {
    executionId: string
    service: string
    status: ExecutionStatus
    /** sha256 of the caller's id — never the raw principal. */
    userIdHash: string
    runCount: number
    createdAt: string
    updatedAt: string
    finishedAt?: string
    expiresAt?: string
    terminalReason?: { code: string; message: string }
    pendingApprovalId?: string
    activities: Array<{
        sequence: number
        method: AllowedHttpMethod
        specPath: string
        operationId?: string
        status: ActivityStatus
        runIndex: number
        /** HTTP status of the recorded response. */
        httpStatus?: number
        approvalId?: string
        failure?: { code: string; outcomeKnown: boolean }
    }>
    approvals: Array<{
        approvalId: string
        activitySequence: number
        status: ApprovalStatus
        createdAt: string
        decidedAt?: string
        decidedVia?: 'mcp-elicitation' | 'http'
    }>
    decisions: Array<{
        activitySequence: number
        decision: GovernanceDecisionType
        reason: string
        matchedRules: string[]
        ruleVersions: string[]
        decidingRule?: string
        evaluatedAt: string
    }>
}

/** What Harbor hands to audit sinks. */
export type AuditEvent =
/** One per `api_execute` call — the audit line. */
    | { kind: 'audit'; record: AuditRecord }
    /** The execution's state after each run ended (paused, interrupted, terminal) and after a human decision. */
    | { kind: 'execution'; state: ExecutionStateSnapshot }

/**
 * A destination for the audit trail — the console (built in), or anything
 * registered with `registerAuditSinkBackend` (object storage, a log pipeline,
 * a SIEM). `AUDIT_SINKS` lists the sinks; every event goes to each of them.
 * A sink may throw: the pipeline logs the failure and still delivers the event
 * to the other sinks, and nothing in the request path waits on a sink's
 * failure.
 */
export interface AuditSink {
    readonly name: string

    write(event: AuditEvent): Promise<void> | void

    close?(): Promise<void> | void
}
