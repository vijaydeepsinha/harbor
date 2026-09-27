// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { v4 as uuidv4 } from 'uuid'
import type { CodeModeStore } from '../../spi/execution/execution-store.js'
import {
  type ExecutionRecord,
  type ActivityRecord,
  type ApprovalRecord,
  type GovernanceDecisionRecord,
  type ExecutionHistoryEntry,
  ExecutionNotFoundError,
  ExecutionLockedError,
  ExecutionNotResumableError,
  ApprovalPendingError
} from '../../core/types/execution.types.js'
import { EXECUTION_STATUS, APPROVAL_STATUS, ACTIVITY_STATUS, EXECUTION_CODE_RETENTION, type ExecutionCodeRetention } from '../../core/constants.js'

/** How a sandbox run of an execution ended. */
export type RunOutcome =
  | { kind: 'completed'; result: unknown }
  | { kind: 'waitingApproval'; approvalId: string }
  | { kind: 'interrupted'; code: string; message: string }
  | { kind: 'failed'; code: string; message: string }
  | { kind: 'denied'; code: string; message: string }
  | { kind: 'cancelled'; code: string; message: string }

export interface ExecutionManagerOptions {
  /** `DROP` (default): remove the program text once the execution is terminal. */
  codeRetention?: ExecutionCodeRetention
  /** Seconds a terminal execution is kept before the retention sweep may delete it; 0 / absent ⇒ kept. */
  retentionSec?: number
  /**
   * Called after the execution's state was persisted at the end of a run or
   * after a human decision (e.g. to publish it to the audit trail). Must not
   * throw into the caller; errors are its own to handle.
   */
  onStateChange?: (executionId: string) => void
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  EXECUTION_STATUS.COMPLETED, EXECUTION_STATUS.FAILED, EXECUTION_STATUS.DENIED, EXECUTION_STATUS.CANCELLED
])

export interface ExecutionInspection {
  execution: ExecutionRecord
  activities: ActivityRecord[]
  approvals: ApprovalRecord[]
  decisions: GovernanceDecisionRecord[]
  history: ExecutionHistoryEntry[]
}

/**
 * Owns the execution lifecycle (§6–§8, §31, §33–§34): minting ids, persisting
 * the original program, guarding resumes with a lock, applying state
 * transitions, and assembling the chronological history. It knows nothing
 * about V8, MCP or governance rules — those call in.
 */
export class ExecutionManager {
  constructor(
    private readonly store: CodeModeStore,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly newId: () => string = uuidv4,
    private readonly options: ExecutionManagerOptions = {}
  ) {}

  /** A brand-new logical execution. The code persisted here is authoritative forever (Invariant 2). */
  async create(input: { service: string; code: string; userIdHash: string }): Promise<ExecutionRecord> {
    const at = this.now()
    const record: ExecutionRecord = {
      executionId: this.newId(),
      service: input.service,
      originalCode: input.code,
      status: EXECUTION_STATUS.CREATED,
      userIdHash: input.userIdHash,
      createdAt: at,
      updatedAt: at,
      currentActivity: 0,
      runCount: 0
    }
    await this.store.createExecution(record)
    return record
  }

  async load(executionId: string): Promise<ExecutionRecord> {
    const record = await this.store.getExecution(executionId)
    if (!record) throw new ExecutionNotFoundError(executionId)
    return record
  }

  /**
   * Takes the run lock and moves the execution to RUNNING. Terminal
   * executions are refused (`EXECUTION_NOT_RESUMABLE`); a live concurrent
   * run is refused with the retryable `EXECUTION_LOCKED`. An execution whose
   * approval is still undecided is not terminal — it is paused, so the caller
   * gets the pause signal again (`ApprovalPendingError`) and the record is
   * left untouched.
   */
  async beginRun(executionId: string): Promise<ExecutionRecord> {
    const record = await this.load(executionId)
    this.assertNotTerminal(record)
    // Only the persisted program may run on resume (Invariant 2): without it there is nothing to resume.
    if (record.originalCode === undefined) throw new ExecutionNotResumableError(executionId, record.status)
    if (record.pendingApprovalId) {
      const approval = await this.store.getApproval(record.pendingApprovalId)
      if (approval && approval.status === APPROVAL_STATUS.PENDING) {
        throw new ApprovalPendingError(executionId, approval.activitySequence, approval.approvalId, approval.summary)
      }
    }
    // The lock — not the RUNNING status — is the concurrency guard: a RUNNING
    // record whose lock is free is a run that died mid-flight (process crash)
    // and may be resumed from its journal; a RUNNING record whose lock is held
    // is a live concurrent run and is refused.
    const locked = await this.store.acquireLock(executionId)
    if (!locked) throw new ExecutionLockedError(executionId)
    try {
      // Re-read under the lock: a concurrent run may have finished between load and acquire.
      const fresh = await this.load(executionId)
      this.assertNotTerminal(fresh)
      fresh.status = EXECUTION_STATUS.RUNNING
      fresh.runCount += 1
      fresh.updatedAt = this.now()
      await this.store.updateExecution(fresh)
      return fresh
    } catch (err) {
      await this.store.releaseLock(executionId)
      throw err
    }
  }

  /** Records how the run ended and releases the lock. Always call this after `beginRun` succeeded. */
  async endRun(executionId: string, outcome: RunOutcome): Promise<ExecutionRecord> {
    try {
      const record = await this.load(executionId)
      record.updatedAt = this.now()
      delete record.terminalReason
      switch (outcome.kind) {
        case 'completed':
          record.status = EXECUTION_STATUS.COMPLETED
          record.result = outcome.result
          delete record.pendingApprovalId
          break
        case 'waitingApproval':
          record.status = EXECUTION_STATUS.WAITING_APPROVAL
          record.pendingApprovalId = outcome.approvalId
          break
        case 'interrupted':
          record.status = EXECUTION_STATUS.INTERRUPTED
          record.terminalReason = { code: outcome.code, message: outcome.message }
          break
        case 'failed':
          record.status = EXECUTION_STATUS.FAILED
          record.terminalReason = { code: outcome.code, message: outcome.message }
          break
        case 'denied':
          record.status = EXECUTION_STATUS.DENIED
          record.terminalReason = { code: outcome.code, message: outcome.message }
          break
        case 'cancelled':
          record.status = EXECUTION_STATUS.CANCELLED
          record.terminalReason = { code: outcome.code, message: outcome.message }
          break
      }
      this.settle(record)
      await this.store.updateExecution(record)
      this.options.onStateChange?.(executionId)
      return record
    } finally {
      await this.store.releaseLock(executionId)
    }
  }

  /** Advances the high-water mark of assigned activity sequences. */
  async recordProgress(executionId: string, sequence: number): Promise<void> {
    const record = await this.load(executionId)
    if (sequence > record.currentActivity) {
      record.currentActivity = sequence
      record.updatedAt = this.now()
      await this.store.updateExecution(record)
    }
  }

  /** Applies a human decision's consequence to the execution (called by the approval service). */
  async markApprovalDecided(executionId: string, status: 'DENIED' | 'CANCELLED' | 'WAITING_APPROVAL', reason?: { code: string; message: string }): Promise<void> {
    const record = await this.load(executionId)
    record.status = status
    record.updatedAt = this.now()
    if (reason) record.terminalReason = reason
    this.settle(record)
    await this.store.updateExecution(record)
    this.options.onStateChange?.(executionId)
  }

  async inspect(executionId: string): Promise<ExecutionInspection> {
    const execution = await this.load(executionId)
    const [activities, approvals, decisions] = await Promise.all([
      this.store.listActivities(executionId),
      this.store.listApprovals(executionId),
      this.store.listDecisions(executionId)
    ])
    return { execution, activities, approvals, decisions, history: buildHistory(execution, activities, approvals, decisions) }
  }

  /**
   * A terminal execution never runs again, so its program text is no longer
   * needed: dropped unless EXECUTION_CODE_RETENTION=KEEP. It is stamped with
   * when it finished and, under EXECUTION_RETENTION_SEC, when the retention
   * sweep may delete it. Paused and interrupted executions get neither — they
   * resume from their code and are never swept.
   */
  private settle(record: ExecutionRecord): void {
    if (!TERMINAL_STATUSES.has(record.status)) return
    if ((this.options.codeRetention ?? EXECUTION_CODE_RETENTION.DROP) === EXECUTION_CODE_RETENTION.DROP) {
      delete record.originalCode
    }
    record.finishedAt = record.updatedAt
    const retentionSec = this.options.retentionSec ?? 0
    if (retentionSec > 0) {
      record.expiresAt = new Date(Date.parse(record.finishedAt) + retentionSec * 1000).toISOString()
    }
  }

  private assertNotTerminal(record: ExecutionRecord): void {
    const terminal: string[] = [
      EXECUTION_STATUS.COMPLETED, EXECUTION_STATUS.FAILED, EXECUTION_STATUS.DENIED, EXECUTION_STATUS.CANCELLED
    ]
    if (terminal.includes(record.status)) {
      throw new ExecutionNotResumableError(record.executionId, record.status)
    }
  }
}

/**
 * Chronological history (§34) derived from the records — the store never
 * holds a separate event log that could drift from the facts.
 */
export function buildHistory(
  execution: ExecutionRecord,
  activities: ActivityRecord[],
  approvals: ApprovalRecord[],
  decisions: GovernanceDecisionRecord[]
): ExecutionHistoryEntry[] {
  const entries: ExecutionHistoryEntry[] = []
  entries.push({ at: execution.createdAt, kind: 'EXECUTION', event: 'CREATED', detail: execution.service })
  for (const a of activities) {
    const label = `${a.request.method} ${a.request.specPath}`
    entries.push({ at: a.createdAt, sequence: a.sequence, kind: 'ACTIVITY', event: 'ENCOUNTERED', detail: label })
    if (a.status !== ACTIVITY_STATUS.WAITING_APPROVAL || a.updatedAt !== a.createdAt) {
      entries.push({
        at: a.updatedAt, sequence: a.sequence, kind: 'ACTIVITY', event: a.status,
        detail: a.response ? `HTTP ${a.response.status}` : a.failure ? a.failure.code : label
      })
    }
  }
  for (const d of decisions) {
    entries.push({
      at: d.evaluatedAt, sequence: d.activitySequence, kind: 'GOVERNANCE', event: d.decision,
      detail: d.matchedRules.length ? `${d.reason} (${d.matchedRules.join(', ')})` : d.reason
    })
  }
  for (const ap of approvals) {
    entries.push({ at: ap.createdAt, sequence: ap.activitySequence, kind: 'APPROVAL', event: 'REQUESTED', detail: ap.approvalId })
    if (ap.decidedAt) {
      entries.push({ at: ap.decidedAt, sequence: ap.activitySequence, kind: 'APPROVAL', event: ap.status, detail: ap.decidedVia })
    }
  }
  if (execution.status !== EXECUTION_STATUS.CREATED && execution.status !== EXECUTION_STATUS.RUNNING) {
    entries.push({
      at: execution.updatedAt, kind: 'EXECUTION', event: execution.status,
      detail: execution.terminalReason?.code
    })
  }
  // Stable sort by time; ties keep insertion order (execution → activities → decisions → approvals).
  return entries
    .map((e, i) => ({ e, i }))
    .sort((x, y) => x.e.at.localeCompare(y.e.at) || x.i - y.i)
    .map(({ e }) => e)
}
