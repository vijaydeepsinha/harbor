// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { CircuitOpenError } from '../../core/types/circuit-breaker.types.js'
import { PermissionDeniedError } from '../../core/types/permission.types.js'
import type { ApiRequest, ApiResponse } from '../../spi/connector/connector-api.js'
import { ERR, ALLOWED_HTTP_METHODS, type AllowedHttpMethod } from '../../core/constants.js'
import { errorMessage, errorCode } from '../../core/utils/errors.js'
import { normalizeEndpointPath } from '../../core/utils/url.js'
import {
  SandboxCallLimitError,
  SandboxConcurrentLimitError,
  SandboxInvalidApiRequestError,
  type InvalidApiRequestReason
} from '../../core/types/sandbox-error.types.js'
import {
  type ActivityResponseRecord,
  ApprovalRequiredError,
  GovernanceDeniedError,
  ReplayDivergedError,
  ExecutionCancelledError,
  ActivityOutcomeUnknownError
} from '../../core/types/execution.types.js'
import { ActivityGate, type ActivityAdmission, type ActivityStop } from '../execution/activity-gate.js'
import { CallLog, type CallIdentity } from '../execution/activity-journal.js'
import type { SandboxExecutionContext } from './execute-api-in-sandbox.js'
import { canonicalizeRequestPath } from './request-path.js'

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
  | ActivityStop
  | { kind: 'replayDiverged'; error: ReplayDivergedError }

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
  const rawParams = arg['params'] ?? undefined
  if (rawParams !== undefined && (typeof rawParams !== 'object' || Array.isArray(rawParams))) {
    return { ok: false, reason: 'bad-params', detail: 'api.request(arg): arg.params must be an object of query parameters' }
  }
  // Governance, the journal and the connector all see this one spelling of
  // the path — never the raw string (see request-path.ts).
  const canonical = canonicalizeRequestPath(arg['path'], rawParams as Record<string, unknown> | undefined)
  if (!canonical.ok) return { ok: false, reason: 'bad-path', detail: canonical.detail }
  return {
    ok: true,
    apiRequest: {
      path: canonical.path,
      method: arg['method'] as AllowedHttpMethod,
      ...(canonical.params !== undefined ? { params: canonical.params as ApiRequest['params'] } : {}),
      body: arg['body'],
      headers: arg['headers'] as ApiRequest['headers']
    }
  }
}

/**
 * The host side of `api.request()` for one sandbox run — the only door out
 * of the isolate. Each call goes through the same fixed pipeline:
 *
 *   admit (run stopped? call / concurrency limits) → validate → resolve the
 *   endpoint → gate (replay / governance, governed runs only) → authorize
 *   (permission guard, circuit breaker) → execute (ConnectorAPI) → record
 *
 * Replay and governance are not decided here: the {@link ActivityGate} owns
 * them. Call outcomes are recorded once, in the run's journal (CallLog /
 * ActivityJournal); audit and progress are projections of it. This class
 * owns only the run's bookkeeping — call counters and the violation that
 * `throwIfViolated` promotes once the isolate has settled. One instance per
 * run; nothing in it outlives the run.
 */
export class BridgeRequestHandler {
  private violation: BridgeViolation | null = null
  private totalCalls = 0
  private inFlight = 0
  private readonly gate: ActivityGate | undefined
  /** Where every call outcome is recorded, once: the execution's journal when governed. */
  private readonly calls: CallLog

  constructor(
    private readonly ctx: SandboxExecutionContext,
    /** Aborted when the isolate is disposed (timeout) so in-flight HTTP calls are cancelled. */
    private readonly signal: AbortSignal
  ) {
    this.gate = ctx.executionBridge ? new ActivityGate(ctx.executionBridge) : undefined
    this.calls = ctx.executionBridge?.journal ?? ctx.callLog ?? new CallLog()
  }

  /** One `api.request()` from the isolate → one JSON reply: the response, or a bridge error the isolate rethrows. */
  async handle(apiRequestJson: string): Promise<string> {
    const refusal = this.admit()
    if (refusal !== undefined) return refusal

    this.inFlight++
    // Hoisted so the failure path can record the method/endpoint that was
    // being attempted when the throw happened.
    let attempted: CallIdentity | undefined
    // Sequence of the activity journaled as EXECUTING (governed runs only).
    let executing: number | undefined
    try {
      const validation = validateApiRequest(JSON.parse(apiRequestJson))
      if (!validation.ok) {
        this.violation = { kind: 'invalidApiRequest', reason: validation.reason, detail: validation.detail }
        return bridgeError(ERR.INVALID_API_REQUEST, validation.detail)
      }
      const { apiRequest } = validation
      // Endpoint identity: the OpenAPI template when an execution bridge is
      // present, the digit heuristic otherwise (legacy path).
      const resolved = this.gate?.resolve(apiRequest.method, apiRequest.path)
      const endpoint = resolved ? resolved.specPath : normalizeEndpointPath(apiRequest.path)
      attempted = { method: apiRequest.method, endpoint }

      let admission: Extract<ActivityAdmission, { kind: 'execute' }> | undefined
      if (this.gate && resolved) {
        const decision = await this.gate.admit(apiRequest, resolved)
        if (decision.kind === 'replay') return this.replay(attempted, decision.sequence, decision.response)
        if (decision.kind === 'stop') {
          this.violation = decision.stop
          return bridgeError(decision.code, decision.message)
        }
        admission = decision
      }

      const unauthorized = this.authorize(apiRequest.method, endpoint)
      if (unauthorized !== undefined) return unauthorized
      if (this.gate && admission) {
        await this.gate.begin(admission)
        executing = admission.sequence
      }

      const response = await this.execute(apiRequest, admission?.sequence)
      await this.record(attempted, response, admission?.sequence)
      return JSON.stringify(response)
    } catch (err) {
      return this.fail(err, attempted, executing)
    } finally {
      this.inFlight--
    }
  }

  /** Promotes the recorded violation, if any, to its typed error. Call after the isolate settled. */
  throwIfViolated(): void {
    const violation = this.violation
    if (!violation) return
    const { limits } = this.ctx
    const id = this.gate?.executionId ?? 'unknown'
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

  /** Stopped run / call budget / concurrency. Returns the bridge error when the call is refused. */
  private admit(): string | undefined {
    // Once the run has paused or stopped (approval, denial, divergence,
    // unknown outcome) no further external call may proceed — user code
    // that caught the bridge error and kept going is refused here so the
    // journal and the real world stay in step (Invariant 8/9).
    if (this.violation && RUN_STOPPING_KINDS.has(this.violation.kind)) {
      return bridgeError(ERR.APPROVAL_REQUIRED, 'Execution is paused or stopped; no further api.request() calls are executed in this run')
    }
    this.totalCalls++
    if (this.totalCalls > this.ctx.limits.maxApiCalls) {
      this.violation = { kind: 'call' }
      return bridgeError(
        ERR.CALL_LIMIT_EXCEEDED,
        `Sandbox API call limit of ${this.ctx.limits.maxApiCalls} exceeded`
      )
    }
    if (this.inFlight >= this.ctx.limits.maxConcurrentCalls) {
      this.violation = { kind: 'concurrent' }
      return bridgeError(
        ERR.CONCURRENT_LIMIT_EXCEEDED,
        `Concurrent API call limit of ${this.ctx.limits.maxConcurrentCalls} exceeded`
      )
    }
    return undefined
  }

  /** Permission guard, then circuit breaker (which throws CircuitOpenError). Returns the bridge error when denied. */
  private authorize(method: AllowedHttpMethod, endpoint: string): string | undefined {
    if (!this.ctx.permissionGuard.canExecute(endpoint, method, this.ctx.tokenPayload)) {
      const denied = new PermissionDeniedError(endpoint, method)
      this.violation = { kind: 'permission', endpoint, method }
      return bridgeError(denied.code, denied.message)
    }
    this.ctx.circuitBreaker.check(endpoint)
    return undefined
  }

  private async execute(apiRequest: ApiRequest, sequence: number | undefined): Promise<ApiResponse> {
    const { ctx } = this
    // Route through apiClient.request (not executeRequest) so the
    // configured idempotency strategy actually runs. For services with
    // idempotency type="noop" this is a passthrough; for in-memory /
    // memcache / couchbase it dedupes replays by idempotencyKey. Under
    // an execution the key gains the activity sequence so distinct
    // calls in one run never share a key.
    return ctx.apiClient.request(
      apiRequest,
      {
        tokenPayload: ctx.tokenPayload,
        invalidate: ctx.invalidate,
        idempotencyKey: sequence !== undefined ? `${ctx.idempotencyKey}-${sequence}` : ctx.idempotencyKey,
        idempotencyKeyTtlMs: ctx.idempotencyKeyTtlMs,
        correlationId: ctx.correlationId,
        sessionId: ctx.sessionId,
        ...(ctx.clientId !== undefined ? { clientId: ctx.clientId } : {}),
        signal: this.signal
      }
    )
  }

  /**
   * A response came back (any status). One record in the journal — the
   * durable activity (governed) and the run's outcome that audit and progress
   * are projected from — then the circuit breaker.
   */
  private async record(call: CallIdentity, response: ApiResponse, sequence: number | undefined): Promise<void> {
    await this.calls.recordResponse(call, { status: response.status, ok: response.ok, data: response.data }, sequence)

    // recordSuccess is intentional even on 4xx: client errors (bad
    // input from user code) should not trip the breaker — only 5xx
    // upstream failures do, and those throw before reaching here.
    this.ctx.circuitBreaker.recordSuccess(call.endpoint)
  }

  /** A COMPLETED activity from an earlier run: the recorded response stands in for the call. */
  private replay(call: CallIdentity, sequence: number, stored: ActivityResponseRecord): string {
    this.calls.recordReplayed(call, sequence, stored)
    return JSON.stringify({ data: stored.data, status: stored.status, ok: stored.ok } satisfies ApiResponse)
  }

  private async fail(err: unknown, attempted: CallIdentity | undefined, executing: number | undefined): Promise<string> {
    // Replay divergence is terminal for the run: record it and stop.
    if (err instanceof ReplayDivergedError) {
      this.violation = { kind: 'replayDiverged', error: err }
      return bridgeError(err.code, err.message)
    }
    // CircuitOpenError is a control-plane signal that must bubble up
    // to the tool layer so metrics/audit record CIRCUIT_OPEN and the
    // client sees a retryable CIRCUIT_OPEN error. Capture it as a
    // violation so `throwIfViolated` promotes it after the sandbox
    // settles — user code still sees a bridge error and cannot mask
    // the promotion by catching it.
    if (err instanceof CircuitOpenError) {
      this.violation = { kind: 'circuitOpen', endpoint: err.endpoint, retryAfterMs: err.retryAfterMs }
    }
    // Record the attempt as a failure — the journal marks an EXECUTING
    // activity FAILED (outcome unknown), and the caller's progress shows the
    // last endpoint we tried. `aborted` distinguishes sandbox-dispose-driven
    // cancellations from real network/backend failures. Skip when validation
    // failed (we have no method/path to report and the bridgeError already
    // conveys the user-input mistake).
    if (attempted) {
      await this.calls.recordFailure(
        attempted,
        { code: errorCode(err, ERR.API_ERROR), message: errorMessage(err), aborted: this.signal.aborted },
        executing
      )
    }
    return bridgeError(errorCode(err, ERR.API_ERROR), errorMessage(err))
  }
}
