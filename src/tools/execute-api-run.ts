// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {createHash} from 'node:crypto'
import type {ServiceResources} from '../runtime/registry/service-registry.js'
import type {TokenPayload} from '../core/types/auth.types.js'
import type {Logger} from '../core/types/logger.types.js'
import {
  type ExecutionBridge,
  type GovernanceVerdict,
  runApiInSandbox,
  type SandboxExecutionContext
} from '../runtime/sandbox/execute-api-in-sandbox.js'
import {
  type ActivityRequestRecord,
  ApprovalAlreadyDecidedError,
  type ExecutionRecord,
  RunOutcomeNotRecordedError
} from '../core/types/execution.types.js'
import type {MetricsCollector} from '../core/types/metrics.types.js'
import {persistenceFailureReporter, type PersistenceFailureReporter} from '../runtime/execution/persistence-failure.js'
import type {GovernanceRuntime} from '../runtime/execution/governance-runtime.js'
import type {ResumeState} from '../runtime/execution/request-state.js'
import {ActivityJournal, CallLog, type CallLogSource} from '../runtime/execution/activity-journal.js'
import {resolveOperation} from '../runtime/governance/operation-resolver.js'
import {evaluateGovernance} from '../runtime/governance/rule-evaluator.js'
import {
  APPROVAL_STATUS,
  ERR,
  EXECUTION_STATUS,
  type ExecutionStatus,
  GOVERNANCE_DECISION,
  LOG_PREFIX,
  PERSISTENCE_OPERATION,
  RUN_OUTCOME
} from '../core/constants.js'
import {ensureError, errorCode as getErrorCode, errorRetryable} from '../core/utils/errors.js'
import {classifyFailure, runOutcomeFor} from './execute-api-outcome.js'
import type {ApprovalAnswer, McpRequestView, ResumeRequest} from './mcp-request-view.js'

/** Why a call was answered without running anything. */
export interface Refusal {
    message: string
    code: string
    retryable: boolean
    /** Merged into the error payload: the ids a client needs to act on it. */
    extra?: Record<string, unknown>
    /** Present ⇒ the response's `_meta` names the execution, with this status and approval. */
    meta?: { status?: ExecutionStatus; approvalId?: string }
}

/** What one `api_execute` call came to. The responder turns it into metrics, audit and the MCP result. */
export type ApiExecuteResult =
/** Nothing ran: the resume was refused, or the human's answer it carried ended the execution. */
    | { kind: 'refused'; executionId: string; refusal: Refusal }
    /** A retry without an answer while the approval is still pending: ask again. */
    | { kind: 'askAgain'; executionId: string; approvalId: string; state: ResumeState }
    | { kind: 'completed'; executionId?: string; program: string; calls: CallLogSource; result: unknown }
    /**
     * The run failed, paused or was stopped — or never started (beginRun refused
     * it: locked, finished, approval still pending). `status` is what the
     * response reports: the recorded outcome, or the read-back status after a
     * failed settlement. Omitted when the stored status cannot be confirmed.
     */
    | {
    kind: 'failed';
    executionId?: string;
    program: string;
    calls: CallLogSource;
    error: unknown;
    status?: ExecutionStatus
}

export interface ApiExecuteRunInput {
    service: string
    /** The program as this caller sent it. On a resume the persisted original runs instead. */
    code: string
    request: McpRequestView
    resources: ServiceResources
    tokenPayload: TokenPayload
    invalidate: () => Promise<void>
    userIdHash: string
}

export interface ApiExecuteRunDeps {
    /** Absent ⇒ legacy behaviour: no durable execution, no governance. */
    governanceRuntime?: GovernanceRuntime
    logger: Logger
    /** Counts secondary persistence failures (`execution_persistence_failures_total`). */
    metrics?: MetricsCollector
    /** The caller's X-Harbor-Client-ID from the inbound request, forwarded on every backend call. */
    callerClientId?: string
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
    EXECUTION_STATUS.COMPLETED, EXECUTION_STATUS.FAILED, EXECUTION_STATUS.DENIED, EXECUTION_STATUS.CANCELLED
])

/**
 * The run orchestrator of one `api_execute` call, past authentication:
 * which execution the call belongs to (a new one, or a resume that applies
 * the human's answer), the run lock, the sandbox run, and the run's outcome
 * in the store. It owns the execution lifecycle and nothing else — metrics,
 * audit and the MCP result belong to the responder, which works from the
 * report returned here. Never throws: every failure is a `failed` report.
 */
export async function runApiExecute(input: ApiExecuteRunInput, deps: ApiExecuteRunDeps): Promise<ApiExecuteResult> {
    const {governanceRuntime, logger} = deps
    const {service, code, request, resources, userIdHash} = input
    const {correlationId} = request
    // Every call's outcome is recorded once, in the run's CallLog — the
    // execution's durable activity journal once a governed run starts. Audit
    // and progress are read-only projections of it.
    let calls: CallLog = new CallLog()
    let executionId: string | undefined
    // What actually runs: the persisted original on a resume (the incoming code is ignored then).
    let program = code
    // True once beginRun took the run lock — only then is there a run to end.
    let started = false
    const reportPersistenceFailure = persistenceFailureReporter(logger, deps.metrics, correlationId)
    let result: unknown
    try {
        let bridge: ExecutionBridge | undefined
        if (governanceRuntime) {
            const opened = await openExecution(governanceRuntime, request.resume, {
                service,
                code,
                userIdHash
            }, logger, correlationId)
            if (opened.kind !== 'open') return opened
            executionId = opened.execution.executionId
            const execution = await governanceRuntime.executionManager.beginRun(executionId)
            started = true
            program = execution.originalCode ?? code
            bridge = makeBridge(governanceRuntime, execution, resources, reportPersistenceFailure)
            calls = bridge.journal
        }

        logger.info({
            correlationId,
            service,
            executionId,
            step: '3/4 sandbox-run'
        }, `${LOG_PREFIX.MCP} Executing code in V8 sandbox...`)
        result = await runApiInSandbox(program, sandboxContext(input, deps, program, executionId, bridge, calls))
    } catch (error) {
        const {status} = classifyFailure(error)
        let reported: ExecutionStatus | undefined = status
        // beginRun may itself have thrown (locked, not resumable, approval still
        // pending) — then no run started, there is no lock to release and the
        // stored execution must stay exactly as it was.
        if (governanceRuntime && executionId !== undefined && started) {
            const outcome = runOutcomeFor(error, status, getErrorCode(error), ensureError(error).message)
            // Preserve the program's error even if settlement fails, but metadata
            // must describe the observed record, not the write we intended.
            try {
                await governanceRuntime.executionManager.endRun(executionId, outcome)
            } catch (e) {
                const persisted = await readBackSettlement(governanceRuntime, executionId, reportPersistenceFailure)
                reported = persisted?.status
                reportPersistenceFailure({
                    operation: PERSISTENCE_OPERATION.RUN_END,
                    executionId,
                    intended: status,
                    left: reported ?? 'unknown',
                    recovery: 'inspect the execution and lock; if resumable, replay the journal to record the outcome',
                    error: ensureError(e)
                })
            }
        }
        // When no run started nothing changed, so the response reports the
        // execution as it is stored — not the status this error would have given a run.
        if (!started && governanceRuntime && executionId !== undefined) {
            reported = await governanceRuntime.executionManager.load(executionId).then(r => r.status, () => undefined)
        }
        return {
            kind: 'failed', ...(executionId !== undefined ? {executionId} : {}), program, calls, error,
            ...(reported !== undefined ? {status: reported} : {})
        }
    }

    if (governanceRuntime && executionId !== undefined) {
        try {
            await governanceRuntime.executionManager.endRun(executionId, {kind: RUN_OUTCOME.COMPLETED, result})
        } catch (e) {
            // A rejected write may have applied, or only lock release may have
            // failed. Never overwrite completion or assume the record is RUNNING.
            const persisted = await readBackSettlement(governanceRuntime, executionId, reportPersistenceFailure)
            reportPersistenceFailure({
                operation: PERSISTENCE_OPERATION.RUN_END, executionId, intended: EXECUTION_STATUS.COMPLETED,
                left: persisted?.status ?? 'unknown',
                recovery: persisted?.status === EXECUTION_STATUS.COMPLETED
                    ? 'completion is recorded; return the persisted result, do not resume or resubmit; inspect any retained lock'
                    : 'inspect the execution and lock; if resumable, replay the journal to record the result',
                error: ensureError(e)
            })
            if (persisted?.status === EXECUTION_STATUS.COMPLETED) {
                return {kind: 'completed', executionId, program, calls, result: persisted.result}
            }
            return {
                kind: 'failed', executionId, program, calls, error: new RunOutcomeNotRecordedError(executionId),
                ...(persisted !== undefined ? {status: persisted.status} : {})
            }
        }
    }
    return {kind: 'completed', ...(executionId !== undefined ? {executionId} : {}), program, calls, result}
}

async function readBackSettlement(
    governanceRuntime: GovernanceRuntime, executionId: string, reportFailure: PersistenceFailureReporter
): Promise<ExecutionRecord | undefined> {
    try {
        return await governanceRuntime.executionManager.load(executionId)
    } catch (error) {
        reportFailure({
            operation: PERSISTENCE_OPERATION.RUN_END, executionId,
            intended: 'read execution status after an ambiguous settlement',
            left: 'unknown',
            recovery: 'restore persistence and inspect the execution before attempting a resume',
            error: ensureError(error)
        })
        return undefined
    }
}

function sandboxContext(
    input: ApiExecuteRunInput,
    deps: ApiExecuteRunDeps,
    program: string,
    executionId: string | undefined,
    bridge: ExecutionBridge | undefined,
    calls: CallLog
): SandboxExecutionContext {
    const {service, resources, tokenPayload, invalidate, userIdHash, request} = input
    // A governed run's calls are keyed by the execution (the bridge adds the
    // activity sequence): two executions of the same program are two intents
    // and must never share a key, while a resume of one keeps it. Without an
    // execution (legacy) the key is per user + program, so an agent retrying
    // the identical tool call is deduplicated.
    const idempotencyKey = executionId !== undefined
        ? `mcp-${service}-${executionId}`
        : `mcp-${service}-${userIdHash.slice(0, 12)}-${createHash('sha256').update(program).digest('hex').slice(0, 16)}`
    return {
        tokenPayload,
        invalidate,
        apiClient: resources.apiClient,
        circuitBreaker: resources.circuitBreaker,
        permissionGuard: resources.permissionGuard,
        idempotencyKey,
        idempotencyKeyTtlMs: resources.idempotencyKeyTtlMs,
        // A correlation id scopes one MCP request and the sandbox run it starts.
        // The execution id links separate runs across approval resumes.
        correlationId: request.correlationId,
        ...(executionId !== undefined ? {executionId} : {}),
        ...(deps.callerClientId !== undefined ? {clientId: deps.callerClientId} : {}),
        limits: resources.sandboxLimits,
        ...(bridge ? {executionBridge: bridge} : {callLog: calls})
    }
}

type Opened =
    | { kind: 'open'; execution: ExecutionRecord }
    | Extract<ApiExecuteResult, { kind: 'refused' | 'askAgain' }>

/**
 * Decides which execution this call belongs to (§6, §7, §26):
 *  - an MRTR retry carries a sealed `requestState` (verified by the SDK) and the human's answer;
 *  - a client without elicitation resumes via `_meta["harbor/execution-id"]` after deciding over HTTP;
 *  - otherwise this is a new program and its code is persisted as the authoritative original.
 * Incoming `code` is ignored on resume.
 */
async function openExecution(
    governanceRuntime: GovernanceRuntime,
    resume: ResumeRequest,
    input: { service: string; code: string; userIdHash: string },
    logger: Logger,
    correlationId: string
): Promise<Opened> {
    const {state} = resume
    const resumeId = state?.executionId ?? resume.executionId
    if (resumeId === undefined) {
        const execution = await governanceRuntime.executionManager.create({
            service: input.service,
            code: input.code,
            userIdHash: input.userIdHash
        })
        logger.info({correlationId, executionId: execution.executionId}, 'Execution created')
        return {kind: 'open', execution}
    }
    const refuse = (refusal: Refusal): Opened => ({kind: 'refused', executionId: resumeId, refusal})

    let execution: ExecutionRecord
    try {
        execution = await governanceRuntime.executionManager.load(resumeId)
    } catch (err) {
        return refuse({message: ensureError(err).message, code: getErrorCode(err), retryable: errorRetryable(err)})
    }
    // Principal binding: the sealed state and the stored execution both name the caller.
    if ((state && state.userIdHash !== input.userIdHash) || execution.userIdHash !== input.userIdHash) {
        return refuse({
            message: 'This execution belongs to a different principal',
            code: ERR.EXECUTION_NOT_RESUMABLE,
            retryable: false
        })
    }
    if (execution.service !== input.service) {
        return refuse({
            message: `Execution ${resumeId} runs against service "${execution.service}", not "${input.service}"`,
            code: ERR.EXECUTION_NOT_RESUMABLE,
            retryable: false
        })
    }
    if (execution.originalCode !== undefined && input.code !== execution.originalCode) {
        logger.warn({
            correlationId,
            executionId: resumeId
        }, 'Resume carried different code — ignored; the persisted original program is authoritative')
    }

    if (state) {
        if (resume.answer) {
            const ended = await applyAnswer(governanceRuntime, state, resume.answer, execution, logger, correlationId)
            if (ended) return refuse(ended)
        } else if (execution.status === EXECUTION_STATUS.WAITING_APPROVAL) {
            // The client retried without answering: ask again (spec allows repeated input_required).
            const approval = await governanceRuntime.approvals.get(state.approvalId)
            if (approval.status === APPROVAL_STATUS.PENDING) {
                return {kind: 'askAgain', executionId: resumeId, approvalId: approval.approvalId, state}
            }
        }
    }
    // A decision a crash or a store outage cut short is completed before
    // anything runs: the run must meet the activity the human approved (or
    // the end of the execution they rejected), not the old question again.
    await governanceRuntime.approvals.completeDecisions(resumeId)
    return {kind: 'open', execution: await governanceRuntime.executionManager.load(resumeId)}
}

/**
 * Applies the human's answer an MRTR retry carries. Returns the refusal
 * when the answer itself ended the execution (decline, cancel) or cannot be
 * applied; `undefined` when the execution may run.
 */
async function applyAnswer(
    governanceRuntime: GovernanceRuntime,
    state: ResumeState,
    answer: ApprovalAnswer,
    execution: ExecutionRecord,
    logger: Logger,
    correlationId: string
): Promise<Refusal | undefined> {
    const ids = {executionId: state.executionId, approvalId: state.approvalId}
    try {
        const decided = await governanceRuntime.approvals.decide(state.approvalId, {
            action: answer.action,
            executionId: state.executionId,
            ...(answer.approve !== undefined ? {approve: answer.approve} : {}),
            ...(answer.comment !== undefined ? {comment: answer.comment} : {}),
            via: 'mcp-elicitation'
        })
        logger.info({correlationId, ...ids, outcome: decided.outcome}, 'Approval decided via MCP elicitation')
        // The human's answer may end the execution here and now — report that consequence, not a failed resume.
        if (decided.outcome === APPROVAL_STATUS.REJECTED) {
            return {
                message: `Approval rejected for activity #${state.activitySequence}; the execution is denied and the operation was not executed.`,
                code: ERR.GOVERNANCE_DENIED,
                retryable: false,
                extra: ids,
                meta: {status: EXECUTION_STATUS.DENIED, approvalId: state.approvalId}
            }
        }
        if (decided.outcome === APPROVAL_STATUS.CANCELLED) {
            return {
                message: `Approval cancelled for activity #${state.activitySequence}; the execution is cancelled and the operation was not executed.`,
                code: ERR.EXECUTION_CANCELLED,
                retryable: false,
                extra: ids,
                meta: {status: EXECUTION_STATUS.CANCELLED, approvalId: state.approvalId}
            }
        }
        return undefined
    } catch (err) {
        if (!(err instanceof ApprovalAlreadyDecidedError)) {
            return {
                message: ensureError(err).message,
                code: getErrorCode(err),
                retryable: errorRetryable(err),
                meta: {status: execution.status}
            }
        }
        // Already decided. A retry carrying the *same* answer (the client
        // retried after a lost response) resumes; a different answer — a
        // decline arriving after an HTTP approve — must not quietly run the
        // approved call on the decliner's behalf.
        const asked = answer.action === 'cancel' ? APPROVAL_STATUS.CANCELLED
            : answer.action === 'decline' || answer.approve === false ? APPROVAL_STATUS.REJECTED
                : APPROVAL_STATUS.APPROVED
        // Only while the execution could still run: a finished one is refused as not resumable by beginRun.
        if (err.status !== asked && !TERMINAL_STATUSES.has(execution.status)) {
            return {
                message: `${err.message}; this answer (${asked}) was not applied and nothing was executed.`,
                code: ERR.APPROVAL_ALREADY_DECIDED,
                retryable: false,
                extra: ids,
                meta: {status: execution.status, approvalId: state.approvalId}
            }
        }
        return undefined
    }
}

/** The hooks the bridge calls: OpenAPI resolution and governance for new activities. */
function makeBridge(
    governanceRuntime: GovernanceRuntime,
    execution: ExecutionRecord,
    svc: ServiceResources,
    onPersistenceFailure: PersistenceFailureReporter
): ExecutionBridge {
    const journal = new ActivityJournal(governanceRuntime.persistence, execution.executionId, svc.name, execution.runCount, {onPersistenceFailure})
    return {
        journal,
        resolve: (method, rawPath) => resolveOperation(svc.specStore.getSpec(), method, rawPath),
        decide: async (sequence: number, request: ActivityRequestRecord): Promise<GovernanceVerdict> => {
            const outcome = evaluateGovernance({
                gatewayRules: governanceRuntime.gatewayRules(),
                serviceRules: governanceRuntime.rulesForService(svc.name)
            }, {
                executionId: execution.executionId, activitySequence: sequence, service: svc.name,
                method: request.method, specPath: request.specPath,
                ...(request.operationId !== undefined ? {operationId: request.operationId} : {}),
                ...(request.pathParams !== undefined ? {pathParams: request.pathParams} : {}),
                ...(request.query !== undefined ? {query: request.query} : {}),
                ...(request.body !== undefined ? {body: request.body} : {})
            }, governanceRuntime.executionConfig.governance.defaultDecision)
            await governanceRuntime.persistence.putDecision({
                executionId: execution.executionId, activitySequence: sequence,
                decision: outcome.decision, reason: outcome.reason,
                matchedRules: outcome.matchedRules, ruleVersions: outcome.ruleVersions,
                ...(outcome.decidingRule !== undefined ? {decidingRule: outcome.decidingRule} : {}),
                evaluatedAt: new Date().toISOString()
            })
            await governanceRuntime.executionManager.recordProgress(execution.executionId, sequence)
            switch (outcome.decision) {
                case GOVERNANCE_DECISION.ALLOW:
                    return {decision: GOVERNANCE_DECISION.ALLOW}
                case GOVERNANCE_DECISION.DENY:
                    return {
                        decision: GOVERNANCE_DECISION.DENY,
                        reason: outcome.reason,
                        matchedRules: outcome.matchedRules
                    }
                case GOVERNANCE_DECISION.REQUIRE_APPROVAL: {
                    const summary = {
                        service: svc.name, method: request.method, specPath: request.specPath,
                        ...(request.operationId !== undefined ? {operationId: request.operationId} : {}),
                        ...(request.pathParams !== undefined ? {pathParams: request.pathParams} : {}),
                        ...(request.query !== undefined ? {query: request.query} : {}),
                        ...(request.body !== undefined ? {body: request.body} : {}),
                        reason: outcome.reason, matchedRules: outcome.matchedRules
                    }
                    const approval = await governanceRuntime.approvals.request(execution.executionId, sequence, summary)
                    return {decision: GOVERNANCE_DECISION.REQUIRE_APPROVAL, approvalId: approval.approvalId, summary}
                }
            }
        }
    }
}
