// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import ivm from 'isolated-vm'
import { runInSandbox } from './sandbox-core.js'
import type { TokenPayload } from '../../core/types/auth.types.js'
import type { CircuitBreakerStrategy } from '../../core/types/circuit-breaker.types.js'
import type { PermissionGuard } from '../../core/types/permission.types.js'
import type { ConnectorAPI } from '../../spi/connector/connector-api.js'
import type { SandboxLimits } from '../../core/types/config.types.js'
import type { AuditCollector } from '../observability/audit.js'
import type { ProgressCollector } from '../observability/progress.js'
import { SandboxError, SandboxExecutionError } from '../../core/types/sandbox-error.types.js'
import type { ExecutionBridge } from '../execution/activity-gate.js'
import { BridgeRequestHandler } from './bridge-request-handler.js'

export type { ExecutionBridge, GovernanceVerdict } from '../execution/activity-gate.js'

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
  executionBridge?: ExecutionBridge
}

/** Installs `api.request` in the isolate; every call crosses to the host through `__makeRequest`. */
const BOOTSTRAP = `
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
`

/**
 * Runs one sandboxed program. Orchestration only: the per-call pipeline and
 * the run's bookkeeping live in {@link BridgeRequestHandler}, replay and
 * governance in the ActivityGate it consults.
 */
export async function runApiInSandbox(
  userCode: string,
  ctx: SandboxExecutionContext
): Promise<unknown> {
  const abortController = new AbortController()
  const handler = new BridgeRequestHandler(ctx, abortController.signal)

  const result = await runInSandbox(
    userCode,
    {
      memoryLimitMb: ctx.limits.memoryLimitMb,
      timeoutMs: ctx.limits.executeTimeoutMs,
      onDispose: () => abortController.abort()
    },
    async (jail, context, isolate) => {
      await jail.set('__makeRequest', new ivm.Reference(
        (apiRequestJson: string): Promise<string> => handler.handle(apiRequestJson)
      ))
      const bootstrapScript = await isolate.compileScript(BOOTSTRAP)
      await bootstrapScript.run(context)
    }
  ).catch((err: unknown) => {
    // Typed policy/limit error takes precedence if the bridge recorded one.
    handler.throwIfViolated()
    // Pass typed sandbox errors through; wrap anything else to avoid leaking internals.
    if (err instanceof SandboxError) throw err
    throw new SandboxExecutionError(err)
  })

  // User code returned successfully but the bridge recorded a violation
  // (user code caught the bridge error and swallowed it). Promote to a
  // typed failure so the tool layer records an accurate outcome.
  handler.throwIfViolated()

  return result
}
