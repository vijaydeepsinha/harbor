// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import ivm from 'isolated-vm'
import { runInSandbox } from './sandbox-core.js'
import type { TokenPayload } from '../../core/types/auth.types.js'
import type { CircuitBreakerStrategy } from '../../core/types/circuit-breaker.types.js'
import { CircuitOpenError } from '../../core/types/circuit-breaker.types.js'
import type { PermissionGuard } from '../../core/types/permission.types.js'
import { PermissionDeniedError } from '../../core/types/permission.types.js'
import type { ConnectorAPI, ApiRequest, ApiResponse } from '../../spi/connector/connector-api.js'
import type { SandboxLimits } from '../../core/types/config.types.js'
import type { AuditCollector } from '../observability/audit.js'
import { type ProgressCollector, extractTopLevelIds } from '../observability/progress.js'
import { ERR, ACTIVITY_STATUS, ALLOWED_HTTP_METHODS, type AllowedHttpMethod } from '../../core/constants.js'
import { errorMessage, errorCode } from '../../core/utils/errors.js'
import { normalizeEndpointPath } from '../../core/utils/url.js'
import {
  SandboxError,
  SandboxCallLimitError,
  SandboxConcurrentLimitError,
  SandboxExecutionError,
  SandboxInvalidApiRequestError,
  type InvalidApiRequestReason
} from '../../core/types/sandbox-error.types.js'
import {
  type ActivityRequestRecord,
  type ApprovalSummary,
  ApprovalRequiredError,
  GovernanceDeniedError,
  ReplayDivergedError,
  ExecutionCancelledError,
  ActivityOutcomeUnknownError
} from '../../core/types/execution.types.js'
import type { ActivityJournal } from '../execution/activity-journal.js'
import type { ResolvedOperation } from '../governance/operation-resolver.js'

/**
 * What governance decided for a brand-new activity. `ALLOW` executes;
 * `DENY` stops; `REQUIRE_APPROVAL` pauses the execution on the given
 * approval. The decider persists its own decision record — the bridge only
 * acts on the verdict.
 */
export type GovernanceVerdict =
  | { decision: 'ALLOW' }
  | { decision: 'DENY'; reason: string; matchedRules: string[] }
  | { decision: 'REQUIRE_APPROVAL'; approvalId: string; summary: ApprovalSummary }

/**
 * Durable-execution hooks the tool layer supplies for governed runs. Absent
 * ⇒ legacy behaviour: no journal, no replay, no governance (every existing
 * test and deployment without an execution store keeps working).
 */
export interface ExecutionBridge {
  journal: ActivityJournal
  /** Resolves a concrete call against the service's OpenAPI document. */
  resolve: (method: AllowedHttpMethod, rawPath: string) => ResolvedOperation
  /** Governance for a new activity. Absent ⇒ ALLOW (journal + replay only). */
  decide?: (sequence: number, request: ActivityRequestRecord) => Promise<GovernanceVerdict>
}

export interface SandboxExecutionContext {
  tokenPayload: TokenPayload
  /** Evicts the cached token entry keyed by the user's original bearer. */
  invalidate: () => Promise<void>
  apiClient: ConnectorAPI
  circuitBreaker: CircuitBreakerStrategy
  /**
   * Per-token authorization policy. Checked for every `api.request` before the
   * outbound call goes out. The default `forwardTokenPermissionGuard` admits
   * every endpoint; a real policy can deny by throwing PermissionDeniedError.
   */
  permissionGuard: PermissionGuard
  idempotencyKey: string
  idempotencyKeyTtlMs: number
  correlationId: string
  sessionId: string
  auditCollector: AuditCollector
  /**
   * Optional. When supplied, the bridge records per-call progress (method,
   * normalized endpoint, status/ok, and id-like fields extracted from
   * successful create responses) so the tool layer can surface it to the
   * caller on failure. Lives on the host so progress is preserved even if
   * the isolate is disposed.
   */
  progressCollector?: ProgressCollector
  limits: SandboxLimits
  /** Optional. Durable execution: activity journal, replay, governance (see docs/code-mode-governance.md). */
  execution?: ExecutionBridge
}

/**
 * Tracks resource/policy violations that the bridge enforces during a run.
 * They are promoted to typed errors *after* `runInSandbox` settles so that
 * user code cannot mask them by catching the bridge-side error — audit and
 * metrics always reflect the precise outcome.
 */
type BridgeViolation =
  | { kind: 'call' }
  | { kind: 'concurrent' }
  | { kind: 'permission'; endpoint: string; method: AllowedHttpMethod }
  | { kind: 'invalidApiRequest'; reason: InvalidApiRequestReason; detail: string }
  | { kind: 'circuitOpen'; endpoint: string; retryAfterMs: number }
  // ── durable execution (terminal for the run: later calls are refused without executing) ──
  | { kind: 'approvalRequired'; sequence: number; approvalId: string; summary: ApprovalSummary }
  | { kind: 'governanceDenied'; sequence: number; reason: string; matchedRules: string[] }
  | { kind: 'replayDiverged'; error: ReplayDivergedError }
  | { kind: 'cancelled'; sequence: number }
  | { kind: 'outcomeUnknown'; sequence: number; label: string }

const RUN_STOPPING_KINDS: ReadonlySet<BridgeViolation['kind']> = new Set([
  'approvalRequired', 'governanceDenied', 'replayDiverged', 'cancelled', 'outcomeUnknown'
])

function bridgeError(code: string, message: string): string {
  return JSON.stringify({ __bridgeError: true, code, message })
}

/** Validates the argument user code passed to `api.request(...)`. The `as ApiRequest` cast is a compile-time fiction. */
type ApiRequestValidationResult =
  | { ok: true; apiRequest: ApiRequest }
  | { ok: false; reason: InvalidApiRequestReason; detail: string }

function validateApiRequest(raw: unknown): ApiRequestValidationResult {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, reason: 'bad-object', detail: 'api.request(arg): argument must be an object' }
  }
  const arg = raw as Record<string, unknown>
  if (typeof arg['path'] !== 'string' || arg['path'].length === 0) {
    return {
      ok: false,
      reason: 'bad-path',
      detail: 'api.request(arg): arg.path must be a non-empty string'
    }
  }
  if (
    typeof arg['method'] !== 'string' ||
    !(ALLOWED_HTTP_METHODS as readonly string[]).includes(arg['method'])
  ) {
    return {
      ok: false,
      reason: 'bad-method',
      detail: `api.request(arg): arg.method must be one of ${ALLOWED_HTTP_METHODS.join(', ')}`
    }
  }
  return {
    ok: true,
    apiRequest: {
      path: arg['path'],
      method: arg['method'] as AllowedHttpMethod,
      params: arg['params'] as ApiRequest['params'],
      body: arg['body'],
      headers: arg['headers'] as ApiRequest['headers']
    }
  }
}

function throwIfViolated(violation: BridgeViolation | null, limits: SandboxLimits, executionId?: string): void {
  if (!violation) return
  const id = executionId ?? 'unknown'
  switch (violation.kind) {
    case 'call':           throw new SandboxCallLimitError(limits.maxApiCalls)
    case 'concurrent':     throw new SandboxConcurrentLimitError(limits.maxConcurrentCalls)
    case 'permission':     throw new PermissionDeniedError(violation.endpoint, violation.method)
    case 'invalidApiRequest': throw new SandboxInvalidApiRequestError(violation.reason, violation.detail)
    case 'circuitOpen':    throw new CircuitOpenError(violation.endpoint, violation.retryAfterMs)
    case 'approvalRequired': throw new ApprovalRequiredError(id, violation.sequence, violation.approvalId, violation.summary)
    case 'governanceDenied': throw new GovernanceDeniedError(id, violation.sequence, violation.reason, violation.matchedRules)
    case 'replayDiverged': throw violation.error
    case 'cancelled':      throw new ExecutionCancelledError(id, violation.sequence)
    case 'outcomeUnknown': throw new ActivityOutcomeUnknownError(id, violation.sequence, violation.label)
  }
}

/** HTTP-safe methods may be re-issued after a crash mid-call; everything else fails closed. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET'])

function toRequestRecord(apiRequest: ApiRequest, resolved: ResolvedOperation): ActivityRequestRecord {
  return {
    method: apiRequest.method,
    rawPath: apiRequest.path,
    specPath: resolved.specPath,
    ...(resolved.operationId !== undefined ? { operationId: resolved.operationId } : {}),
    ...(Object.keys(resolved.pathParams).length ? { pathParams: resolved.pathParams } : {}),
    ...(apiRequest.params !== undefined ? { query: apiRequest.params } : {}),
    ...(apiRequest.body !== undefined ? { body: apiRequest.body } : {})
  }
}

export async function runApiInSandbox(
  userCode: string,
  ctx: SandboxExecutionContext
): Promise<unknown> {
  // See BridgeViolation — captured inside the bridge, promoted after
  // runInSandbox settles so the promotion is tamper-proof against user code.
  let violation: BridgeViolation | null = null
  const abortController = new AbortController()
  const execution = ctx.execution
  const executionId = execution?.journal.executionId

  const result = await runInSandbox(
    userCode,
    {
      memoryLimitMb: ctx.limits.memoryLimitMb,
      timeoutMs: ctx.limits.executeTimeoutMs,
      onDispose: () => abortController.abort()
    },
    async (jail, context, isolate) => {
      let totalCalls = 0
      let inFlight = 0

      await jail.set('__makeRequest', new ivm.Reference(
        async (apiRequestJson: string): Promise<string> => {
          // Once the run has paused or stopped (approval, denial, divergence,
          // unknown outcome) no further external call may proceed — user code
          // that caught the bridge error and kept going is refused here so the
          // journal and the real world stay in step (Invariant 8/9).
          if (violation && RUN_STOPPING_KINDS.has(violation.kind)) {
            return bridgeError(ERR.APPROVAL_REQUIRED, 'Execution is paused or stopped; no further api.request() calls are executed in this run')
          }
          totalCalls++
          if (totalCalls > ctx.limits.maxApiCalls) {
            violation = { kind: 'call' }
            return bridgeError(
              ERR.CALL_LIMIT_EXCEEDED,
              `Sandbox API call limit of ${ctx.limits.maxApiCalls} exceeded`
            )
          }
          if (inFlight >= ctx.limits.maxConcurrentCalls) {
            violation = { kind: 'concurrent' }
            return bridgeError(
              ERR.CONCURRENT_LIMIT_EXCEEDED,
              `Concurrent API call limit of ${ctx.limits.maxConcurrentCalls} exceeded`
            )
          }

          inFlight++
          // Hoisted so the failure path below can record progress with the
          // method/endpoint that was being attempted when the throw happened.
          let attemptedMethod: AllowedHttpMethod | undefined
          let attemptedPath: string | undefined
          // Sequence of the journaled activity this call became (governed runs only).
          let sequence: number | undefined
          let executing = false
          try {
            const validation = validateApiRequest(JSON.parse(apiRequestJson))
            if (!validation.ok) {
              violation = { kind: 'invalidApiRequest', reason: validation.reason, detail: validation.detail }
              return bridgeError(ERR.INVALID_API_REQUEST, validation.detail)
            }
            const { apiRequest } = validation
            // Endpoint identity: the OpenAPI template when an execution bridge
            // is present, the digit heuristic otherwise (legacy path).
            const resolved = execution?.resolve(apiRequest.method, apiRequest.path)
            const normalizedPath = resolved ? resolved.specPath : normalizeEndpointPath(apiRequest.path)
            attemptedMethod = apiRequest.method
            attemptedPath = normalizedPath

            let approvalId: string | undefined
            if (execution && resolved) {
              const requestRecord = toRequestRecord(apiRequest, resolved)
              const { sequence: seq, existing } = await execution.journal.next(requestRecord)
              sequence = seq
              const label = `${requestRecord.method} ${requestRecord.specPath}`

              if (existing) {
                switch (existing.status) {
                  case ACTIVITY_STATUS.COMPLETED: {
                    // Replay: the recorded response stands in for the external call (Invariant 4/10).
                    const stored = existing.response as ActivityResponseLike
                    ctx.progressCollector?.recordSuccess(
                      apiRequest.method, normalizedPath, stored.status, stored.ok,
                      apiRequest.method === 'POST' && stored.ok ? extractTopLevelIds(stored.data) : undefined
                    )
                    return JSON.stringify({ data: stored.data, status: stored.status, ok: stored.ok } satisfies ApiResponse)
                  }
                  case ACTIVITY_STATUS.APPROVED:
                    approvalId = existing.approvalId
                    break // execute below
                  case ACTIVITY_STATUS.WAITING_APPROVAL: {
                    violation = { kind: 'approvalRequired', sequence: seq, approvalId: existing.approvalId ?? '', summary: summaryOf(requestRecord, execution.journal.service) }
                    return bridgeError(ERR.APPROVAL_REQUIRED, `Activity #${seq} is waiting for approval`)
                  }
                  case ACTIVITY_STATUS.DENIED:
                    violation = { kind: 'governanceDenied', sequence: seq, reason: 'Activity was denied', matchedRules: [] }
                    return bridgeError(ERR.GOVERNANCE_DENIED, `Activity #${seq} was denied`)
                  case ACTIVITY_STATUS.CANCELLED:
                    violation = { kind: 'cancelled', sequence: seq }
                    return bridgeError(ERR.EXECUTION_CANCELLED, `Activity #${seq} was cancelled`)
                  case ACTIVITY_STATUS.FAILED:
                    violation = { kind: 'outcomeUnknown', sequence: seq, label }
                    return bridgeError(ERR.ACTIVITY_OUTCOME_UNKNOWN, `Activity #${seq} failed in a previous run`)
                  case ACTIVITY_STATUS.EXECUTING:
                    if (!SAFE_METHODS.has(existing.request.method)) {
                      violation = { kind: 'outcomeUnknown', sequence: seq, label }
                      return bridgeError(ERR.ACTIVITY_OUTCOME_UNKNOWN, `Activity #${seq} was in flight when a previous run ended`)
                    }
                    break // safe method: re-execute
                }
              } else if (execution.decide) {
                const verdict = await execution.decide(seq, requestRecord)
                if (verdict.decision === 'DENY') {
                  await execution.journal.recordDenied(seq, requestRecord)
                  violation = { kind: 'governanceDenied', sequence: seq, reason: verdict.reason, matchedRules: verdict.matchedRules }
                  return bridgeError(ERR.GOVERNANCE_DENIED, `Governance denied ${label}: ${verdict.reason}`)
                }
                if (verdict.decision === 'REQUIRE_APPROVAL') {
                  await execution.journal.recordWaitingApproval(seq, requestRecord, verdict.approvalId)
                  violation = { kind: 'approvalRequired', sequence: seq, approvalId: verdict.approvalId, summary: verdict.summary }
                  return bridgeError(ERR.APPROVAL_REQUIRED, `Approval required for ${label}`)
                }
              }

              if (!ctx.permissionGuard.canExecute(normalizedPath, apiRequest.method, ctx.tokenPayload)) {
                const denied = new PermissionDeniedError(normalizedPath, apiRequest.method)
                violation = { kind: 'permission', endpoint: normalizedPath, method: apiRequest.method }
                return bridgeError(denied.code, denied.message)
              }
              ctx.circuitBreaker.check(normalizedPath)
              await execution.journal.markExecuting(seq, requestRecord, approvalId)
              executing = true
            } else {
              if (!ctx.permissionGuard.canExecute(normalizedPath, apiRequest.method, ctx.tokenPayload)) {
                const denied = new PermissionDeniedError(normalizedPath, apiRequest.method)
                violation = { kind: 'permission', endpoint: normalizedPath, method: apiRequest.method }
                return bridgeError(denied.code, denied.message)
              }
              ctx.circuitBreaker.check(normalizedPath)
            }

            // Route through apiClient.request (not executeRequest) so the
            // configured idempotency strategy actually runs. For services with
            // idempotency type="noop" this is a passthrough; for in-memory /
            // memcache / couchbase it dedupes replays by idempotencyKey. Under
            // an execution the key gains the activity sequence so distinct
            // calls in one run never share a key.
            const response = await ctx.apiClient.request(
              apiRequest,
              {
                tokenPayload: ctx.tokenPayload,
                invalidate: ctx.invalidate,
                idempotencyKey: sequence !== undefined ? `${ctx.idempotencyKey}-${sequence}` : ctx.idempotencyKey,
                idempotencyKeyTtlMs: ctx.idempotencyKeyTtlMs,
                correlationId: ctx.correlationId,
                sessionId: ctx.sessionId,
                signal: abortController.signal
              }
            )

            if (execution && sequence !== undefined) {
              await execution.journal.recordResponse(sequence, { status: response.status, ok: response.ok, data: response.data })
            }

            // recordSuccess is intentional even on 4xx: client errors (bad
            // input from user code) should not trip the breaker — only 5xx
            // upstream failures do, and those throw before reaching here.
            ctx.circuitBreaker.recordSuccess(normalizedPath)
            ctx.auditCollector.record(apiRequest.method, normalizedPath)

            // Only extract ids for create-like calls (POST + ok). Avoids
            // leaking arbitrary response fields and matches the v1 scope.
            const ids =
              apiRequest.method === 'POST' && response.ok
                ? extractTopLevelIds(response.data)
                : undefined
            ctx.progressCollector?.recordSuccess(
              apiRequest.method,
              normalizedPath,
              response.status,
              response.ok,
              ids
            )

            return JSON.stringify(response)
          } catch (err) {
            // Replay divergence is terminal for the run: record it and stop.
            if (err instanceof ReplayDivergedError) {
              violation = { kind: 'replayDiverged', error: err }
              return bridgeError(err.code, err.message)
            }
            // CircuitOpenError is a control-plane signal that must bubble up
            // to the tool layer so metrics/audit record CIRCUIT_OPEN and the
            // client sees a retryable CIRCUIT_OPEN error. Capture it as a
            // violation so `throwIfViolated` promotes it after the sandbox
            // settles — user code still sees a bridge error and cannot mask
            // the promotion by catching it.
            if (err instanceof CircuitOpenError) {
              violation = { kind: 'circuitOpen', endpoint: err.endpoint, retryAfterMs: err.retryAfterMs }
            }
            // The transport threw after the call was journaled as EXECUTING:
            // Harbor does not know whether the API executed. Record that
            // honestly; a later run must not silently repeat it (§32).
            if (execution && executing && sequence !== undefined) {
              await execution.journal.recordFailure(sequence, {
                code: errorCode(err, ERR.API_ERROR), message: errorMessage(err), outcomeKnown: false
              }).catch(() => {})
            }
            // Record the attempt as a failure so the caller sees the last
            // endpoint we tried before bubbling the error up. `aborted`
            // distinguishes sandbox-dispose-driven cancellations from real
            // network/backend failures. Skip when validation failed (we have
            // no method/path to report and the bridgeError already conveys
            // the user-input mistake).
            if (attemptedMethod && attemptedPath) {
              ctx.progressCollector?.recordFailure(
                attemptedMethod,
                attemptedPath,
                errorMessage(err),
                abortController.signal.aborted
              )
            }
            return bridgeError(errorCode(err, ERR.API_ERROR), errorMessage(err))
          } finally {
            inFlight--
          }
        }
      ))

      const bootstrapScript = await isolate.compileScript(`
        const api = {
          request: async (apiRequest) => {
            const raw = await __makeRequest.apply(
              undefined,
              [JSON.stringify(apiRequest)],
              { arguments: { copy: true }, result: { promise: true, copy: true } }
            );
            const parsed = JSON.parse(raw);
            if (parsed.__bridgeError) {
              throw new Error(parsed.code + ': ' + parsed.message);
            }
            return parsed;
          }
        };
      `)
      await bootstrapScript.run(context)
    }
  ).catch((err: unknown) => {
    // Typed policy/limit error takes precedence if the bridge recorded one.
    throwIfViolated(violation, ctx.limits, executionId)
    // Pass typed sandbox errors through; wrap anything else to avoid leaking internals.
    if (err instanceof SandboxError) throw err
    throw new SandboxExecutionError(err)
  })

  // User code returned successfully but the bridge recorded a violation
  // (user code caught the bridge error and swallowed it). Promote to a
  // typed failure so the tool layer records an accurate outcome.
  throwIfViolated(violation, ctx.limits, executionId)

  return result
}

interface ActivityResponseLike { status: number; ok: boolean; data: unknown }

function summaryOf(request: ActivityRequestRecord, service: string): ApprovalSummary {
  return {
    service,
    method: request.method,
    specPath: request.specPath,
    ...(request.operationId !== undefined ? { operationId: request.operationId } : {}),
    ...(request.pathParams !== undefined ? { pathParams: request.pathParams } : {}),
    ...(request.query !== undefined ? { query: request.query } : {}),
    ...(request.body !== undefined ? { body: request.body } : {}),
    reason: 'Approval pending from a previous run',
    matchedRules: []
  }
}
