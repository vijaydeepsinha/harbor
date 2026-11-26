// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type {
    ActivityRecord,
    ApprovalRecord,
    ExecutionRecord,
    GovernanceDecisionRecord
} from '../../core/types/execution.types.js'

/**
 * Persistence contracts for durable execution. The execution
 * engine talks only to these interfaces; whether the backend is memory, a
 * file directory or a database is a wiring decision (`EXECUTION_STORE_TYPE`).
 *
 * Every method returns detached copies — callers may mutate what they get
 * back without affecting the store until they `put*` it again.
 */

export interface ExecutionRecordStore {
    createExecution(record: ExecutionRecord): Promise<void>

    getExecution(executionId: string): Promise<ExecutionRecord | undefined>

    updateExecution(record: ExecutionRecord): Promise<void>

    /** Removes the execution and everything recorded for it — activities, approvals, decisions, its lock. Unknown id ⇒ no-op. */
    deleteExecution(executionId: string): Promise<void>

    /**
     * Ids of executions whose `expiresAt` is at or before `now`, oldest first,
     * at most `limit` — what the retention sweep deletes. A store that expires
     * records natively (item TTLs) may return none.
     */
    listExpiredExecutions(now: string, limit: number): Promise<string[]>
}

export interface ActivityStore {
    putActivity(record: ActivityRecord): Promise<void>

    getActivity(executionId: string, sequence: number): Promise<ActivityRecord | undefined>

    /** Ascending by sequence. */
    listActivities(executionId: string): Promise<ActivityRecord[]>
}

export interface ApprovalStore {
    putApproval(record: ApprovalRecord): Promise<void>

    getApproval(approvalId: string): Promise<ApprovalRecord | undefined>

    /** Ascending by createdAt. */
    listApprovals(executionId: string): Promise<ApprovalRecord[]>
}

export interface GovernanceDecisionStore {
    putDecision(record: GovernanceDecisionRecord): Promise<void>

    /** Ascending by evaluatedAt. */
    listDecisions(executionId: string): Promise<GovernanceDecisionRecord[]>
}

/**
 * Mutual exclusion between concurrent runs of one execution (§31). `acquire`
 * returns `false` when another run holds the lock; callers surface that as
 * `ExecutionLockedError` rather than waiting.
 */
export interface ExecutionLockStore {
    acquireLock(executionId: string): Promise<boolean>

    releaseLock(executionId: string): Promise<void>
}

/** Complete execution persistence: records, activities, approvals, decisions and run locks. */
export interface ExecutionPersistence
    extends ExecutionRecordStore, ActivityStore, ApprovalStore, GovernanceDecisionStore, ExecutionLockStore {
    readonly name: string

    /** Release timers/handles on shutdown. */
    destroy?(): Promise<void> | void
}
