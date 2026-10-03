// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import ivm from 'isolated-vm'
import {runInSandbox} from './sandbox-core.js'
import type {TokenPayload} from '../../core/types/auth.types.js'
import type {CircuitBreakerStrategy} from '../../spi/resilience/circuit-breaker.js'
import type {PermissionGuard} from '../../spi/permissions/permission-guard.js'
import type {ConnectorAPI} from '../../spi/connector/connector-api.js'
import type {SandboxLimits} from '../../core/types/config.types.js'
import {SandboxError, SandboxExecutionError} from '../../core/types/sandbox-error.types.js'
import type {ExecutionBridge} from '../execution/activity-gate.js'
import type {CallLog} from '../execution/activity-journal.js'
import {BridgeRequestHandler} from './bridge-request-handler.js'

export type {ExecutionBridge, GovernanceVerdict} from '../execution/activity-gate.js'

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
    /** Outbound X-Correlation-ID: the MCP request id for this sandbox run, shared by all of its calls. */
    correlationId: string
    /** Outbound X-Harbor-Execution-ID: the durable execution id, absent on legacy runs. */
    executionId?: string
    /** Outbound X-Harbor-Client-ID: the caller's own id from the inbound request, when it sent one. */
    clientId?: string
    /**
     * Where the bridge records each call's outcome when the run is not a
     * governed execution (legacy path); a governed run records into
     * `executionBridge.journal`. Audit and progress are projections of that
     * record (`AuditCollector`, `ProgressCollector`), so the tool passes the
     * same log it reads them from. Absent ⇒ the run keeps a private one.
     */
    callLog?: CallLog
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
    const startedAt = Date.now()

    let settled: { ok: true; value: unknown } | { ok: false; error: unknown }
    try {
        settled = {
            ok: true,
            value: await runInSandbox(
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
            )
        }
    } catch (error) {
        settled = {ok: false, error}
    }

    // Calls the program started but did not await (`ids.forEach(async …)`,
    // a floating promise) must not outlive the run: they finish within the
    // run's remaining time, or are aborted, before the caller records the
    // outcome — never journaling into an execution already marked finished.
    await handler.drain(
        Math.max(0, ctx.limits.executeTimeoutMs - (Date.now() - startedAt)),
        () => abortController.abort()
    )

    if (!settled.ok) {
        // Typed policy/limit error takes precedence if the bridge recorded one.
        handler.throwIfViolated()
        // Pass typed sandbox errors through; wrap anything else to avoid leaking internals.
        if (settled.error instanceof SandboxError) throw settled.error
        throw new SandboxExecutionError(settled.error)
    }

    // User code returned successfully but the bridge recorded a violation
    // (user code caught the bridge error and swallowed it, or a call it did
    // not await was paused or denied). Promote to a typed failure so the tool
    // layer records an accurate outcome.
    handler.throwIfViolated()

    return settled.value
}
