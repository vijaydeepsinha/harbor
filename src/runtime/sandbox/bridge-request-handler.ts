// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {CircuitOpenError} from '../../core/types/circuit-breaker.types.js'
import {PermissionDeniedError} from '../../core/types/permission.types.js'
import type {ApiRequest, ApiResponse} from '../../spi/connector/connector-api.js'
import {
    ACTIVITY_ADMISSION,
    ALLOWED_HTTP_METHODS,
    type AllowedHttpMethod,
    BRIDGE_VIOLATION,
    ERR
} from '../../core/constants.js'
import {errorCode, errorMessage} from '../../core/utils/errors.js'
import {normalizeEndpointPath} from '../../core/utils/url.js'
import {
    type InvalidApiRequestReason,
    SandboxCallLimitError,
    SandboxConcurrentLimitError,
    SandboxInvalidApiRequestError
} from '../../core/types/sandbox-error.types.js'
import {
    ActivityOutcomeUnknownError,
    type ActivityResponseRecord,
    ApprovalRequiredError,
    ExecutionCancelledError,
    GovernanceDeniedError,
    ReplayDivergedError
} from '../../core/types/execution.types.js'
import {type ActivityAdmission, ActivityGate, type ActivityStop} from '../execution/activity-gate.js'
import {type CallIdentity, CallLog} from '../execution/activity-journal.js'
import type {SandboxExecutionContext} from './execute-api-in-sandbox.js'
import {canonicalizeRequestPath} from './request-path.js'

/**
 * Tracks resource/policy violations that the bridge enforces during a run.
 * They are promoted to typed errors *after* `runInSandbox` settles so that
 * user code cannot mask them by catching the bridge-side error — audit and
 * metrics always reflect the precise outcome.
 */
type BridgeViolation =
    | { kind: typeof BRIDGE_VIOLATION.CALL_LIMIT }
    | { kind: typeof BRIDGE_VIOLATION.CONCURRENT_LIMIT }
    | { kind: typeof BRIDGE_VIOLATION.PERMISSION; endpoint: string; method: AllowedHttpMethod }
    | { kind: typeof BRIDGE_VIOLATION.INVALID_API_REQUEST; reason: InvalidApiRequestReason; detail: string }
    | { kind: typeof BRIDGE_VIOLATION.CIRCUIT_OPEN; endpoint: string; retryAfterMs: number }
    // ── durable execution (terminal for the run: later calls are refused without executing) ──
    | ActivityStop
    | { kind: typeof BRIDGE_VIOLATION.REPLAY_DIVERGED; error: ReplayDivergedError }

const RUN_STOPPING_KINDS: ReadonlySet<BridgeViolation['kind']> = new Set([
    BRIDGE_VIOLATION.APPROVAL_REQUIRED, BRIDGE_VIOLATION.GOVERNANCE_DENIED, BRIDGE_VIOLATION.REPLAY_DIVERGED,
    BRIDGE_VIOLATION.CANCELLED, BRIDGE_VIOLATION.OUTCOME_UNKNOWN
])

/** How long aborted calls get to wind down before the run stops waiting for them. */
const ABORT_GRACE_MS = 1_000

function bridgeError(code: string, message: string): string {
    return JSON.stringify({__bridgeError: true, code, message})
}

/** Validates the argument user code passed to `api.request(...)`. The `as ApiRequest` cast is a compile-time fiction. */
type ApiRequestValidationResult =
    | { ok: true; apiRequest: ApiRequest }
    | { ok: false; reason: InvalidApiRequestReason; detail: string }

function validateApiRequest(raw: unknown): ApiRequestValidationResult {
    if (raw === null || typeof raw !== 'object') {
        return {ok: false, reason: 'bad-object', detail: 'api.request(arg): argument must be an object'}
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
        return {
            ok: false,
            reason: 'bad-params',
            detail: 'api.request(arg): arg.params must be an object of query parameters'
        }
    }
    // Governance, the journal and the connector all see this one spelling of
    // the path — never the raw string (see request-path.ts).
    const canonical = canonicalizeRequestPath(arg['path'], rawParams as Record<string, unknown> | undefined)
    if (!canonical.ok) return {ok: false, reason: 'bad-path', detail: canonical.detail}
    return {
        ok: true,
        apiRequest: {
            path: canonical.path,
            method: arg['method'] as AllowedHttpMethod,
            ...(canonical.params !== undefined ? {params: canonical.params as ApiRequest['params']} : {}),
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
    /** Every reply not yet delivered — including calls the program started without awaiting. */
    private readonly pending = new Set<Promise<string>>()
    /** Set once the program settled: see {@link drain}. */
    private closed = false
    /** Set when calls were still in flight after the abort grace: see {@link drain}. */
    private abandoned = false
    /** Tail of the admission chain (see {@link exclusive}). */
    private admission: Promise<void> = Promise.resolve()
    private readonly gate: ActivityGate | undefined
    /** Where every call outcome is recorded, once: the execution's journal when governed. */
    private readonly calls: CallLog

    constructor(
        private readonly ctx: SandboxExecutionContext,
        /** Aborted when the isolate is disposed (timeout), or when calls outlive the program's time budget (see {@link drain}). */
        private readonly signal: AbortSignal
    ) {
        this.gate = ctx.executionBridge ? new ActivityGate(ctx.executionBridge) : undefined
        this.calls = ctx.executionBridge?.journal ?? ctx.callLog ?? new CallLog()
    }

    /** One `api.request()` from the isolate → one JSON reply: the response, or a bridge error the isolate rethrows. */
    handle(apiRequestJson: string): Promise<string> {
        if (this.closed) {
            return Promise.resolve(bridgeError(ERR.INVALID_API_REQUEST, 'The program has already returned; no further api.request() calls are executed'))
        }
        const reply = this.process(apiRequestJson)
        this.pending.add(reply)
        const done = (): void => {
            this.pending.delete(reply)
        }
        reply.then(done, done)
        return reply
    }

    /**
     * The program has settled. Calls it started without awaiting them are
     * still its calls: they finish — and are journaled — before the run's
     * outcome is recorded, so nothing reaches the backend or the store after
     * the execution is marked finished. They get `graceMs` (the rest of the
     * run's time budget); whatever is still in flight then is aborted, and
     * journaled as an unknown outcome. No new call is accepted after this.
     */
    async drain(graceMs: number, abort: () => void): Promise<void> {
        this.closed = true
        if (this.pending.size === 0) return
        const all = Promise.allSettled([...this.pending])
        let timer: ReturnType<typeof setTimeout> | undefined
        const expired = await Promise.race([
            all.then(() => false),
            new Promise<boolean>(resolve => {
                timer = setTimeout(() => resolve(true), graceMs)
            })
        ])
        clearTimeout(timer)
        if (!expired) return
        abort()
        // A connector that ignores the abort must not hold the run open forever.
        // Past this point a straggler may still record its own outcome, but it
        // can no longer be admitted, journal a new activity or touch governance.
        let straggle: ReturnType<typeof setTimeout> | undefined
        const stuck = await Promise.race([
            all.then(() => false),
            new Promise<boolean>(resolve => {
                straggle = setTimeout(() => resolve(true), ABORT_GRACE_MS)
            })
        ])
        clearTimeout(straggle)
        if (stuck) this.abandoned = true
    }

    /** Promotes the recorded violation, if any, to its typed error. Call after the isolate settled. */
    throwIfViolated(): void {
        const violation = this.violation
        if (!violation) return
        const {limits} = this.ctx
        const id = this.gate?.executionId ?? 'unknown'
        switch (violation.kind) {
            case BRIDGE_VIOLATION.CALL_LIMIT:
                throw new SandboxCallLimitError(limits.maxApiCalls)
            case BRIDGE_VIOLATION.CONCURRENT_LIMIT:
                throw new SandboxConcurrentLimitError(limits.maxConcurrentCalls)
            case BRIDGE_VIOLATION.PERMISSION:
                throw new PermissionDeniedError(violation.endpoint, violation.method)
            case BRIDGE_VIOLATION.INVALID_API_REQUEST:
                throw new SandboxInvalidApiRequestError(violation.reason, violation.detail)
            case BRIDGE_VIOLATION.CIRCUIT_OPEN:
                throw new CircuitOpenError(violation.endpoint, violation.retryAfterMs)
            case BRIDGE_VIOLATION.APPROVAL_REQUIRED:
                throw new ApprovalRequiredError(id, violation.sequence, violation.approvalId, violation.summary)
            case BRIDGE_VIOLATION.GOVERNANCE_DENIED:
                throw new GovernanceDeniedError(id, violation.sequence, violation.reason, violation.matchedRules)
            case BRIDGE_VIOLATION.REPLAY_DIVERGED:
                throw violation.error
            case BRIDGE_VIOLATION.CANCELLED:
                throw new ExecutionCancelledError(id, violation.sequence)
            case BRIDGE_VIOLATION.OUTCOME_UNKNOWN:
                throw new ActivityOutcomeUnknownError(id, violation.sequence, violation.label)
        }
    }

    private async process(apiRequestJson: string): Promise<string> {
        const refusal = this.admit()
        if (refusal !== undefined) return refusal

        this.inFlight++
        // Arrival order within the run: the legacy path's per-call idempotency suffix.
        const callIndex = this.totalCalls
        // Hoisted so the failure path can record the method/endpoint that was
        // being attempted when the throw happened.
        let attempted: CallIdentity | undefined
        // Sequence of the activity journaled as EXECUTING (governed runs only).
        let executing: number | undefined
        try {
            const validation = validateApiRequest(JSON.parse(apiRequestJson))
            if (!validation.ok) {
                this.flag({
                    kind: BRIDGE_VIOLATION.INVALID_API_REQUEST,
                    reason: validation.reason,
                    detail: validation.detail
                })
                return bridgeError(ERR.INVALID_API_REQUEST, validation.detail)
            }
            const {apiRequest} = validation
            // Endpoint identity: the OpenAPI template when an execution bridge is
            // present, the digit heuristic otherwise (legacy path).
            const resolved = this.gate?.resolve(apiRequest.method, apiRequest.path)
            const endpoint = resolved ? resolved.specPath : normalizeEndpointPath(apiRequest.path)
            const call: CallIdentity = {method: apiRequest.method, endpoint}
            attempted = call

            let admission: Extract<ActivityAdmission, { kind: typeof ACTIVITY_ADMISSION.EXECUTE }> | undefined
            const gate = this.gate
            if (gate && resolved) {
                // Admission — journal lookup, governance, the stop check, journaling
                // EXECUTING — is one critical section per run. Concurrent calls
                // (Promise.all) are admitted one at a time in arrival order, so a
                // call admitted after a sibling paused or denied the run sees that
                // stop and is refused: it can neither execute nor open an approval
                // on a run that already ended. The external calls still overlap.
                const gated = await this.exclusive(async (): Promise<{ reply: string } | {
                    admitted: Extract<ActivityAdmission, { kind: typeof ACTIVITY_ADMISSION.EXECUTE }>
                }> => {
                    if (this.abandoned) return {reply: bridgeError(ERR.INVALID_API_REQUEST, 'The program has already returned; no further api.request() calls are executed')}
                    if (this.stopped()) return {reply: this.stopRefusal()}
                    const decision = await gate.admit(apiRequest, resolved)
                    if (decision.kind === ACTIVITY_ADMISSION.REPLAY) return {reply: this.replay(call, decision.sequence, decision.response)}
                    if (decision.kind === ACTIVITY_ADMISSION.STOP) {
                        this.flag(decision.stop)
                        return {reply: bridgeError(decision.code, decision.message)}
                    }
                    const unauthorized = this.authorize(apiRequest.method, endpoint)
                    if (unauthorized !== undefined) return {reply: unauthorized}
                    // Another call of this run between arrival and reply (queued here,
                    // going out, or being replayed) ⇒ this call's sequence depended on
                    // timing, and replay must bind its content (see ActivityJournal.next).
                    await gate.begin(decision, this.inFlight > 1)
                    return {admitted: decision}
                })
                if ('reply' in gated) return gated.reply
                admission = gated.admitted
                executing = admission.sequence
            } else {
                const unauthorized = this.authorize(apiRequest.method, endpoint)
                if (unauthorized !== undefined) return unauthorized
            }

            const response = await this.execute(apiRequest, endpoint, admission?.sequence ?? `c${callIndex}`)
            await this.record(call, response, admission?.sequence)
            return JSON.stringify(response)
        } catch (err) {
            return this.fail(err, attempted, executing)
        } finally {
            this.inFlight--
        }
    }

    /** Runs `fn` after every earlier admission of this run has finished (a promise-chain mutex). */
    private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
        const previous = this.admission
        let release!: () => void
        this.admission = new Promise<void>(resolve => {
            release = resolve
        })
        await previous
        try {
            return await fn()
        } finally {
            release()
        }
    }

    /**
     * Records a violation. The first run-stopping one stands: a sibling call
     * that fails later (a pause, a permission error, an open circuit) must not
     * turn a DENY into a pause — or a pause into something the human never saw.
     */
    private flag(violation: BridgeViolation): void {
        if (this.stopped()) return
        this.violation = violation
    }

    private stopped(): boolean {
        return this.violation !== null && RUN_STOPPING_KINDS.has(this.violation.kind)
    }

    /** What a call refused because the run already stopped sees — the code names why it stopped. */
    private stopRefusal(): string {
        const code =
            this.violation?.kind === BRIDGE_VIOLATION.GOVERNANCE_DENIED ? ERR.GOVERNANCE_DENIED
                : this.violation?.kind === BRIDGE_VIOLATION.REPLAY_DIVERGED ? ERR.REPLAY_DIVERGED
                    : this.violation?.kind === BRIDGE_VIOLATION.CANCELLED ? ERR.EXECUTION_CANCELLED
                        : this.violation?.kind === BRIDGE_VIOLATION.OUTCOME_UNKNOWN ? ERR.ACTIVITY_OUTCOME_UNKNOWN
                            : ERR.APPROVAL_REQUIRED
        return bridgeError(code, 'Execution is paused or stopped; no further api.request() calls are executed in this run')
    }

    /** Stopped run / call budget / concurrency. Returns the bridge error when the call is refused. */
    private admit(): string | undefined {
        // Once the run has paused or stopped (approval, denial, divergence,
        // unknown outcome) no further external call may proceed — user code
        // that caught the bridge error and kept going is refused here so the
        // journal and the real world stay in step (Invariant 8/9).
        if (this.stopped()) return this.stopRefusal()
        this.totalCalls++
        if (this.totalCalls > this.ctx.limits.maxApiCalls) {
            this.flag({kind: BRIDGE_VIOLATION.CALL_LIMIT})
            return bridgeError(
                ERR.CALL_LIMIT_EXCEEDED,
                `Sandbox API call limit of ${this.ctx.limits.maxApiCalls} exceeded`
            )
        }
        if (this.inFlight >= this.ctx.limits.maxConcurrentCalls) {
            this.flag({kind: BRIDGE_VIOLATION.CONCURRENT_LIMIT})
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
            this.flag({kind: BRIDGE_VIOLATION.PERMISSION, endpoint, method})
            return bridgeError(denied.code, denied.message)
        }
        this.ctx.circuitBreaker.check(endpoint)
        return undefined
    }

    private async execute(apiRequest: ApiRequest, endpoint: string, callKey: number | string): Promise<ApiResponse> {
        const {ctx} = this
        // Route through apiClient.request (not executeRequest) so the
        // configured idempotency strategy actually runs. For services with
        // idempotency type="noop" this is a passthrough; for in-memory /
        // memcache / couchbase it dedupes replays by idempotencyKey. The key
        // gains the call's place in the program — the activity sequence under
        // an execution, the arrival index otherwise — so distinct calls of one
        // run never share a key (a GET and the POST after it must not dedupe).
        return ctx.apiClient.request(
            apiRequest,
            {
                tokenPayload: ctx.tokenPayload,
                invalidate: ctx.invalidate,
                idempotencyKey: `${ctx.idempotencyKey}-${callKey}`,
                idempotencyKeyTtlMs: ctx.idempotencyKeyTtlMs,
                correlationId: ctx.correlationId,
                ...(ctx.executionId !== undefined ? {executionId: ctx.executionId} : {}),
                ...(ctx.clientId !== undefined ? {clientId: ctx.clientId} : {}),
                // The breaker is checked and credited under `endpoint` here; failures must land on the same key.
                endpoint,
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
        await this.calls.recordResponse(call, {status: response.status, ok: response.ok, data: response.data}, sequence)

        // recordSuccess is intentional even on 4xx: client errors (bad
        // input from user code) should not trip the breaker — only 5xx
        // upstream failures do, and those throw before reaching here.
        this.ctx.circuitBreaker.recordSuccess(call.endpoint)
    }

    /** A COMPLETED activity from an earlier run: the recorded response stands in for the call. */
    private replay(call: CallIdentity, sequence: number, stored: ActivityResponseRecord): string {
        this.calls.recordReplayed(call, sequence, stored)
        return JSON.stringify({data: stored.data, status: stored.status, ok: stored.ok} satisfies ApiResponse)
    }

    private async fail(err: unknown, attempted: CallIdentity | undefined, executing: number | undefined): Promise<string> {
        // Replay divergence is terminal for the run: record it and stop.
        if (err instanceof ReplayDivergedError) {
            this.flag({kind: BRIDGE_VIOLATION.REPLAY_DIVERGED, error: err})
            return bridgeError(err.code, err.message)
        }
        // CircuitOpenError is a control-plane signal that must bubble up
        // to the tool layer so metrics/audit record CIRCUIT_OPEN and the
        // client sees a retryable CIRCUIT_OPEN error. Capture it as a
        // violation so `throwIfViolated` promotes it after the sandbox
        // settles — user code still sees a bridge error and cannot mask
        // the promotion by catching it.
        if (err instanceof CircuitOpenError) {
            this.flag({kind: BRIDGE_VIOLATION.CIRCUIT_OPEN, endpoint: err.endpoint, retryAfterMs: err.retryAfterMs})
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
                {code: errorCode(err, ERR.API_ERROR), message: errorMessage(err), aborted: this.signal.aborted},
                executing
            )
        }
        return bridgeError(errorCode(err, ERR.API_ERROR), errorMessage(err))
    }
}
