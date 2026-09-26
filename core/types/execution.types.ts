// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * Data model for the Code Mode governance layer (durable executions, the
 * external-call activity journal, governance decisions and human approvals).
 *
 * Design rule: the V8 isolate is ephemeral, the execution is durable. Every
 * record here is plain JSON so any store (in-memory, file, a database) can
 * persist it without translation. See docs/code-mode-governance.md.
 */

import {
  ERR,
  type ExecutionStatus,
  type ActivityStatus,
  type ApprovalStatus,
  type GovernanceDecisionType,
  type AllowedHttpMethod
} from '../constants.js'

// ── Records ──────────────────────────────────────────────────────────────────

export interface ExecutionRecord {
  executionId: string
  service: string
  /**
   * The program as first submitted. Authoritative for every resume (Invariant 2).
   * Stored before the first run — an interrupted or crashed run resumes from it —
   * and removed once the execution is terminal unless EXECUTION_CODE_RETENTION=KEEP.
   */
  originalCode?: string
  status: ExecutionStatus
  /** sha256 of the caller's user id (or token) — never the raw principal. */
  userIdHash: string
  createdAt: string
  updatedAt: string
  /** Highest activity sequence assigned so far (0 = none). */
  currentActivity: number
  /** Number of sandbox runs (initial run + resumes). */
  runCount: number
  /** Populated when status is FAILED / DENIED / CANCELLED. */
  terminalReason?: { code: string; message: string }
  /** Populated when status is WAITING_APPROVAL. */
  pendingApprovalId?: string
  /** Value the program returned when it COMPLETED. */
  result?: unknown
}

/** What the program asked the bridge to do. Volatile headers are never recorded. */
export interface ActivityRequestRecord {
  method: AllowedHttpMethod
  /** Path exactly as the program supplied it. */
  rawPath: string
  /** OpenAPI path template the call resolved to (or the normalized path when the spec has no match). */
  specPath: string
  /** OpenAPI `operationId` when the spec declares one. */
  operationId?: string
  /** `{param}` path segments — always strings (see ResolvedOperation.pathParams). */
  pathParams?: Record<string, string>
  /** Query parameters as the program passed them; values may be nested objects/arrays. */
  query?: Record<string, unknown>
  /** Request body as the program passed it — any JSON shape, including nested DTOs. */
  body?: unknown
}

export interface ActivityResponseRecord {
  status: number
  ok: boolean
  data: unknown
}

export interface ActivityRecord {
  executionId: string
  /** 1-based, monotonic within the execution, assigned in call-arrival order. */
  sequence: number
  service: string
  status: ActivityStatus
  request: ActivityRequestRecord
  response?: ActivityResponseRecord
  /** Set when status is FAILED. `outcomeKnown: false` means the transport threw — the API may or may not have executed. */
  failure?: { code: string; message: string; outcomeKnown: boolean }
  /** Which sandbox run first encountered this activity. */
  runIndex: number
  createdAt: string
  updatedAt: string
  /** Approval bound to this activity, if governance required one. */
  approvalId?: string
}

export interface GovernanceDecisionRecord {
  executionId: string
  activitySequence: number
  decision: GovernanceDecisionType
  reason: string
  /** Names of every rule that matched (precedence applied afterwards). */
  matchedRules: string[]
  /** `name@version#contentHash12` for each matched rule — enough to audit which rule text decided. */
  ruleVersions: string[]
  /** Which rule's action won under precedence, if any. */
  decidingRule?: string
  evaluatedAt: string
}

export interface ApprovalRecord {
  approvalId: string
  executionId: string
  activitySequence: number
  status: ApprovalStatus
  /** Human-readable summary presented to the approver (no secrets). */
  summary: ApprovalSummary
  createdAt: string
  decidedAt?: string
  /** Free-text comment supplied with the decision, if any. */
  comment?: string
  /** Who decided: `mcp-elicitation` (the connected client's user) or `http` (the fallback endpoint). */
  decidedVia?: 'mcp-elicitation' | 'http'
}

export interface ApprovalSummary {
  service: string
  method: AllowedHttpMethod
  specPath: string
  operationId?: string
  pathParams?: Record<string, string>
  query?: Record<string, unknown>
  body?: unknown
  /** Why approval is required — the matched rule names and the reason text. */
  reason: string
  matchedRules: string[]
}

/** One line of the chronological execution history (§34). */
export interface ExecutionHistoryEntry {
  at: string
  sequence?: number
  kind: 'EXECUTION' | 'ACTIVITY' | 'GOVERNANCE' | 'APPROVAL'
  event: string
  detail?: string
}

// ── Typed errors (control-plane signals raised at the bridge) ────────────────

/** Common shape: `code` from ERR and a `retryable` flag, like every other Harbor domain error. */
export class ExecutionError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean
  ) {
    super(message)
    this.name = 'ExecutionError'
  }
}

/** Governance required a human decision; the run pauses here and the isolate is disposed. */
export class ApprovalRequiredError extends ExecutionError {
  constructor(
    readonly executionId: string,
    readonly activitySequence: number,
    readonly approvalId: string,
    readonly summary: ApprovalSummary
  ) {
    super(
      `Approval required for activity #${activitySequence} (${summary.method} ${summary.specPath}). ` +
      `The execution is paused; it resumes after a human decision.`,
      ERR.APPROVAL_REQUIRED, false
    )
    this.name = 'ApprovalRequiredError'
  }
}

/**
 * A resume arrived before the human decided the approval the execution is
 * waiting on. This is the same pause signal as {@link ApprovalRequiredError},
 * not a termination: nothing ran, no lock was taken, and the execution stays
 * WAITING_APPROVAL — it resumes once the approval is decided.
 */
export class ApprovalPendingError extends ApprovalRequiredError {
  constructor(executionId: string, activitySequence: number, approvalId: string, summary: ApprovalSummary) {
    super(executionId, activitySequence, approvalId, summary)
    this.message =
      `Approval ${approvalId} for activity #${activitySequence} (${summary.method} ${summary.specPath}) is still pending. ` +
      `The execution is paused; it resumes after a human decision.`
    this.name = 'ApprovalPendingError'
  }
}

/** A Governance Rule denied the operation, or a human rejected the approval. */
export class GovernanceDeniedError extends ExecutionError {
  constructor(
    readonly executionId: string,
    readonly activitySequence: number,
    readonly reason: string,
    readonly matchedRules: string[]
  ) {
    super(
      `Governance denied activity #${activitySequence}: ${reason}` +
      (matchedRules.length ? ` (rules: ${matchedRules.join(', ')})` : ''),
      ERR.GOVERNANCE_DENIED, false
    )
    this.name = 'GovernanceDeniedError'
  }
}

/** On resume the program issued a different call at a sequence that already has a record. Fail closed. */
export class ReplayDivergedError extends ExecutionError {
  constructor(
    readonly executionId: string,
    readonly activitySequence: number,
    readonly recorded: string,
    readonly encountered: string
  ) {
    super(
      `Replay diverged at activity #${activitySequence}: recorded "${recorded}" but the program issued "${encountered}". ` +
      `Execution stopped; nothing was executed under the old history.`,
      ERR.REPLAY_DIVERGED, false
    )
    this.name = 'ReplayDivergedError'
  }
}

/** Another run of the same execution is in progress. */
export class ExecutionLockedError extends ExecutionError {
  constructor(readonly executionId: string) {
    super(`Execution ${executionId} is already running. Retry after it pauses or completes.`, ERR.EXECUTION_LOCKED, true)
    this.name = 'ExecutionLockedError'
  }
}

export class ExecutionNotFoundError extends ExecutionError {
  constructor(readonly executionId: string) {
    super(`Unknown execution ${executionId}`, ERR.EXECUTION_NOT_FOUND, false)
    this.name = 'ExecutionNotFoundError'
  }
}

/** The execution is in a terminal state (or not waiting) and cannot be resumed. */
export class ExecutionNotResumableError extends ExecutionError {
  constructor(readonly executionId: string, readonly status: ExecutionStatus) {
    super(`Execution ${executionId} cannot be resumed from status ${status}`, ERR.EXECUTION_NOT_RESUMABLE, false)
    this.name = 'ExecutionNotResumableError'
  }
}

/** A human cancelled the pending approval; the execution ends without executing the activity. */
export class ExecutionCancelledError extends ExecutionError {
  constructor(readonly executionId: string, readonly activitySequence: number) {
    super(`Execution ${executionId} was cancelled at activity #${activitySequence}`, ERR.EXECUTION_CANCELLED, false)
    this.name = 'ExecutionCancelledError'
  }
}

/** A previous run died while this activity's external call was in flight; Harbor cannot know whether it executed. */
export class ActivityOutcomeUnknownError extends ExecutionError {
  constructor(readonly executionId: string, readonly activitySequence: number, readonly label: string) {
    super(
      `Activity #${activitySequence} (${label}) was in flight when a previous run ended; ` +
      `Harbor cannot tell whether the API executed it, so it will not be repeated. Inspect the execution and start a new one.`,
      ERR.ACTIVITY_OUTCOME_UNKNOWN, false
    )
    this.name = 'ActivityOutcomeUnknownError'
  }
}

export class ApprovalNotFoundError extends ExecutionError {
  constructor(readonly approvalId: string) {
    super(`Unknown approval ${approvalId}`, ERR.APPROVAL_NOT_FOUND, false)
    this.name = 'ApprovalNotFoundError'
  }
}

/** Approvals are single-use: a second decision on the same approval is refused, never re-applied. */
export class ApprovalAlreadyDecidedError extends ExecutionError {
  constructor(readonly approvalId: string, readonly status: ApprovalStatus) {
    super(`Approval ${approvalId} was already decided (${status})`, ERR.APPROVAL_ALREADY_DECIDED, false)
    this.name = 'ApprovalAlreadyDecidedError'
  }
}
