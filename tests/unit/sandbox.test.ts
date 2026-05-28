// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, vi } from 'vitest'
import { runSpecSearchInSandbox } from '../../runtime/sandbox/spec-search-in-sandbox.js'
import { runApiInSandbox } from '../../runtime/sandbox/execute-api-in-sandbox.js'
import {
  SandboxSyntaxError,
  SandboxTimeoutError,
  SandboxInvalidApiRequestError,
  SandboxCallLimitError,
  SandboxConcurrentLimitError,
  type InvalidApiRequestReason
} from '../../core/types/sandbox-error.types.js'
import type { SandboxLimits } from '../../core/types/config.types.js'
import type { TokenPayload } from '../../core/types/auth.types.js'
import type { ApiClient } from '../../runtime/api-client/api-client.js'
import type { CircuitBreakerStrategy } from '../../core/types/circuit-breaker.types.js'
import { AuditCollector } from '../../runtime/observability/audit.js'
import type { SandboxExecutionContext } from '../../runtime/sandbox/execute-api-in-sandbox.js'
import { forwardTokenPermissionGuard } from '../../spi/permissions/strategies/forward-token-permission-guard.strategy.js'

const testSandboxLimits: SandboxLimits = {
  memoryLimitMb: 64,
  executeTimeoutMs: 5000,
  searchTimeoutMs: 3000,
  maxApiCalls: 50,
  maxConcurrentCalls: 5
}

const testSpec = {
  openapi: '3.0.0',
  paths: {
    '/orders': { get: { summary: 'List orders' } },
    '/campaigns': { get: { summary: 'List campaigns' }, post: { summary: 'Create campaign' } }
  }
}

const testToken: TokenPayload = {
  access_token: 'test-token',
  token_type: 'bearer',
  expires_in: 3600,
  refresh_token: 'test-refresh',
  scope: 'login_mode:self'
}

const noopCircuitBreaker: CircuitBreakerStrategy = {
  name: 'noop',
  check: () => {},
  recordSuccess: () => {},
  recordFailure: () => {},
  getState: () => 'CLOSED'
}

const noopInvalidate = async () => {}

describe('search sandbox', () => {
  it('executes a valid async arrow function and returns parsed result', async () => {
    const result = await runSpecSearchInSandbox(`async () => { return 42; }`, testSpec, testSandboxLimits)
    expect(result).toBe(42)
  })

  it('spec object is accessible inside search sandbox', async () => {
    const result = (await runSpecSearchInSandbox(
      `async () => { return Object.keys(spec.paths); }`,
      testSpec,
      testSandboxLimits
    )) as string[]
    expect(result).toContain('/orders')
    expect(result).toContain('/campaigns')
  })

  it('syntax error returns SandboxSyntaxError with actionable message', async () => {
    await expect(runSpecSearchInSandbox(`this is not valid js !!!`, testSpec, testSandboxLimits)).rejects.toThrow(
      SandboxSyntaxError
    )
  })

  it('timeout is enforced — infinite loop killed', async () => {
    const shortTimeoutLimits: SandboxLimits = { ...testSandboxLimits, searchTimeoutMs: 500 }
    await expect(
      runSpecSearchInSandbox(`async () => { while(true) {} }`, testSpec, shortTimeoutLimits)
    ).rejects.toThrow(SandboxTimeoutError)
  })

  it('spec mutation inside sandbox does not affect original spec', async () => {
    const originalPaths = Object.keys(testSpec.paths)

    await runSpecSearchInSandbox(
      `async () => { spec.paths['/injected'] = {}; return 'done'; }`,
      testSpec,
      testSandboxLimits
    )

    expect(Object.keys(testSpec.paths)).toEqual(originalPaths)
  })

  it('two sequential calls have fully isolated heaps', async () => {
    await runSpecSearchInSandbox(
      `async () => { global.__contamination = 'tainted'; return 'done'; }`,
      testSpec,
      testSandboxLimits
    )

    const result = await runSpecSearchInSandbox(
      `async () => { return typeof global.__contamination; }`,
      testSpec,
      testSandboxLimits
    )
    expect(result).toBe('undefined')
  })

  it('network access is impossible inside search sandbox', async () => {
    await expect(
      runSpecSearchInSandbox(`async () => { return typeof fetch; }`, testSpec, testSandboxLimits)
    ).resolves.toBe('undefined')
  })
})

describe('execute sandbox', () => {
  it('api object is accessible inside execute sandbox', async () => {
    const mockApiClient = {
      request: vi.fn().mockResolvedValue({ data: { id: 1 }, status: 200, ok: true })
    } as unknown as ApiClient

    const auditCollector = new AuditCollector()

    const ctx: SandboxExecutionContext = {
      tokenPayload: testToken,
      invalidate: noopInvalidate,
      apiClient: mockApiClient,
      circuitBreaker: noopCircuitBreaker,
      permissionGuard: forwardTokenPermissionGuard(),
      idempotencyKey: 'test-idempotency-key',
      idempotencyKeyTtlMs: 600_000,
      correlationId: 'test-correlation-id',
      sessionId: 'test-session-id',
      auditCollector,
      limits: testSandboxLimits
    }
    const result = await runApiInSandbox(
      `async () => { const r = await api.request({ method: 'GET', path: '/campaigns' }); return r.status; }`,
      ctx
    )

    expect(result).toBe(200)
    expect(mockApiClient.request).toHaveBeenCalledOnce()
  })

  describe('bad api.request() arguments surface SandboxInvalidApiRequestError', () => {
    // Both shapes (rethrow/swallow) must promote to the typed error — user code cannot mask it.
    const cases: Array<{
      label: string
      userExpr: string
      reason: InvalidApiRequestReason
      detailFragment: string
    }> = [
      {
        label: 'arg is null',
        userExpr: `api.request(null)`,
        reason: 'bad-object',
        detailFragment: 'argument must be an object'
      },
      {
        label: 'arg is a string',
        userExpr: `api.request('not-an-object')`,
        reason: 'bad-object',
        detailFragment: 'argument must be an object'
      },
      {
        label: 'arg.path is missing',
        userExpr: `api.request({ method: 'GET' })`,
        reason: 'bad-path',
        detailFragment: 'arg.path must be a non-empty string'
      },
      {
        label: 'arg.path is null',
        userExpr: `api.request({ method: 'GET', path: null })`,
        reason: 'bad-path',
        detailFragment: 'arg.path must be a non-empty string'
      },
      {
        label: 'arg.path is empty',
        userExpr: `api.request({ method: 'GET', path: '' })`,
        reason: 'bad-path',
        detailFragment: 'arg.path must be a non-empty string'
      },
      {
        label: 'arg.path is not a string',
        userExpr: `api.request({ method: 'GET', path: 123 })`,
        reason: 'bad-path',
        detailFragment: 'arg.path must be a non-empty string'
      },
      {
        label: 'arg.method is invalid',
        userExpr: `api.request({ method: 'OPTIONS', path: '/x' })`,
        reason: 'bad-method',
        detailFragment: 'arg.method must be one of'
      }
    ]

    const shapes = [
      { name: 'rethrow', wrap: (expr: string) => `async () => { await ${expr} }` },
      {
        name: 'swallow',
        wrap: (expr: string) => `async () => { try { await ${expr} } catch (e) { return 'swallowed' } }`
      }
    ]

    for (const { label, userExpr, reason, detailFragment } of cases) {
      for (const shape of shapes) {
        it(`${label} (${shape.name} variant)`, async () => {
          const mockApiClient = {
            request: vi.fn().mockResolvedValue({ data: {}, status: 200, ok: true })
          } as unknown as ApiClient

          const ctx: SandboxExecutionContext = {
            tokenPayload: testToken,
            invalidate: noopInvalidate,
            apiClient: mockApiClient,
            circuitBreaker: noopCircuitBreaker,
            permissionGuard: forwardTokenPermissionGuard(),
            idempotencyKey: 'k',
            idempotencyKeyTtlMs: 600_000,
            correlationId: 'c',
            sessionId: 's',
            auditCollector: new AuditCollector(),
            limits: testSandboxLimits
          }

          let thrown: unknown
          try {
            await runApiInSandbox(shape.wrap(userExpr), ctx)
          } catch (err) {
            thrown = err
          }

          expect(thrown).toBeInstanceOf(SandboxInvalidApiRequestError)
          const typed = thrown as SandboxInvalidApiRequestError
          expect(typed.code).toBe('INVALID_API_REQUEST')
          expect(typed.retryable).toBe(false)
          expect(typed.reason).toBe(reason)
          expect(typed.message).toContain(detailFragment)
          expect(mockApiClient.request).not.toHaveBeenCalled()
        })
      }
    }
  })

  it('executeTimeoutMs is wall-clock: a hanging api.request is killed at the timeout', async () => {
    // ivm's script.run timeout pauses across awaits — only a Node-level timer can kill this.
    const hangingApiClient = {
      request: vi.fn().mockImplementation(
        () =>
          new Promise(() => {
            /* never resolves */
          })
      )
    } as unknown as ApiClient

    const tight: SandboxLimits = { ...testSandboxLimits, executeTimeoutMs: 300 }

    const ctx: SandboxExecutionContext = {
      tokenPayload: testToken,
      invalidate: noopInvalidate,
      apiClient: hangingApiClient,
      circuitBreaker: noopCircuitBreaker,
      permissionGuard: forwardTokenPermissionGuard(),
      idempotencyKey: 'k',
      idempotencyKeyTtlMs: 600_000,
      correlationId: 'c',
      sessionId: 's',
      auditCollector: new AuditCollector(),
      limits: tight
    }

    const start = Date.now()
    await expect(
      runApiInSandbox(`async () => { await api.request({ method: 'GET', path: '/slow' }); return 'done'; }`, ctx)
    ).rejects.toThrow(SandboxTimeoutError)
    expect(Date.now() - start).toBeLessThan(5_000)
  })

  it('searchTimeoutMs is wall-clock: async microtask loops are killed (no api calls at all)', async () => {
    // Each synchronous slice is trivial, so only a wall-clock timer kills it.
    const start = Date.now()
    await expect(
      runSpecSearchInSandbox(`async () => { while (true) { await Promise.resolve(); } }`, testSpec, {
        ...testSandboxLimits,
        searchTimeoutMs: 400
      })
    ).rejects.toThrow(SandboxTimeoutError)
    expect(Date.now() - start).toBeLessThan(5_000)
  })
})

describe('execute sandbox — permissionGuard enforcement', () => {
  it('denied canExecute surfaces PermissionDeniedError even if user code swallows the bridge error', async () => {
    const { PermissionDeniedError } = await import('../../core/types/permission.types.js')
    const mockApiClient = {
      request: vi.fn().mockResolvedValue({ data: {}, status: 200, ok: true })
    } as unknown as ApiClient

    const denyingGuard = {
      filterSpec: (spec: unknown) => spec,
      canExecute: () => false
    }

    const ctx: SandboxExecutionContext = {
      tokenPayload: testToken,
      invalidate: noopInvalidate,
      apiClient: mockApiClient,
      circuitBreaker: noopCircuitBreaker,
      permissionGuard: denyingGuard as unknown as SandboxExecutionContext['permissionGuard'],
      idempotencyKey: 'k',
      idempotencyKeyTtlMs: 600_000,
      correlationId: 'c',
      sessionId: 's',
      auditCollector: new AuditCollector(),
      limits: testSandboxLimits
    }

    // User code catches the bridge error and returns a benign value — the
    // runner must still promote the recorded permission violation.
    await expect(
      runApiInSandbox(
        `async () => {
          try { await api.request({ method: 'POST', path: '/campaigns' }) }
          catch (e) { /* swallow */ }
          return 'swallowed'
        }`,
        ctx
      )
    ).rejects.toBeInstanceOf(PermissionDeniedError)

    // And the real downstream api client must never be invoked.
    expect(mockApiClient.request).not.toHaveBeenCalled()
  })

  it('allowed canExecute lets the call proceed to the api client', async () => {
    const mockApiClient = {
      request: vi.fn().mockResolvedValue({ data: { ok: 1 }, status: 200, ok: true })
    } as unknown as ApiClient

    const ctx: SandboxExecutionContext = {
      tokenPayload: testToken,
      invalidate: noopInvalidate,
      apiClient: mockApiClient,
      circuitBreaker: noopCircuitBreaker,
      permissionGuard: forwardTokenPermissionGuard(),
      idempotencyKey: 'k',
      idempotencyKeyTtlMs: 600_000,
      correlationId: 'c',
      sessionId: 's',
      auditCollector: new AuditCollector(),
      limits: testSandboxLimits
    }

    const result = await runApiInSandbox(
      `async () => (await api.request({ method: 'GET', path: '/campaigns' })).status`,
      ctx
    )
    expect(result).toBe(200)
    expect(mockApiClient.request).toHaveBeenCalledOnce()
  })
})

describe('execute sandbox — error sanitization', () => {
  const makeCtx = (): SandboxExecutionContext => ({
    tokenPayload: testToken,
    invalidate: noopInvalidate,
    apiClient: { request: vi.fn() } as unknown as ApiClient,
    circuitBreaker: noopCircuitBreaker,
    permissionGuard: forwardTokenPermissionGuard(),
    idempotencyKey: 'k',
    idempotencyKeyTtlMs: 600_000,
    correlationId: 'c',
    sessionId: 's',
    auditCollector: new AuditCollector(),
    limits: testSandboxLimits
  })

  // Re-imports runner + error module together so `instanceof` uses matching class identity.
  async function loadRunnerWithFailure(err: unknown) {
    vi.resetModules()
    vi.doMock('../../runtime/sandbox/sandbox-core.js', () => ({
      runInSandbox: vi.fn().mockRejectedValue(err)
    }))
    const runnerMod = await import('../../runtime/sandbox/execute-api-in-sandbox.js')
    const errorsMod = await import('../../core/types/sandbox-error.types.js')
    return { runner: runnerMod.runApiInSandbox, errors: errorsMod }
  }

  it('wraps unexpected raw errors from sandbox-core into SandboxExecutionError, preserving cause', async () => {
    const rawInternalError = new Error('ENOENT: no such file /internal/isolate-bootstrap.js at line 42')
    const { runner, errors } = await loadRunnerWithFailure(rawInternalError)

    let thrown: unknown
    try {
      await runner(`async () => 1`, makeCtx())
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(errors.SandboxExecutionError)
    const err = thrown as InstanceType<typeof errors.SandboxExecutionError>
    expect(err.code).toBe('SANDBOX_INTERNAL_ERROR')
    expect(err.message).not.toContain('ENOENT')
    expect(err.message).not.toContain('/internal/')
    expect(err.message).toContain('internal error')
    expect(err.cause).toBe(rawInternalError)

    vi.doUnmock('../../runtime/sandbox/sandbox-core.js')
    vi.resetModules()
  })

  it('passes typed SandboxError subclasses through unchanged (no double-wrap)', async () => {
    vi.resetModules()
    const errors = await import('../../core/types/sandbox-error.types.js')
    const typedError = new errors.SandboxRuntimeError('user code returned null.foo')

    vi.doMock('../../runtime/sandbox/sandbox-core.js', () => ({
      runInSandbox: vi.fn().mockRejectedValue(typedError)
    }))
    const { runApiInSandbox: runner } = await import('../../runtime/sandbox/execute-api-in-sandbox.js')

    let thrown: unknown
    try {
      await runner(`async () => 1`, makeCtx())
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBe(typedError)
    expect(thrown).not.toBeInstanceOf(errors.SandboxExecutionError)

    vi.doUnmock('../../runtime/sandbox/sandbox-core.js')
    vi.resetModules()
  })
})

describe('execute sandbox — resource limits', () => {
  it('maxApiCalls — the N+1th api.request surfaces SandboxCallLimitError even when user code swallows the bridge error', async () => {
    const mockApiClient = {
      request: vi.fn().mockResolvedValue({ data: {}, status: 200, ok: true })
    } as unknown as ApiClient

    const tight: SandboxLimits = { ...testSandboxLimits, maxApiCalls: 3 }
    const ctx: SandboxExecutionContext = {
      tokenPayload: testToken,
      invalidate: noopInvalidate,
      apiClient: mockApiClient,
      circuitBreaker: noopCircuitBreaker,
      permissionGuard: forwardTokenPermissionGuard(),
      idempotencyKey: 'k',
      idempotencyKeyTtlMs: 600_000,
      correlationId: 'c',
      sessionId: 's',
      auditCollector: new AuditCollector(),
      limits: tight
    }

    await expect(
      runApiInSandbox(
        `async () => {
          for (let i = 0; i < 10; i++) {
            try { await api.request({ method: 'GET', path: '/campaigns' }) }
            catch (e) { /* user code swallows — violation must still be promoted */ }
          }
          return 'done'
        }`,
        ctx
      )
    ).rejects.toBeInstanceOf(SandboxCallLimitError)

    // Outbound client saw at most the limit — the rest short-circuited in the bridge.
    expect(mockApiClient.request).toHaveBeenCalledTimes(3)
  })

  it('maxConcurrentCalls — Promise.all over the limit surfaces SandboxConcurrentLimitError', async () => {
    let resolveGate: (() => void) | undefined
    const gate = new Promise<void>(resolve => { resolveGate = resolve })

    const mockApiClient = {
      // Every request parks on the same gate so inFlight climbs past the limit.
      request: vi.fn().mockImplementation(async () => {
        await gate
        return { data: {}, status: 200, ok: true }
      })
    } as unknown as ApiClient

    const tight: SandboxLimits = { ...testSandboxLimits, maxConcurrentCalls: 2, maxApiCalls: 100 }
    const ctx: SandboxExecutionContext = {
      tokenPayload: testToken,
      invalidate: noopInvalidate,
      apiClient: mockApiClient,
      circuitBreaker: noopCircuitBreaker,
      permissionGuard: forwardTokenPermissionGuard(),
      idempotencyKey: 'k',
      idempotencyKeyTtlMs: 600_000,
      correlationId: 'c',
      sessionId: 's',
      auditCollector: new AuditCollector(),
      limits: tight
    }

    const run = runApiInSandbox(
      `async () => {
        const p = Array.from({ length: 5 }, () =>
          api.request({ method: 'GET', path: '/campaigns' }).catch(() => 'swallowed'))
        await Promise.all(p)
        return 'done'
      }`,
      ctx
    )

    // Give the sandbox time to fire all five requests concurrently before the gate lifts.
    await new Promise(resolve => setTimeout(resolve, 50))
    resolveGate?.()

    await expect(run).rejects.toBeInstanceOf(SandboxConcurrentLimitError)
  })
})
