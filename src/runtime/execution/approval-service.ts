// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { v4 as uuidv4 } from 'uuid'
import type { ElicitRequestFormParams } from '@modelcontextprotocol/server'
import type { CodeModeStore } from '../../spi/execution/execution-store.js'
import type { ExecutionManager } from './execution-manager.js'
import {
  type ApprovalRecord,
  type ApprovalSummary,
  ApprovalNotFoundError,
  ApprovalAlreadyDecidedError,
  ApprovalAnswerInvalidError,
  ApprovalStaleError,
  ExecutionLockedError
} from '../../core/types/execution.types.js'
import { APPROVAL_STATUS, ACTIVITY_STATUS, EXECUTION_STATUS, ERR, GOVERNANCE_REASON, type ApprovalStatus } from '../../core/constants.js'

/** The three outcomes MCP elicitation distinguishes (§24), plus the form content. */
const TERMINAL_EXECUTION_STATUSES: ReadonlySet<string> = new Set([
  EXECUTION_STATUS.COMPLETED, EXECUTION_STATUS.FAILED, EXECUTION_STATUS.DENIED, EXECUTION_STATUS.CANCELLED
])

export interface ApprovalDecisionInput {
  action: 'accept' | 'decline' | 'cancel'
  /** Form field: `accept` approves only with `approve: true`; `approve: false` rejects; anything else is refused. */
  approve?: boolean
  comment?: string
  via: 'mcp-elicitation' | 'http'
  /**
   * The execution the caller believes this approval belongs to. Required so
   * that the pairing is asserted here, at the mutation point, rather than
   * left to each caller: `decide` locks and mutates the approval's *own*
   * execution, so a caller authorized against a different one would decide
   * an approval it never proved it owns.
   */
  executionId: string
}

export interface ApprovalDecisionResult {
  approval: ApprovalRecord
  /** What the execution may do next. */
  outcome: 'APPROVED' | 'REJECTED' | 'CANCELLED'
}

/** Shape of the embedded form elicitation the tool returns inside `input_required` (the SDK's wire type). */
export interface ApprovalElicitation {
  message: string
  requestedSchema: ElicitRequestFormParams['requestedSchema']
}

/**
 * Human approval bound to exactly one activity of one execution (§24–§25).
 * A decision is applied once: it updates the approval, the activity it is
 * bound to, and — for rejections and cancellations — the execution. An
 * approved activity is executed only by the next run, through the bridge,
 * never here (Invariant 8).
 */
export class ApprovalService {
  constructor(
    private readonly store: CodeModeStore,
    private readonly manager: ExecutionManager,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly newId: () => string = uuidv4
  ) {}

  async request(executionId: string, activitySequence: number, summary: ApprovalSummary): Promise<ApprovalRecord> {
    const approval: ApprovalRecord = {
      approvalId: this.newId(),
      executionId,
      activitySequence,
      status: APPROVAL_STATUS.PENDING,
      summary,
      createdAt: this.now()
    }
    await this.store.putApproval(approval)
    return approval
  }

  async get(approvalId: string): Promise<ApprovalRecord> {
    const approval = await this.store.getApproval(approvalId)
    if (!approval) throw new ApprovalNotFoundError(approvalId)
    return approval
  }

  async decide(approvalId: string, input: ApprovalDecisionInput): Promise<ApprovalDecisionResult> {
    const observed = await this.get(approvalId)
    // Before anything is locked or mutated: this approval must belong to the
    // execution the caller named. Reported as "not found" so a caller cannot
    // probe for approvals on executions it does not own.
    if (observed.executionId !== input.executionId) {
      throw new ApprovalNotFoundError(approvalId)
    }
    if (observed.status !== APPROVAL_STATUS.PENDING) {
      throw new ApprovalAlreadyDecidedError(approvalId, observed.status)
    }
    if (!await this.store.acquireLock(observed.executionId)) {
      throw new ExecutionLockedError(observed.executionId)
    }

    try {
      const approval = await this.get(approvalId)
      if (approval.status !== APPROVAL_STATUS.PENDING) {
        throw new ApprovalAlreadyDecidedError(approvalId, approval.status)
      }
      return await this.applyDecision(approval, input)
    } finally {
      await this.store.releaseLock(observed.executionId)
    }
  }

  private async applyDecision(approval: ApprovalRecord, input: ApprovalDecisionInput): Promise<ApprovalDecisionResult> {
    const outcome = mapDecision(approval.approvalId, input)
    // Under the lock, before anything changes: the approval must still be
    // the question its execution is waiting on. A PENDING approval left on a
    // finished execution, or one whose activity was re-asked under a new
    // approval, would otherwise flip a COMPLETED execution to DENIED or
    // CANCELLED, or rewrite another approval's activity.
    const execution = await this.manager.load(approval.executionId)
    if (TERMINAL_EXECUTION_STATUSES.has(execution.status)) {
      throw new ApprovalStaleError(approval.approvalId, `execution ${execution.executionId} is ${execution.status}`)
    }
    const activity = await this.store.getActivity(approval.executionId, approval.activitySequence)
    if (activity && (activity.status !== ACTIVITY_STATUS.WAITING_APPROVAL || activity.approvalId !== approval.approvalId)) {
      throw new ApprovalStaleError(approval.approvalId, `activity #${approval.activitySequence} is ${activity.status}${activity.approvalId && activity.approvalId !== approval.approvalId ? ` under approval ${activity.approvalId}` : ''}`)
    }
    const status: ApprovalStatus =
      outcome === 'APPROVED' ? APPROVAL_STATUS.APPROVED
      : outcome === 'REJECTED' ? APPROVAL_STATUS.REJECTED
      : APPROVAL_STATUS.CANCELLED
    const decided: ApprovalRecord = {
      ...approval,
      status,
      decidedAt: this.now(),
      decidedVia: input.via,
      ...(input.comment ? { comment: input.comment } : {})
    }
    await this.store.putApproval(decided)

    if (activity) {
      activity.status =
        outcome === 'APPROVED' ? ACTIVITY_STATUS.APPROVED
        : outcome === 'REJECTED' ? ACTIVITY_STATUS.DENIED
        : ACTIVITY_STATUS.CANCELLED
      activity.updatedAt = decided.decidedAt as string
      await this.store.putActivity(activity)
    }

    if (outcome === 'REJECTED') {
      await this.manager.markApprovalDecided(approval.executionId, EXECUTION_STATUS.DENIED, {
        code: ERR.GOVERNANCE_DENIED,
        message: `${GOVERNANCE_REASON.APPROVAL_REJECTED}: activity #${approval.activitySequence} (${approval.summary.method} ${approval.summary.specPath})`
      })
    } else if (outcome === 'CANCELLED') {
      await this.manager.markApprovalDecided(approval.executionId, EXECUTION_STATUS.CANCELLED, {
        code: ERR.EXECUTION_CANCELLED,
        message: `${GOVERNANCE_REASON.APPROVAL_CANCELLED}: activity #${approval.activitySequence}`
      })
    }
    // APPROVED: the execution stays WAITING_APPROVAL with a decided approval — resumable.
    return { approval: decided, outcome }
  }

  /**
   * The form elicitation shown to the approver. Says what, where, with which
   * values, and why — never headers or credentials (the summary carries none).
   */
  buildElicitation(approval: ApprovalRecord): ApprovalElicitation {
    const s = approval.summary
    const lines = [
      'Harbor needs your approval before executing an external operation.',
      '',
      `Execution: ${approval.executionId}`,
      `Activity:  #${approval.activitySequence}`,
      `Service:   ${s.service}`,
      `Operation: ${s.operationId ?? '(no operationId)'} — ${s.method} ${s.specPath}`,
      ...(s.pathParams && Object.keys(s.pathParams).length ? [`Path:      ${compact(s.pathParams)}`] : []),
      ...(s.query !== undefined ? [`Query:     ${compact(s.query)}`] : []),
      ...(s.body !== undefined ? [`Body:      ${compact(s.body)}`] : []),
      '',
      `Why:       ${s.reason}` + (s.matchedRules.length ? ` [rules: ${s.matchedRules.join(', ')}]` : ''),
      '',
      'Approve to execute this operation once; decline to deny it; cancel to abandon the execution.'
    ]
    return {
      message: lines.join('\n'),
      requestedSchema: {
        type: 'object' as const,
        properties: {
          approve: { type: 'boolean' as const, title: 'Approve this operation?', description: 'true executes it; false denies it' },
          comment: { type: 'string' as const, title: 'Comment', description: 'Optional note kept with the decision' }
        },
        required: ['approve']
      }
    }
  }
}

/**
 * `accept` is a form submission, not a decision: its `approve` field is.
 * Only `approve: true` approves; a missing or non-boolean value is refused
 * rather than read as a yes (the form declares the field required).
 */
function mapDecision(approvalId: string, input: ApprovalDecisionInput): ApprovalDecisionResult['outcome'] {
  switch (input.action) {
    case 'accept':
      if (input.approve === true) return 'APPROVED'
      if (input.approve === false) return 'REJECTED'
      throw new ApprovalAnswerInvalidError(approvalId)
    case 'decline': return 'REJECTED'
    case 'cancel': return 'CANCELLED'
  }
}

/** Single-line JSON, capped so an approval prompt never balloons. */
function compact(value: unknown, max = 600): string {
  let text: string
  try {
    text = JSON.stringify(value) ?? String(value)
  } catch {
    text = String(value)
  }
  return text.length > max ? `${text.slice(0, max)}… (${text.length - max} more chars)` : text
}
