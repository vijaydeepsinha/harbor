// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import ivm from 'isolated-vm'
import { runInSandbox } from './sandbox-core.js'
import type { TokenPayload } from '../../core/types/auth.types.js'
import type { CircuitBreakerStrategy } from '../../core/types/circuit-breaker.types.js'
import { CircuitOpenError } from '../../core/types/circuit-breaker.types.js'
import type { PermissionGuard } from '../../core/types/permission.types.js'
import { PermissionDeniedError } from '../../core/types/permission.types.js'
import type { ConnectorAPI, ApiRequest } from '../../spi/connector/connector-api.js'
import type { SandboxLimits } from '../../core/types/config.types.js'
import type { AuditCollector } from '../observability/audit.js'
import { type ProgressCollector, extractTopLevelIds } from '../observability/progress.js'
import { ERR, ALLOWED_HTTP_METHODS, type AllowedHttpMethod } from '../../core/constants.js'
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

function throwIfViolated(violation: BridgeViolation | null, limits: SandboxLimits): void {
  if (!violation) return
  switch (violation.kind) {
    case 'call':           throw new SandboxCallLimitError(limits.maxApiCalls)
    case 'concurrent':     throw new SandboxConcurrentLimitError(limits.maxConcurrentCalls)
    case 'permission':     throw new PermissionDeniedError(violation.endpoint, violation.method)
    case 'invalidApiRequest': throw new SandboxInvalidApiRequestError(violation.reason, violation.detail)
    case 'circuitOpen':    throw new CircuitOpenError(violation.endpoint, violation.retryAfterMs)
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
          try {
            const validation = validateApiRequest(JSON.parse(apiRequestJson))
            if (!validation.ok) {
              violation = { kind: 'invalidApiRequest', reason: validation.reason, detail: validation.detail }
              return bridgeError(ERR.INVALID_API_REQUEST, validation.detail)
            }
            const { apiRequest } = validation
            const normalizedPath = normalizeEndpointPath(apiRequest.path)
            attemptedMethod = apiRequest.method
            attemptedPath = normalizedPath

            if (!ctx.permissionGuard.canExecute(normalizedPath, apiRequest.method, ctx.tokenPayload)) {
              const denied = new PermissionDeniedError(normalizedPath, apiRequest.method)
              violation = { kind: 'permission', endpoint: normalizedPath, method: apiRequest.method }
              return bridgeError(denied.code, denied.message)
            }

            ctx.circuitBreaker.check(normalizedPath)

            // Route through apiClient.request (not executeRequest) so the
            // configured idempotency strategy actually runs. For services with
            // idempotency type="noop" this is a passthrough; for in-memory /
            // memcache / couchbase it dedupes replays by idempotencyKey.
            const response = await ctx.apiClient.request(
              apiRequest,
              {
                tokenPayload: ctx.tokenPayload,
                invalidate: ctx.invalidate,
                idempotencyKey: ctx.idempotencyKey,
                idempotencyKeyTtlMs: ctx.idempotencyKeyTtlMs,
                correlationId: ctx.correlationId,
                sessionId: ctx.sessionId,
                signal: abortController.signal
              }
            )

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
            // CircuitOpenError is a control-plane signal that must bubble up
            // to the tool layer so metrics/audit record CIRCUIT_OPEN and the
            // client sees a retryable CIRCUIT_OPEN error. Capture it as a
            // violation so `throwIfViolated` promotes it after the sandbox
            // settles — user code still sees a bridge error and cannot mask
            // the promotion by catching it.
            if (err instanceof CircuitOpenError) {
              violation = { kind: 'circuitOpen', endpoint: err.endpoint, retryAfterMs: err.retryAfterMs }
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
    throwIfViolated(violation, ctx.limits)
    // Pass typed sandbox errors through; wrap anything else to avoid leaking internals.
    if (err instanceof SandboxError) throw err
    throw new SandboxExecutionError(err)
  })

  // User code returned successfully but the bridge recorded a violation
  // (user code caught the bridge error and swallowed it). Promote to a
  // typed failure so the tool layer records an accurate outcome.
  throwIfViolated(violation, ctx.limits)

  return result
}
