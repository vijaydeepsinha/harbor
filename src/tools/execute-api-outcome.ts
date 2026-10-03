// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { CircuitOpenError } from '../core/types/circuit-breaker.types.js'
import { PermissionDeniedError } from '../core/types/permission.types.js'
import { SandboxCallLimitError, SandboxConcurrentLimitError } from '../core/types/sandbox-error.types.js'
import {
  ApprovalRequiredError,
  GovernanceDeniedError,
  ExecutionCancelledError,
  ReplayDivergedError,
  ActivityOutcomeUnknownError,
  RunOutcomeNotRecordedError
} from '../core/types/execution.types.js'
import type { RunOutcome } from '../runtime/execution/execution-manager.js'
import {
  OUTCOME, ERR, EXECUTION_STATUS, RUN_OUTCOME,
  EXECUTION_ID_META_KEY, EXECUTION_STATUS_META_KEY, APPROVAL_ID_META_KEY,
  type AuditOutcome, type ExecutionStatus
} from '../core/constants.js'
import { errorRetryable } from '../core/utils/errors.js'

/** How a failed `api_execute` call is accounted for — one answer, read by persistence, metrics and audit alike. */
export interface FailureClass {
  /** The audit record's and `tool_calls_total`'s outcome. */
  outcome: AuditOutcome
  /** The status the run leaves the execution in (governed runs). */
  status: ExecutionStatus
  /** Counted under `sandbox_errors`: resource limits and unexpected errors, not governance or permission outcomes. */
  sandboxError: boolean
  /** The circuit that opened, counted under `cb_opens`. */
  openedCircuit?: string
}

type ErrorClass = abstract new (...args: never[]) => Error

/**
 * Known failures, most specific first (`ApprovalPendingError` is an
 * `ApprovalRequiredError`). Anything else is an `error`: `INTERRUPTED` —
 * resumable — when it is retryable, `FAILED` otherwise.
 */
const FAILURES: ReadonlyArray<readonly [ErrorClass, Omit<FailureClass, 'openedCircuit'>]> = [
  [ApprovalRequiredError,       { outcome: OUTCOME.APPROVAL_REQUIRED,         status: EXECUTION_STATUS.WAITING_APPROVAL, sandboxError: false }],
  [GovernanceDeniedError,       { outcome: OUTCOME.GOVERNANCE_DENIED,         status: EXECUTION_STATUS.DENIED,           sandboxError: false }],
  [ExecutionCancelledError,     { outcome: OUTCOME.EXECUTION_CANCELLED,       status: EXECUTION_STATUS.CANCELLED,        sandboxError: false }],
  [ReplayDivergedError,         { outcome: OUTCOME.REPLAY_DIVERGED,           status: EXECUTION_STATUS.FAILED,           sandboxError: false }],
  [ActivityOutcomeUnknownError, { outcome: OUTCOME.ERROR,                     status: EXECUTION_STATUS.FAILED,           sandboxError: false }],
  // The store, not the program, failed: the execution is left RUNNING (lock released) for a resume to finish.
  [RunOutcomeNotRecordedError,  { outcome: OUTCOME.ERROR,                     status: EXECUTION_STATUS.RUNNING,          sandboxError: false }],
  [CircuitOpenError,            { outcome: OUTCOME.CIRCUIT_OPEN,              status: EXECUTION_STATUS.INTERRUPTED,      sandboxError: false }],
  [PermissionDeniedError,       { outcome: OUTCOME.PERMISSION_DENIED,         status: EXECUTION_STATUS.FAILED,           sandboxError: false }],
  [SandboxCallLimitError,       { outcome: OUTCOME.CALL_LIMIT_EXCEEDED,       status: EXECUTION_STATUS.FAILED,           sandboxError: true }],
  [SandboxConcurrentLimitError, { outcome: OUTCOME.CONCURRENT_LIMIT_EXCEEDED, status: EXECUTION_STATUS.FAILED,           sandboxError: true }]
]

export function classifyFailure(err: unknown): FailureClass {
  for (const [type, failure] of FAILURES) {
    if (err instanceof type) return err instanceof CircuitOpenError ? { ...failure, openedCircuit: err.endpoint } : { ...failure }
  }
  return {
    outcome: OUTCOME.ERROR,
    status: errorRetryable(err) ? EXECUTION_STATUS.INTERRUPTED : EXECUTION_STATUS.FAILED,
    sandboxError: true
  }
}

/** What `ExecutionManager.endRun` records for a run that failed with `err`, classified as `status`. */
export function runOutcomeFor(err: unknown, status: ExecutionStatus, code: string, message: string): RunOutcome {
  if (err instanceof ApprovalRequiredError) return { kind: RUN_OUTCOME.WAITING_APPROVAL, approvalId: err.approvalId }
  switch (status) {
    case EXECUTION_STATUS.DENIED: return { kind: RUN_OUTCOME.DENIED, code, message }
    case EXECUTION_STATUS.CANCELLED: return { kind: RUN_OUTCOME.CANCELLED, code, message }
    case EXECUTION_STATUS.INTERRUPTED: return { kind: RUN_OUTCOME.INTERRUPTED, code, message }
    default: return { kind: RUN_OUTCOME.FAILED, code, message }
  }
}

/** The audit outcome of a resume refused — or ended by the human's answer — before anything ran. */
export function refusalOutcome(code: string): AuditOutcome {
  return code === ERR.GOVERNANCE_DENIED ? OUTCOME.GOVERNANCE_DENIED
    : code === ERR.EXECUTION_CANCELLED ? OUTCOME.EXECUTION_CANCELLED
    : OUTCOME.ERROR
}

/** The `harbor/*` keys of a response's `_meta`: which execution, in which status, waiting on which approval. */
export function executionMeta(executionId?: string, status?: ExecutionStatus, approvalId?: string): Record<string, unknown> | undefined {
  if (!executionId) return undefined
  return {
    [EXECUTION_ID_META_KEY]: executionId,
    ...(status ? { [EXECUTION_STATUS_META_KEY]: status } : {}),
    ...(approvalId ? { [APPROVAL_ID_META_KEY]: approvalId } : {})
  }
}
