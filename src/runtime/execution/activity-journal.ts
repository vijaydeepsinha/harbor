// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { ExecutionPersistence } from '../../spi/execution/execution-store.js'
import {
  type ActivityRecord,
  type ActivityRequestRecord,
  type ActivityResponseRecord,
  ReplayDivergedError
} from '../../core/types/execution.types.js'
import { ACTIVITY_STATUS, type AllowedHttpMethod } from '../../core/constants.js'

/** Records whose request is about to be executed or is in front of a human: they bind query and body too. */
const CONTENT_BOUND: ReadonlySet<string> = new Set([
  ACTIVITY_STATUS.APPROVED, ACTIVITY_STATUS.WAITING_APPROVAL, ACTIVITY_STATUS.EXECUTING
])

/** Key-order-independent JSON, so `{a,b}` and `{b,a}` are the same request. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v) ?? 'undefined'
}

/** A call as audit, progress and the circuit breaker identify it: method + endpoint (OpenAPI template or normalized path). */
export interface CallIdentity {
  method: AllowedHttpMethod
  endpoint: string
}

/** What happened to one call in this run. */
export type JournalEntry = CallIdentity & (
  /** A COMPLETED activity from an earlier run; the recorded response was handed back, nothing was called. */
  | { outcome: 'REPLAYED'; sequence: number; response: ActivityResponseRecord }
  /** The external call was made and returned a response (any HTTP status). */
  | { outcome: 'EXECUTED'; sequence?: number; response: ActivityResponseRecord }
  /** The call threw after it was resolved (transport error, open circuit, abort, store failure). */
  | { outcome: 'FAILED'; sequence?: number; error: string; aborted: boolean }
)

/** Read side of a run's call outcomes — what the audit and progress projections consume. */
export interface CallLogSource {
  entries(): readonly JournalEntry[]
}

/**
 * The outcomes of the calls one run made, in completion order — the single
 * record audit (`AuditCollector`) and progress (`ProgressCollector`) are
 * derived from. Every run has one; on its own (no execution store — the
 * legacy path) it lives for the tool call and is never persisted. A governed
 * run uses {@link ActivityJournal}, which adds the durable record.
 */
export class CallLog implements CallLogSource {
  private readonly log: JournalEntry[] = []

  entries(): readonly JournalEntry[] {
    return this.log
  }

  recordReplayed(call: CallIdentity, sequence: number, response: ActivityResponseRecord): void {
    this.log.push({ ...call, outcome: 'REPLAYED', sequence, response })
  }

  /** The call returned. `sequence` names the journaled activity, when there is one. */
  async recordResponse(call: CallIdentity, response: ActivityResponseRecord, sequence?: number): Promise<void> {
    this.log.push({ ...call, outcome: 'EXECUTED', response, ...(sequence !== undefined ? { sequence } : {}) })
  }

  /** The call threw. `executingSequence` names the activity that was journaled as EXECUTING, when there is one. */
  async recordFailure(call: CallIdentity, failure: { code: string; message: string; aborted: boolean }, executingSequence?: number): Promise<void> {
    this.log.push({
      ...call, outcome: 'FAILED', error: failure.message, aborted: failure.aborted,
      ...(executingSequence !== undefined ? { sequence: executingSequence } : {})
    })
  }
}

/**
 * The external-call journal of one execution, driven by one sandbox run
 * (§9–§15, §29) — the single durable source of truth for what the program
 * did. The cursor advances once per `api.request` the program issues, in
 * arrival order; the persisted record at that sequence — if any — tells the
 * ActivityGate whether to replay, execute, pause or stop. As a CallLog it
 * also holds this run's outcomes, so audit and progress need no bookkeeping
 * of their own.
 *
 * Identity is `executionId + sequence`. No code or request hashing.
 */
export class ActivityJournal extends CallLog {
  private cursor = 0

  constructor(
    private readonly persistence: ExecutionPersistence,
    readonly executionId: string,
    readonly service: string,
    /** 1-based index of the sandbox run driving this journal (execution.runCount). */
    readonly runIndex: number,
    private readonly now: () => string = () => new Date().toISOString()
  ) {
    super()
  }

  /** Highest sequence handed out by this run so far. */
  get position(): number {
    return this.cursor
  }

  /**
   * Assigns the next sequence to an encountered call and returns the record
   * already journaled at that sequence, if any. A mismatch with that record
   * is a replay divergence and fails closed (§29): nothing is executed under
   * the old history.
   *
   * What must match depends on what the record is about to authorise. Every
   * record: method, resolved template and concrete path — a replayed response
   * must belong to the same resource. A record that will be *executed* or
   * *shown to a human* (APPROVED, WAITING_APPROVAL, an EXECUTING safe call):
   * query and body as well. An approval is for the request the human saw;
   * a program that reaches the same sequence with another resource, amount
   * or filter (a clock-dependent branch, or `Promise.all` siblings arriving
   * in a different order) must not inherit it.
   */
  async next(request: ActivityRequestRecord): Promise<{ sequence: number; existing?: ActivityRecord }> {
    const sequence = ++this.cursor
    const existing = await this.persistence.getActivity(this.executionId, sequence)
    if (!existing) return { sequence }
    const recorded = existing.request
    const diverged =
      recorded.method !== request.method || recorded.specPath !== request.specPath || recorded.rawPath !== request.rawPath
        ? 'path'
        : CONTENT_BOUND.has(existing.status) &&
          (canonicalJson(recorded.query) !== canonicalJson(request.query) || canonicalJson(recorded.body) !== canonicalJson(request.body))
          ? 'content'
          : undefined
    if (diverged) {
      const suffix = diverged === 'content' ? ' (query/body differ from the recorded request)' : ''
      throw new ReplayDivergedError(
        this.executionId, sequence,
        `${recorded.method} ${recorded.rawPath}`,
        `${request.method} ${request.rawPath}${suffix}`
      )
    }
    return { sequence, existing }
  }

  /** Journals a call the bridge is about to make. Present on resume ⇒ the previous run died mid-call. */
  async markExecuting(sequence: number, request: ActivityRequestRecord, approvalId?: string): Promise<ActivityRecord> {
    return this.put(sequence, request, ACTIVITY_STATUS.EXECUTING, approvalId)
  }

  /** Journaled activity ⇒ EXECUTING → COMPLETED with the response (replayable from now on); then the run's log. */
  override async recordResponse(call: CallIdentity, response: ActivityResponseRecord, sequence?: number): Promise<void> {
    if (sequence !== undefined) {
      const record = await this.mustGet(sequence)
      record.status = ACTIVITY_STATUS.COMPLETED
      record.response = response
      delete record.failure
      record.updatedAt = this.now()
      await this.persistence.putActivity(record)
    }
    await super.recordResponse(call, response, sequence)
  }

  /**
   * An activity journaled as EXECUTING whose call threw ⇒ FAILED with
   * `outcomeKnown: false`: Harbor does not know whether the API executed, and
   * a later run must not silently repeat it (§32). A store failure while
   * recording that is swallowed — the run is already failing. Then the run's log.
   */
  override async recordFailure(call: CallIdentity, failure: { code: string; message: string; aborted: boolean }, executingSequence?: number): Promise<void> {
    if (executingSequence !== undefined) {
      await this.mustGet(executingSequence).then(async record => {
        record.status = ACTIVITY_STATUS.FAILED
        record.failure = { code: failure.code, message: failure.message, outcomeKnown: false }
        record.updatedAt = this.now()
        await this.persistence.putActivity(record)
      }).catch(() => {})
    }
    await super.recordFailure(call, failure, executingSequence)
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
    const existing = await this.persistence.getActivity(this.executionId, sequence)
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
    await this.persistence.putActivity(record)
    return record
  }

  private async mustGet(sequence: number): Promise<ActivityRecord> {
    const record = await this.persistence.getActivity(this.executionId, sequence)
    if (!record) throw new Error(`Activity #${sequence} of ${this.executionId} is not journaled`)
    return record
  }
}
