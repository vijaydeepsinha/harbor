// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type {
  ExecutionRecord,
  ActivityRecord,
  ApprovalRecord,
  GovernanceDecisionRecord
} from '../../core/types/execution.types.js'

/**
 * Persistence contracts for the Code Mode governance layer. The execution
 * engine talks only to these interfaces; whether the backend is memory, a
 * file directory or a database is a wiring decision (`EXECUTION_STORE_TYPE`).
 *
 * Every method returns detached copies — callers may mutate what they get
 * back without affecting the store until they `put*` it again.
 */

export interface ExecutionStore {
  createExecution(record: ExecutionRecord): Promise<void>
  getExecution(executionId: string): Promise<ExecutionRecord | undefined>
  updateExecution(record: ExecutionRecord): Promise<void>
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

/** One object implementing every store — the shape the engine is wired with. */
export interface CodeModeStore
  extends ExecutionStore, ActivityStore, ApprovalStore, GovernanceDecisionStore, ExecutionLockStore {
  readonly name: string
  /** Release timers/handles on shutdown. */
  destroy?(): Promise<void> | void
}
