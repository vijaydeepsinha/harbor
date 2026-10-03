// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {v4 as uuidv4} from 'uuid'
import type {ElicitRequestFormParams} from '@modelcontextprotocol/server'
import type {ExecutionPersistence} from '../../spi/execution/execution-store.js'
import type {ExecutionManager} from './execution-manager.js'
import {
    ApprovalAlreadyDecidedError,
    ApprovalAnswerInvalidError,
    ApprovalNotFoundError,
    type ApprovalRecord,
    ApprovalStaleError,
    type ApprovalSummary,
    ExecutionLockedError
} from '../../core/types/execution.types.js'
import {
    ACTIVITY_STATUS,
    APPROVAL_ANSWER_WORDS,
    APPROVAL_STATUS,
    type ApprovalStatus,
    ERR,
    EXECUTION_STATUS,
    GOVERNANCE_REASON
} from '../../core/constants.js'

/** The three outcomes MCP elicitation distinguishes (§24), plus the form content. */
const TERMINAL_EXECUTION_STATUSES: ReadonlySet<string> = new Set([
    EXECUTION_STATUS.COMPLETED, EXECUTION_STATUS.FAILED, EXECUTION_STATUS.DENIED, EXECUTION_STATUS.CANCELLED
])

export interface ApprovalDecisionInput {
    action: 'accept' | 'decline' | 'cancel'
    /**
     * Form field, already read with {@link readApprovalAnswer}: `accept` approves only with `true`,
     * rejects with `false`; absent (no answer, or one that is not recognised) is refused.
     */
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
    outcome: Exclude<ApprovalStatus, typeof APPROVAL_STATUS.PENDING>
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
        private readonly persistence: ExecutionPersistence,
        private readonly manager: ExecutionManager,
        private readonly now: () => string = () => new Date().toISOString(),
        private readonly newId: () => string = uuidv4
    ) {
    }

    async request(executionId: string, activitySequence: number, summary: ApprovalSummary): Promise<ApprovalRecord> {
        const approval: ApprovalRecord = {
            approvalId: this.newId(),
            executionId,
            activitySequence,
            status: APPROVAL_STATUS.PENDING,
            summary,
            createdAt: this.now()
        }
        await this.persistence.putApproval(approval)
        return approval
    }

    async get(approvalId: string): Promise<ApprovalRecord> {
        const approval = await this.persistence.getApproval(approvalId)
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
        if (!await this.persistence.acquireLock(observed.executionId)) {
            throw observed.status !== APPROVAL_STATUS.PENDING
                ? new ApprovalAlreadyDecidedError(approvalId, observed.status)
                : new ExecutionLockedError(observed.executionId)
        }

        try {
            const approval = await this.get(approvalId)
            if (approval.status !== APPROVAL_STATUS.PENDING) {
                // Decided already — possibly by this very caller, before a crash or a
                // store outage cut the decision short. Finish what did not land, then
                // say so: an answer is never applied twice.
                await this.followDecision(approval)
                throw new ApprovalAlreadyDecidedError(approvalId, approval.status)
            }
            return await this.applyDecision(approval, input)
        } finally {
            await this.persistence.releaseLock(observed.executionId)
        }
    }

    /**
     * Completes every decision of this execution that was cut short — the
     * approval says decided, but its activity or its execution never followed
     * — so that a resume runs against a journal that agrees with the human.
     * Without it, an approved activity still WAITING_APPROVAL would pause every
     * resume on an approval that can no longer be answered. Takes the execution
     * lock; when the lock is held, a run or a decision is in progress and the
     * caller is about to be refused anyway, so nothing is done.
     */
    async completeDecisions(executionId: string): Promise<void> {
        if (!await this.persistence.acquireLock(executionId)) return
        try {
            for (const approval of await this.persistence.listApprovals(executionId)) {
                if (approval.status !== APPROVAL_STATUS.PENDING) await this.followDecision(approval)
            }
        } finally {
            await this.persistence.releaseLock(executionId)
        }
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
                    approve: {
                        type: 'boolean' as const,
                        title: 'Approve this operation?',
                        description: 'true executes it; false denies it'
                    },
                    comment: {
                        type: 'string' as const,
                        title: 'Comment',
                        description: 'Optional note kept with the decision'
                    }
                },
                required: ['approve']
            }
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
        const activity = await this.persistence.getActivity(approval.executionId, approval.activitySequence)
        if (activity && (activity.status !== ACTIVITY_STATUS.WAITING_APPROVAL || activity.approvalId !== approval.approvalId)) {
            throw new ApprovalStaleError(approval.approvalId, `activity #${approval.activitySequence} is ${activity.status}${activity.approvalId && activity.approvalId !== approval.approvalId ? ` under approval ${activity.approvalId}` : ''}`)
        }
        const decided: ApprovalRecord = {
            ...approval,
            status: outcome,
            decidedAt: this.now(),
            decidedVia: input.via,
            ...(input.comment ? {comment: input.comment} : {})
        }
        // The commit point. A decision is three writes — the approval, its
        // activity, and for a rejection or cancellation the execution — and no
        // store here offers a transaction across them. From this write on the
        // decision has happened; the rest only makes the records agree with it,
        // and is repeated if it is cut short (followDecision, completeDecisions).
        await this.persistence.putApproval(decided)
        await this.followDecision(decided)
        return {approval: decided, outcome}
    }

    /**
     * Makes the bound activity and — for a rejection or cancellation — the
     * execution agree with a decided approval. Idempotent: each step looks at
     * what is stored and writes only what has not happened yet, so it can run
     * again after a crash or a store outage stopped it part-way.
     */
    private async followDecision(decided: ApprovalRecord): Promise<void> {
        const activity = await this.persistence.getActivity(decided.executionId, decided.activitySequence)
        if (activity && activity.status === ACTIVITY_STATUS.WAITING_APPROVAL && activity.approvalId === decided.approvalId) {
            activity.status =
                decided.status === APPROVAL_STATUS.APPROVED ? ACTIVITY_STATUS.APPROVED
                    : decided.status === APPROVAL_STATUS.REJECTED ? ACTIVITY_STATUS.DENIED
                        : ACTIVITY_STATUS.CANCELLED
            activity.updatedAt = decided.decidedAt ?? this.now()
            await this.persistence.putActivity(activity)
        }
        // APPROVED: the execution stays WAITING_APPROVAL with a decided approval — resumable.
        if (decided.status === APPROVAL_STATUS.APPROVED || decided.status === APPROVAL_STATUS.PENDING) return
        const execution = await this.manager.load(decided.executionId)
        if (TERMINAL_EXECUTION_STATUSES.has(execution.status)) return
        if (decided.status === APPROVAL_STATUS.REJECTED) {
            await this.manager.markApprovalDecided(decided.executionId, EXECUTION_STATUS.DENIED, {
                code: ERR.GOVERNANCE_DENIED,
                message: `${GOVERNANCE_REASON.APPROVAL_REJECTED}: activity #${decided.activitySequence} (${decided.summary.method} ${decided.summary.specPath})`
            })
        } else {
            await this.manager.markApprovalDecided(decided.executionId, EXECUTION_STATUS.CANCELLED, {
                code: ERR.EXECUTION_CANCELLED,
                message: `${GOVERNANCE_REASON.APPROVAL_CANCELLED}: activity #${decided.activitySequence}`
            })
        }
    }
}

const APPROVE_WORDS: ReadonlySet<string> = new Set(APPROVAL_ANSWER_WORDS.APPROVE)
const REJECT_WORDS: ReadonlySet<string> = new Set(APPROVAL_ANSWER_WORDS.REJECT)

/**
 * Reads the `approve` answer as it arrives from a client: a boolean, or one
 * of the words in `APPROVAL_ANSWER_WORDS` ("yes", "approved", "no", …).
 * `undefined` means "not an answer" — numbers, null, the strings "true" and
 * "false", and any other text. Both approval channels (MCP elicitation and
 * HTTP) read the field through this one function, so they cannot disagree
 * about what counts as a yes.
 */
export function readApprovalAnswer(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') return value
    if (typeof value !== 'string') return undefined
    const word = value.trim().toLowerCase()
    if (APPROVE_WORDS.has(word)) return true
    if (REJECT_WORDS.has(word)) return false
    return undefined
}

/**
 * `accept` is a form submission, not a decision: its `approve` field is.
 * Only an affirmative answer approves; a missing or unrecognised value is
 * refused rather than read as a yes (the form declares the field required).
 */
function mapDecision(approvalId: string, input: ApprovalDecisionInput): ApprovalDecisionResult['outcome'] {
    switch (input.action) {
        case 'accept':
            if (input.approve === true) return APPROVAL_STATUS.APPROVED
            if (input.approve === false) return APPROVAL_STATUS.REJECTED
            throw new ApprovalAnswerInvalidError(approvalId)
        case 'decline':
            return APPROVAL_STATUS.REJECTED
        case 'cancel':
            return APPROVAL_STATUS.CANCELLED
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
