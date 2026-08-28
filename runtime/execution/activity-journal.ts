// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { CodeModeStore } from '../../spi/execution/execution-store.js'
import {
  type ActivityRecord,
  type ActivityRequestRecord,
  type ActivityResponseRecord,
  ReplayDivergedError
} from '../../core/types/execution.types.js'
import { ACTIVITY_STATUS } from '../../core/constants.js'

/**
 * The external-call journal of one execution, driven by one sandbox run
 * (§9–§15, §29). The cursor advances once per `api.request` the program
 * issues, in arrival order; the persisted record at that sequence — if any —
 * tells the bridge whether to replay, execute, pause or stop.
 *
 * Identity is `executionId + sequence`. No code or request hashing.
 */
export class ActivityJournal {
  private cursor = 0

  constructor(
    private readonly store: CodeModeStore,
    readonly executionId: string,
    readonly service: string,
    /** 1-based index of the sandbox run driving this journal (execution.runCount). */
    readonly runIndex: number,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  /** Highest sequence handed out by this run so far. */
  get position(): number {
    return this.cursor
  }

  /**
   * Assigns the next sequence to an encountered call and returns the record
   * already journaled at that sequence, if any. A record whose method or
   * resolved path differs from the encountered call is a replay divergence
   * and fails closed (§29): nothing is executed under the old history.
   */
  async next(request: ActivityRequestRecord): Promise<{ sequence: number; existing?: ActivityRecord }> {
    const sequence = ++this.cursor
    const existing = await this.store.getActivity(this.executionId, sequence)
    if (!existing) return { sequence }
    if (existing.request.method !== request.method || existing.request.specPath !== request.specPath) {
      throw new ReplayDivergedError(
        this.executionId, sequence,
        `${existing.request.method} ${existing.request.specPath}`,
        `${request.method} ${request.specPath}`
      )
    }
    return { sequence, existing }
  }

  /** Journals a call the bridge is about to make. Present on resume ⇒ the previous run died mid-call. */
  async markExecuting(sequence: number, request: ActivityRequestRecord, approvalId?: string): Promise<ActivityRecord> {
    return this.put(sequence, request, ACTIVITY_STATUS.EXECUTING, approvalId)
  }

  async recordResponse(sequence: number, response: ActivityResponseRecord): Promise<ActivityRecord> {
    const record = await this.mustGet(sequence)
    record.status = ACTIVITY_STATUS.COMPLETED
    record.response = response
    delete record.failure
    record.updatedAt = this.now()
    await this.store.putActivity(record)
    return record
  }

  /** `outcomeKnown: false` means the transport threw — the API may or may not have executed. */
  async recordFailure(sequence: number, failure: { code: string; message: string; outcomeKnown: boolean }): Promise<ActivityRecord> {
    const record = await this.mustGet(sequence)
    record.status = ACTIVITY_STATUS.FAILED
    record.failure = failure
    record.updatedAt = this.now()
    await this.store.putActivity(record)
    return record
  }

  async recordWaitingApproval(sequence: number, request: ActivityRequestRecord, approvalId: string): Promise<ActivityRecord> {
    return this.put(sequence, request, ACTIVITY_STATUS.WAITING_APPROVAL, approvalId)
  }

  async recordDenied(sequence: number, request: ActivityRequestRecord, approvalId?: string): Promise<ActivityRecord> {
    return this.put(sequence, request, ACTIVITY_STATUS.DENIED, approvalId)
  }

  private async put(
    sequence: number,
    request: ActivityRequestRecord,
    status: ActivityRecord['status'],
    approvalId?: string
  ): Promise<ActivityRecord> {
    const existing = await this.store.getActivity(this.executionId, sequence)
    const at = this.now()
    const record: ActivityRecord = {
      executionId: this.executionId,
      sequence,
      service: this.service,
      status,
      request,
      runIndex: existing?.runIndex ?? this.runIndex,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
      ...(approvalId ?? existing?.approvalId ? { approvalId: approvalId ?? existing?.approvalId } : {})
    }
    await this.store.putActivity(record)
    return record
  }

  private async mustGet(sequence: number): Promise<ActivityRecord> {
    const record = await this.store.getActivity(this.executionId, sequence)
    if (!record) throw new Error(`Activity #${sequence} of ${this.executionId} is not journaled`)
    return record
  }
}
