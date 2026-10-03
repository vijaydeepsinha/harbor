// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {describe, expect, it} from 'vitest'
import {runInSandbox} from '../../src/runtime/sandbox/sandbox-core.js'
import {runApiInSandbox, type SandboxExecutionContext} from '../../src/runtime/sandbox/execute-api-in-sandbox.js'
import {SandboxMemoryError, SandboxRuntimeError, SandboxTimeoutError} from '../../src/core/types/sandbox-error.types.js'
import {CallLog} from '../../src/runtime/execution/activity-journal.js'
import {noopCircuitBreaker} from '../../src/adapters/resilience/strategies/noop-circuit-breaker.strategy.js'
import {
    forwardTokenPermissionGuard
} from '../../src/adapters/permissions/strategies/forward-token-permission-guard.strategy.js'

const run = (code: string, opts: { memoryLimitMb?: number; timeoutMs?: number } = {}) =>
    runInSandbox(code, {memoryLimitMb: opts.memoryLimitMb ?? 32, timeoutMs: opts.timeoutMs ?? 2000}, async () => {
    })

describe('runInSandbox — errors are classified by what happened, not by what a message says', () => {
    it.each([
        'connect ETIMEDOUT: timeout',
        'timeout of 2000ms exceeded',
        'API_ERROR: timeout of 2000ms exceeded',
        'Isolate was disposed',
        'JavaScript heap out of memory'
    ])('a program error reading "%s" is a runtime error', async message => {
        await expect(run(`async () => { throw new Error(${JSON.stringify(message)}) }`)).rejects.toBeInstanceOf(SandboxRuntimeError)
    })

    it('a real wall-clock timeout is a timeout', async () => {
        await expect(run('async () => { await new Promise(() => {}) }', {timeoutMs: 100})).rejects.toBeInstanceOf(SandboxTimeoutError)
    })

    it('a pure CPU runaway is a timeout', async () => {
        await expect(run('async () => { for (;;) {} }', {timeoutMs: 100})).rejects.toBeInstanceOf(SandboxTimeoutError)
    })

    it('exhausting the isolate heap is a memory error', async () => {
        await expect(run('async () => { const a = []; for (;;) a.push(new Array(1e5).fill("x")) }', {
            memoryLimitMb: 8,
            timeoutMs: 10_000
        }))
            .rejects.toBeInstanceOf(SandboxMemoryError)
    }, 15_000)

    it('an uncaught backend timeout from api.request is not reported as a sandbox timeout', async () => {
        const ctx: SandboxExecutionContext = {
            tokenPayload: {access_token: 't', token_type: 'bearer', expires_in: 60, refresh_token: '', scope: ''},
            invalidate: async () => {
            },
            apiClient: {
                request: async () => {
                    throw Object.assign(new Error('timeout of 100ms exceeded'), {code: 'ECONNABORTED'})
                }
            },
            circuitBreaker: noopCircuitBreaker(),
            permissionGuard: forwardTokenPermissionGuard(),
            idempotencyKey: 'k', idempotencyKeyTtlMs: 1000, correlationId: 'c',
            callLog: new CallLog(),
            limits: {
                memoryLimitMb: 32,
                executeTimeoutMs: 2000,
                searchTimeoutMs: 1000,
                maxApiCalls: 5,
                maxConcurrentCalls: 2
            }
        }
        const err = await runApiInSandbox(`async () => (await api.request({ method: 'POST', path: '/orders' })).status`, ctx).catch((e: unknown) => e)
        expect(err).toBeInstanceOf(SandboxRuntimeError)
        expect(err).not.toBeInstanceOf(SandboxTimeoutError)
        expect((err as SandboxRuntimeError).retryable).toBe(false) // the POST's outcome is unknown: not an invitation to rerun
    })
})
