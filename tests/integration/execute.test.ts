// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {beforeEach, describe, expect, it, vi} from 'vitest'
import axios from 'axios'
import {ApiClient, type ExecuteRequestContext} from '../../src/runtime/api-client/api-client.js'
import {
    CountBasedCircuitBreakerStrategy
} from '../../src/adapters/resilience/strategies/count-based-circuit-breaker.strategy.js'
import {InMemoryIdempotencyStrategy} from '../../src/adapters/idempotency/strategies/in-memory-idempotency.strategy.js'
import {runApiInSandbox, type SandboxExecutionContext} from '../../src/runtime/sandbox/execute-api-in-sandbox.js'
import {AuditCollector} from '../../src/runtime/observability/audit.js'
import {CallLog} from '../../src/runtime/execution/activity-journal.js'
import {
    forwardTokenPermissionGuard
} from '../../src/adapters/permissions/strategies/forward-token-permission-guard.strategy.js'
import type {TokenPayload} from '../../src/core/types/auth.types.js'
import pino from 'pino'

vi.mock('axios')

const silentLogger = pino({level: 'silent'})

const tokenPayload: TokenPayload = {
    access_token: 'my-test-access-token',
    token_type: 'bearer',
    expires_in: 3600,
    refresh_token: 'refresh',
    scope: 'login_mode:self'
}

const noopInvalidate = async () => {
}

const baseCtx: ExecuteRequestContext = {
    tokenPayload,
    invalidate: noopInvalidate,
    idempotencyKey: 'idem-key',
    idempotencyKeyTtlMs: 60_000,
    correlationId: 'corr-id',
}

const apiConfig = {
    protocol: 'http' as const,
    host: 'test-api.internal',
    port: 8090,
    basePath: '/api/v1',
    requestTimeoutMs: 5000,
    maxRetries: 1
}

function makeApiClient(
    cb = new CountBasedCircuitBreakerStrategy({failureThreshold: 5, recoveryTimeMs: 30_000}),
    idempotency = new InMemoryIdempotencyStrategy()
) {
    return new ApiClient('http://test-api.internal:8090/api/v1', apiConfig, cb, idempotency, silentLogger, {
        serviceName: 'test-service',
        agentName: 'mcp-agent'
    })
}

describe('execute integration', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('outbound request includes Authorization: Bearer header', async () => {
        vi.mocked(axios.create).mockReturnValue({
            request: vi.fn().mockResolvedValue({
                status: 200,
                data: {id: 1}
            })
        } as never)

        const client = makeApiClient()
        await client.executeRequest({method: 'GET', path: '/campaigns'}, baseCtx)

        const mockAxiosInstance = vi.mocked(axios.create).mock.results[0]?.value
        const requestCall = mockAxiosInstance?.request.mock.calls[0]?.[0]
        expect(requestCall?.headers?.['Authorization']).toBe('Bearer my-test-access-token')
    })

    it('outbound request includes X-Request-Source: mcp-agent', async () => {
        vi.mocked(axios.create).mockReturnValue({
            request: vi.fn().mockResolvedValue({status: 200, data: {}})
        } as never)

        const client = makeApiClient()
        await client.executeRequest({method: 'GET', path: '/campaigns'}, baseCtx)

        const mockAxiosInstance = vi.mocked(axios.create).mock.results[0]?.value
        const requestCall = mockAxiosInstance?.request.mock.calls[0]?.[0]
        expect(requestCall?.headers?.['X-Request-Source']).toBe('mcp-agent')
    })

    it('outbound request includes X-Correlation-ID', async () => {
        vi.mocked(axios.create).mockReturnValue({
            request: vi.fn().mockResolvedValue({status: 200, data: {}})
        } as never)

        const client = makeApiClient()
        await client.executeRequest(
            {method: 'GET', path: '/campaigns'},
            {...baseCtx, correlationId: 'my-correlation-id'}
        )

        const mockAxiosInstance = vi.mocked(axios.create).mock.results[0]?.value
        const requestCall = mockAxiosInstance?.request.mock.calls[0]?.[0]
        expect(requestCall?.headers?.['X-Correlation-ID']).toBe('my-correlation-id')
    })

    describe('Harbor-owned headers', () => {
        async function sentHeaders(ctx: Partial<ExecuteRequestContext> = {}, programHeaders?: Record<string, string>, serverId?: string) {
            vi.mocked(axios.create).mockReturnValue({
                request: vi.fn().mockResolvedValue({
                    status: 200,
                    data: {}
                })
            } as never)
            const client = new ApiClient('http://test-api.internal:8090/api/v1', apiConfig,
                new CountBasedCircuitBreakerStrategy({
                    failureThreshold: 5,
                    recoveryTimeMs: 30_000
                }), new InMemoryIdempotencyStrategy(), silentLogger,
                {serviceName: 'test-service', agentName: 'mcp-agent', ...(serverId ? {serverId} : {})})
            await client.executeRequest({
                method: 'GET',
                path: '/campaigns', ...(programHeaders ? {headers: programHeaders} : {})
            }, {...baseCtx, ...ctx})
            const instance = vi.mocked(axios.create).mock.results.at(-1)?.value
            return instance?.request.mock.calls[0]?.[0]?.headers as Record<string, string>
        }

        it('stamps every call with X-Harbor-Server-ID — HARBOR_GATEWAY unless configured', async () => {
            expect((await sentHeaders())['X-Harbor-Server-ID']).toBe('HARBOR_GATEWAY')
            expect((await sentHeaders({}, undefined, 'harbor-eu-1'))['X-Harbor-Server-ID']).toBe('harbor-eu-1')
        })

        it('forwards X-Harbor-Client-ID only when the caller sent one', async () => {
            expect((await sentHeaders({clientId: 'agent-7'}))['X-Harbor-Client-ID']).toBe('agent-7')
            expect(await sentHeaders()).not.toHaveProperty('X-Harbor-Client-ID')
        })

        it('forwards X-Harbor-Execution-ID only for governed executions', async () => {
            expect((await sentHeaders({executionId: 'execution-42'}))['X-Harbor-Execution-ID']).toBe('execution-42')
            expect(await sentHeaders()).not.toHaveProperty('X-Harbor-Execution-ID')
        })

        it('the sandboxed program cannot set or forge them (any letter case); its other headers pass through', async () => {
            const headers = await sentHeaders({correlationId: 'rpc-1', executionId: 'execution-42', clientId: 'agent-7'}, {
                'x-correlation-id': 'forged',
                'X-HARBOR-SERVER-ID': 'forged',
                'x-harbor-client-id': 'forged',
                'x-harbor-execution-id': 'forged',
                'X-Custom': 'kept'
            })
            expect(headers['X-Correlation-ID']).toBe('rpc-1')
            expect(headers['X-Harbor-Execution-ID']).toBe('execution-42')
            expect(headers['X-Harbor-Server-ID']).toBe('HARBOR_GATEWAY')
            expect(headers['X-Harbor-Client-ID']).toBe('agent-7')
            expect(headers['X-Custom']).toBe('kept')
            expect(Object.values(headers)).not.toContain('forged')
        })
    })

    it('outbound request includes X-Idempotency-Key', async () => {
        vi.mocked(axios.create).mockReturnValue({
            request: vi.fn().mockResolvedValue({status: 200, data: {}})
        } as never)

        const client = makeApiClient()
        await client.executeRequest({method: 'GET', path: '/campaigns'}, {...baseCtx, idempotencyKey: 'my-idem-key'})

        const mockAxiosInstance = vi.mocked(axios.create).mock.results[0]?.value
        const requestCall = mockAxiosInstance?.request.mock.calls[0]?.[0]
        expect(requestCall?.headers?.['X-Idempotency-Key']).toBe('my-idem-key')
    })

    it('circuit breaker transitions to OPEN after mocked 5xx responses', async () => {
        const cb = new CountBasedCircuitBreakerStrategy({
            failureThreshold: 2,
            recoveryTimeMs: 30_000
        })

        vi.mocked(axios.create).mockReturnValue({
            request: vi.fn().mockResolvedValue({status: 500, data: {}})
        } as never)

        const client = makeApiClient(cb)

        // One logical call is one failure, however many attempts it took (maxRetries=1 ⇒ 2 tries).
        await client.executeRequest({method: 'GET', path: '/campaigns'}, baseCtx).catch(() => undefined)
        expect(cb.getState('/campaigns')).toBe('CLOSED')
        await client.executeRequest({method: 'GET', path: '/campaigns'}, baseCtx).catch(() => undefined)
        expect(cb.getState('/campaigns')).toBe('OPEN')
    })

    it('idempotent second call returns cached result without HTTP call', async () => {
        const mockRequest = vi.fn().mockResolvedValue({status: 200, data: {id: 1}})
        vi.mocked(axios.create).mockReturnValue({request: mockRequest} as never)

        const idempotency = new InMemoryIdempotencyStrategy()
        const client = makeApiClient(
            new CountBasedCircuitBreakerStrategy({failureThreshold: 5, recoveryTimeMs: 30_000}),
            idempotency
        )

        const result1 = await client.request(
            {method: 'GET', path: '/campaigns'},
            {...baseCtx, idempotencyKey: 'same-key'}
        )

        const result2 = await client.request(
            {method: 'GET', path: '/campaigns'},
            {...baseCtx, idempotencyKey: 'same-key'}
        )

        expect(mockRequest).toHaveBeenCalledTimes(1)
        expect(result1).toEqual(result2)
    })

    it('audit record contains correct endpointsAccessed list', async () => {
        const noopCB = {
            name: 'noop',
            check: () => {
            },
            recordSuccess: () => {
            },
            recordFailure: () => {
            },
            getState: () => 'CLOSED' as const
        }

        const mockApiClient = {
            request: vi.fn().mockResolvedValue({data: {}, status: 200, ok: true})
        } as unknown as ApiClient

        const callLog = new CallLog()

        const ctx: SandboxExecutionContext = {
            tokenPayload,
            invalidate: noopInvalidate,
            apiClient: mockApiClient,
            circuitBreaker: noopCB,
            permissionGuard: forwardTokenPermissionGuard(),
            idempotencyKey: 'idem-key',
            idempotencyKeyTtlMs: 600_000,
            correlationId: 'corr-id',
            callLog,
            limits: {
                memoryLimitMb: 64,
                executeTimeoutMs: 8000,
                searchTimeoutMs: 3000,
                maxApiCalls: 50,
                maxConcurrentCalls: 5
            }
        }
        await runApiInSandbox(
            `async () => {
        await api.request({ method: 'GET', path: '/campaigns' })
        await api.request({ method: 'GET', path: '/orders' })
        return 'done'
      }`,
            ctx
        )

        // Audit is a projection of the run's call log.
        const auditCollector = new AuditCollector(callLog)
        const endpoints = auditCollector.getEndpoints()
        expect(endpoints).toContain('GET /campaigns')
        expect(endpoints).toContain('GET /orders')
        expect(auditCollector.getCallCount()).toBe(2)
    })

    it('4xx response returns { ok: false } without tripping circuit breaker', async () => {
        const cb = new CountBasedCircuitBreakerStrategy({
            failureThreshold: 1,
            recoveryTimeMs: 30_000
        })

        vi.mocked(axios.create).mockReturnValue({
            request: vi.fn().mockResolvedValue({status: 404, data: {error: 'not found'}})
        } as never)

        const client = makeApiClient(cb)
        const result = await client.executeRequest(
            {method: 'GET', path: '/campaigns/999'},
            {...baseCtx, idempotencyKey: 'k', correlationId: 'c'}
        )

        expect(result.ok).toBe(false)
        expect(result.status).toBe(404)
        expect(cb.getState('/campaigns/999')).toBe('CLOSED')
    })

    it('401 response triggers invalidate() on the cached token', async () => {
        vi.mocked(axios.create).mockReturnValue({
            request: vi.fn().mockResolvedValue({
                status: 401,
                data: {error: 'unauthorized'}
            })
        } as never)

        const client = makeApiClient()
        const invalidate = vi.fn().mockResolvedValue(undefined)
        const result = await client.executeRequest(
            {method: 'GET', path: '/campaigns'},
            {...baseCtx, invalidate, idempotencyKey: 'k', correlationId: 'c'}
        )

        expect(result.status).toBe(401)
        expect(result.ok).toBe(false)
        expect(invalidate).toHaveBeenCalledOnce()
    })

    it('403 response does NOT trigger invalidate() — authorization failure, not authentication', async () => {
        vi.mocked(axios.create).mockReturnValue({
            request: vi.fn().mockResolvedValue({
                status: 403,
                data: {error: 'forbidden'}
            })
        } as never)

        const client = makeApiClient()
        const invalidate = vi.fn().mockResolvedValue(undefined)
        const result = await client.executeRequest(
            {method: 'GET', path: '/campaigns'},
            {...baseCtx, invalidate, idempotencyKey: 'k', correlationId: 'c'}
        )

        expect(result.status).toBe(403)
        expect(invalidate).not.toHaveBeenCalled()
    })

    it('successful 200 response does not trigger invalidate()', async () => {
        vi.mocked(axios.create).mockReturnValue({
            request: vi.fn().mockResolvedValue({status: 200, data: {id: 1}})
        } as never)

        const client = makeApiClient()
        const invalidate = vi.fn().mockResolvedValue(undefined)
        await client.executeRequest(
            {method: 'GET', path: '/campaigns'},
            {...baseCtx, invalidate, idempotencyKey: 'k', correlationId: 'c'}
        )

        expect(invalidate).not.toHaveBeenCalled()
    })
})
