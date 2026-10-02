// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { ExecutionPersistence } from '../../spi/execution/execution-store.js'
import type {
  ExecutionRecord,
  ActivityRecord,
  ApprovalRecord,
  GovernanceDecisionRecord
} from '../../core/types/execution.types.js'
import { EXECUTION_STORE_TYPE } from '../../core/constants.js'

/** Deep copy so callers never alias store state (records are plain JSON). */
function clone<T>(value: T): T {
  return structuredClone(value)
}

/**
 * Process-local store. Durable across MCP requests and V8 isolates (the
 * whole point), not across process restarts — use the `file` store for that.
 * Subclasses hook `persist()` to write through.
 */
export class InMemoryExecutionStore implements ExecutionPersistence {
  readonly name: string = EXECUTION_STORE_TYPE.IN_MEMORY
  protected readonly executions = new Map<string, ExecutionRecord>()
  /** executionId → (sequence → activity) */
  protected readonly activities = new Map<string, Map<number, ActivityRecord>>()
  protected readonly approvals = new Map<string, ApprovalRecord>()
  protected readonly decisions = new Map<string, GovernanceDecisionRecord[]>()
  private readonly locks = new Set<string>()

  async createExecution(record: ExecutionRecord): Promise<void> {
    if (this.executions.has(record.executionId)) {
      throw new Error(`Execution ${record.executionId} already exists`)
    }
    this.executions.set(record.executionId, clone(record))
    await this.persist(record.executionId)
  }

  async getExecution(executionId: string): Promise<ExecutionRecord | undefined> {
    const rec = this.executions.get(executionId)
    return rec ? clone(rec) : undefined
  }

  async updateExecution(record: ExecutionRecord): Promise<void> {
    if (!this.executions.has(record.executionId)) {
      throw new Error(`Execution ${record.executionId} does not exist`)
    }
    this.executions.set(record.executionId, clone(record))
    await this.persist(record.executionId)
  }

  async deleteExecution(executionId: string): Promise<void> {
    this.executions.delete(executionId)
    this.activities.delete(executionId)
    this.decisions.delete(executionId)
    for (const [approvalId, approval] of this.approvals) {
      if (approval.executionId === executionId) this.approvals.delete(approvalId)
    }
    this.locks.delete(executionId)
  }

  async listExpiredExecutions(now: string, limit: number): Promise<string[]> {
    return [...this.executions.values()]
      .filter(e => e.expiresAt !== undefined && e.expiresAt <= now)
      .sort((a, b) => (a.expiresAt as string).localeCompare(b.expiresAt as string))
      .slice(0, limit)
      .map(e => e.executionId)
  }

  async putActivity(record: ActivityRecord): Promise<void> {
    let bySeq = this.activities.get(record.executionId)
    if (!bySeq) {
      bySeq = new Map()
      this.activities.set(record.executionId, bySeq)
    }
    bySeq.set(record.sequence, clone(record))
    await this.persist(record.executionId)
  }

  async getActivity(executionId: string, sequence: number): Promise<ActivityRecord | undefined> {
    const rec = this.activities.get(executionId)?.get(sequence)
    return rec ? clone(rec) : undefined
  }

  async listActivities(executionId: string): Promise<ActivityRecord[]> {
    const bySeq = this.activities.get(executionId)
    if (!bySeq) return []
    return [...bySeq.values()].sort((a, b) => a.sequence - b.sequence).map(clone)
  }

  async putApproval(record: ApprovalRecord): Promise<void> {
    this.approvals.set(record.approvalId, clone(record))
    await this.persist(record.executionId)
  }

  async getApproval(approvalId: string): Promise<ApprovalRecord | undefined> {
    const rec = this.approvals.get(approvalId)
    return rec ? clone(rec) : undefined
  }

  async listApprovals(executionId: string): Promise<ApprovalRecord[]> {
    return [...this.approvals.values()]
      .filter(a => a.executionId === executionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(clone)
  }

  async putDecision(record: GovernanceDecisionRecord): Promise<void> {
    const list = this.decisions.get(record.executionId) ?? []
    list.push(clone(record))
    this.decisions.set(record.executionId, list)
    await this.persist(record.executionId)
  }

  async listDecisions(executionId: string): Promise<GovernanceDecisionRecord[]> {
    return (this.decisions.get(executionId) ?? [])
      .slice()
      .sort((a, b) => a.evaluatedAt.localeCompare(b.evaluatedAt))
      .map(clone)
  }

  async acquireLock(executionId: string): Promise<boolean> {
    if (this.locks.has(executionId)) return false
    this.locks.add(executionId)
    return true
  }

  async releaseLock(executionId: string): Promise<void> {
    this.locks.delete(executionId)
  }

  /** Write-through hook for durable subclasses; no-op here. */
  protected async persist(_executionId: string): Promise<void> {}

  /** Everything known about one execution, for durable subclasses and inspection. */
  protected snapshot(executionId: string): ExecutionSnapshot | undefined {
    const execution = this.executions.get(executionId)
    if (!execution) return undefined
    return {
      execution: clone(execution),
      activities: [...(this.activities.get(executionId)?.values() ?? [])]
        .sort((a, b) => a.sequence - b.sequence).map(clone),
      approvals: [...this.approvals.values()].filter(a => a.executionId === executionId).map(clone),
      decisions: (this.decisions.get(executionId) ?? []).map(clone)
    }
  }

  /** Rehydrate one execution from a snapshot (durable subclasses at boot). */
  protected restore(snap: ExecutionSnapshot): void {
    this.executions.set(snap.execution.executionId, clone(snap.execution))
    this.activities.set(snap.execution.executionId, new Map(snap.activities.map(a => [a.sequence, clone(a)])))
    for (const a of snap.approvals) this.approvals.set(a.approvalId, clone(a))
    this.decisions.set(snap.execution.executionId, snap.decisions.map(clone))
  }
}

export interface ExecutionSnapshot {
  execution: ExecutionRecord
  activities: ActivityRecord[]
  approvals: ApprovalRecord[]
  decisions: GovernanceDecisionRecord[]
}

export function inMemoryExecutionStore(): ExecutionPersistence {
  return new InMemoryExecutionStore()
}
