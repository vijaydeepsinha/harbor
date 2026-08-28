// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { v4 as uuidv4 } from 'uuid'
import type { CodeModeStore } from '../../spi/execution/execution-store.js'
import type { ExecutionManager } from './execution-manager.js'
import {
  type ApprovalRecord,
  type ApprovalSummary,
  ApprovalNotFoundError,
  ApprovalAlreadyDecidedError
} from '../../core/types/execution.types.js'
import { APPROVAL_STATUS, ACTIVITY_STATUS, EXECUTION_STATUS, ERR, GOVERNANCE_REASON, type ApprovalStatus } from '../../core/constants.js'

/** The three outcomes MCP elicitation distinguishes (§24), plus the form content. */
export interface ApprovalDecisionInput {
  action: 'accept' | 'decline' | 'cancel'
  /** Form field: an `accept` with `approve: false` is a rejection, not an approval. */
  approve?: boolean
  comment?: string
  via: 'mcp-elicitation' | 'http'
}

export interface ApprovalDecisionResult {
  approval: ApprovalRecord
  /** What the execution may do next. */
  outcome: 'APPROVED' | 'REJECTED' | 'CANCELLED'
}

/** Shape of the embedded form elicitation the tool returns inside `input_required`. */
export interface ApprovalElicitation {
  message: string
  requestedSchema: {
    type: 'object'
    properties: Record<string, { type: 'boolean' | 'string'; title?: string; description?: string; default?: boolean | string }>
    required: string[]
  }
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
    const approval = await this.get(approvalId)
    if (approval.status !== APPROVAL_STATUS.PENDING) throw new ApprovalAlreadyDecidedError(approvalId, approval.status)

    const outcome = mapDecision(input)
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

    const activity = await this.store.getActivity(approval.executionId, approval.activitySequence)
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
        type: 'object',
        properties: {
          approve: { type: 'boolean', title: 'Approve this operation?', description: 'true executes it; false denies it' },
          comment: { type: 'string', title: 'Comment', description: 'Optional note kept with the decision' }
        },
        required: ['approve']
      }
    }
  }
}

function mapDecision(input: ApprovalDecisionInput): ApprovalDecisionResult['outcome'] {
  switch (input.action) {
    case 'accept': return input.approve === false ? 'REJECTED' : 'APPROVED'
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
