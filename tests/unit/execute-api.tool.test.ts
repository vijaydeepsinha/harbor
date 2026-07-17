// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import pino from 'pino'

vi.mock('../../runtime/sandbox/execute-api-in-sandbox.js', () => ({
  runApiInSandbox: vi.fn()
}))

vi.mock('../../runtime/observability/audit.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../runtime/observability/audit.js')>()
  return {
    ...actual,
    writeAuditRecord: vi.fn()
  }
})

import { runApiInSandbox } from '../../runtime/sandbox/execute-api-in-sandbox.js'
import { writeAuditRecord, AuditCollector } from '../../runtime/observability/audit.js'
import { ProgressCollector } from '../../runtime/observability/progress.js'
import { registerExecuteApiTool } from '../../tools/execute-api.tool.js'
import { TOOL, METRIC, OUTCOME, ERR, ENV } from '../../core/constants.js'
import type { ServiceRegistry, ServiceResources } from '../../runtime/registry/service-registry.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { MetricsRegistry } from '../../runtime/observability/metrics.js'
import type { GlobalConfig } from '../../core/types/config.types.js'
import type { TokenPayload } from '../../core/types/auth.types.js'
import { SessionExpiredError, MissingTokenError } from '../../core/types/auth.types.js'
import { PermissionDeniedError } from '../../core/types/permission.types.js'
import { CircuitOpenError } from '../../core/types/circuit-breaker.types.js'
import {
  SandboxCallLimitError,
  SandboxConcurrentLimitError,
  SandboxExecutionError,
  SandboxRuntimeError
} from '../../core/types/sandbox-error.types.js'

const silentLogger = pino({ level: 'silent' })

type Handler = (
  args: { service: string; code: string },
  extra: unknown
) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>

interface FakeServer {
  handlers: Record<string, { def: { description?: string; inputSchema?: unknown }; handler: Handler }>
  registerTool(name: string, def: { description?: string; inputSchema?: unknown }, handler: Handler): void
}

function makeFakeServer(): FakeServer {
  const handlers: FakeServer['handlers'] = {}
  return {
    handlers,
    registerTool(name, def, handler) {
      handlers[name] = { def, handler: handler as Handler }
    }
  }
}

const goodToken: TokenPayload = {
  access_token: 'tok',
  token_type: 'bearer',
  expires_in: 3600,
  refresh_token: 'r',
  scope: 'login_mode:self'
}

const goodTokenWithUser: TokenPayload = {
  ...goodToken,
  metadata: { userId: 'user-42' }
}

function makeResources(
  opts: {
    name?: string
    validate?: (auth: string | undefined, cid: string) => Promise<TokenPayload>
  } = {}
): ServiceResources {
  const innerValidate = opts.validate ?? (async () => goodTokenWithUser)
  return {
    name: opts.name ?? 'svc',
    authMiddleware: {
      validateRequest: async (auth: string | undefined, cid: string) => ({
        payload: await innerValidate(auth, cid),
        invalidate: async () => {}
      })
    },
    apiClient: {} as unknown,
    circuitBreaker: { name: 'noop' } as unknown,
    permissionGuard: { filterSpec: (s: unknown) => s, canExecute: () => true },
    idempotencyKeyTtlMs: 600_000,
    idempotencyStrategyName: 'in-memory',
    circuitBreakerStrategyName: 'noop',
    authStrategyName: 'static-token',
    sandboxLimits: {
      memoryLimitMb: 64,
      executeTimeoutMs: 8000,
      searchTimeoutMs: 3000,
      maxApiCalls: 50,
      maxConcurrentCalls: 5
    },
    logger: silentLogger
  } as unknown as ServiceResources
}

function makeRegistry(entries: Record<string, ServiceResources>): ServiceRegistry {
  return {
    get: (k: string) => entries[k],
    serviceNames: () => Object.keys(entries)
  } as unknown as ServiceRegistry
}

function makeMetrics() {
  return { increment: vi.fn(), stop: vi.fn() } as unknown as MetricsRegistry & { increment: ReturnType<typeof vi.fn> }
}

const globalConfig: GlobalConfig = {
  mcp: { host: '127.0.0.1', port: 3333 },
  auth: { tokenCacheTtlMs: 300_000 },
  sandbox: {
    memoryLimitMb: 64,
    executeTimeoutMs: 8000,
    searchTimeoutMs: 3000,
    maxApiCalls: 50,
    maxConcurrentCalls: 5
  },
  observability: {
    logLevel: 'silent',
    serviceName: 'harbor-gateway',
    agentName: 'mcp-agent',
    environment: ENV.DEV,
    enableAudit: true
  },
  defaultIdempotency: { type: 'in-memory' }
}

describe('registerExecuteApiTool', () => {
  let server: FakeServer
  let metrics: ReturnType<typeof makeMetrics>

  beforeEach(() => {
    vi.clearAllMocks()
    server = makeFakeServer()
    metrics = makeMetrics()
  })

  it('registers under TOOL.API_EXECUTE with service & code input schema', () => {
    const svc = makeResources({ name: 'tasks' })
    registerExecuteApiTool(
      server as unknown as McpServer,
      makeRegistry({ tasks: svc }),
      globalConfig,
      silentLogger,
      metrics as unknown as MetricsRegistry,
      'abc'
    )

    const entry = server.handlers[TOOL.API_EXECUTE]
    expect(entry).toBeDefined()
    expect(entry!.def.description).toContain('tasks')
    const schema = entry!.def.inputSchema as Record<string, unknown>
    expect(Object.keys(schema)).toEqual(expect.arrayContaining(['service', 'code']))
  })

  it('returns UNKNOWN_SERVICE mcpError when the service is not registered and never runs the sandbox', async () => {
    const svc = makeResources({ name: 'tasks' })
    registerExecuteApiTool(
      server as unknown as McpServer,
      makeRegistry({ tasks: svc }),
      globalConfig,
      silentLogger,
      metrics as unknown as MetricsRegistry,
      'abc'
    )

    const r = await server.handlers[TOOL.API_EXECUTE]!.handler(
      { service: 'ghost', code: 'async () => 1' },
      { correlationId: 'cid', sessionId: 'sid' }
    )

    expect(r.isError).toBe(true)
    expect(JSON.parse(r.content[0]!.text).code).toBe(ERR.UNKNOWN_SERVICE)
    expect(runApiInSandbox).not.toHaveBeenCalled()
    expect(writeAuditRecord).not.toHaveBeenCalled()
  })

  it('returns an auth mcpError and skips the sandbox + audit when session is expired', async () => {
    const svc = makeResources({
      name: 'tasks',
      validate: async () => {
        throw new SessionExpiredError()
      }
    })
    registerExecuteApiTool(
      server as unknown as McpServer,
      makeRegistry({ tasks: svc }),
      globalConfig,
      silentLogger,
      metrics as unknown as MetricsRegistry,
      'abc'
    )

    const r = await server.handlers[TOOL.API_EXECUTE]!.handler(
      { service: 'tasks', code: 'async () => 1' },
      { correlationId: 'cid', sessionId: 'sid' }
    )

    expect(r.isError).toBe(true)
    expect(JSON.parse(r.content[0]!.text).code).toBe(ERR.SESSION_EXPIRED)
    expect(runApiInSandbox).not.toHaveBeenCalled()
    expect(writeAuditRecord).not.toHaveBeenCalled()
  })

  it('returns a MISSING_TOKEN mcpError and skips the sandbox when no client token is supplied', async () => {
    const validate = vi.fn(async (auth: string | undefined) => {
      if (!auth) throw new MissingTokenError()
      return goodTokenWithUser
    })
    const svc = makeResources({ name: 'tasks', validate })

    registerExecuteApiTool(
      server as unknown as McpServer,
      makeRegistry({ tasks: svc }),
      globalConfig,
      silentLogger,
      metrics as unknown as MetricsRegistry,
      undefined
    )

    const r = await server.handlers[TOOL.API_EXECUTE]!.handler(
      { service: 'tasks', code: 'async () => 1' },
      { correlationId: 'cid', sessionId: 'sid' }
    )

    expect(r.isError).toBe(true)
    expect(JSON.parse(r.content[0]!.text).code).toBe(ERR.MISSING_TOKEN)
    expect(validate).toHaveBeenCalledWith(undefined, 'cid')
    expect(runApiInSandbox).not.toHaveBeenCalled()
  })

  it('success path: wraps sandbox result, increments TOOL_CALLS(success), and writes a success audit record', async () => {
    const svc = makeResources({ name: 'tasks' })
    vi.mocked(runApiInSandbox).mockResolvedValue({ hello: 'world' })

    registerExecuteApiTool(
      server as unknown as McpServer,
      makeRegistry({ tasks: svc }),
      globalConfig,
      silentLogger,
      metrics as unknown as MetricsRegistry,
      'abc'
    )

    const r = await server.handlers[TOOL.API_EXECUTE]!.handler(
      { service: 'tasks', code: 'async () => ({ hello: "world" })' },
      { correlationId: 'cid-ok', sessionId: 'sid-ok' }
    )

    expect(r.isError).toBeUndefined()
    expect(JSON.parse(r.content[0]!.text)).toEqual({ hello: 'world' })

    expect(metrics.increment).toHaveBeenCalledWith(METRIC.TOOL_CALLS, {
      tool: TOOL.API_EXECUTE,
      service: 'tasks',
      outcome: OUTCOME.SUCCESS
    })

    expect(writeAuditRecord).toHaveBeenCalledTimes(1)
    const audit = vi.mocked(writeAuditRecord).mock.calls[0]![0]
    expect(audit.outcome).toBe(OUTCOME.SUCCESS)
    expect(audit.service).toBe('tasks')
    expect(audit.sessionId).toBe('sid-ok')
    expect(audit.correlationId).toBe('cid-ok')
    expect(audit.authStrategy).toBe('static-token')
    expect(audit.idempotencyStrategy).toBe('in-memory')
    expect(audit.circuitBreakerStrategy).toBe('noop')
    expect(audit.codeSubmitted).toBe('async () => ({ hello: "world" })')
    expect(audit.userIdHash).toMatch(/^[0-9a-f]{64}$/)
    expect(audit.apiCallCount).toBe(0)
    expect(audit.endpointsAccessed).toEqual([])
    expect(typeof audit.durationMs).toBe('number')
  })

  it('passes an AuditCollector and a deterministic idempotency key to the sandbox', async () => {
    const svc = makeResources({ name: 'tasks' })
    vi.mocked(runApiInSandbox).mockResolvedValue({ ok: true })

    registerExecuteApiTool(
      server as unknown as McpServer,
      makeRegistry({ tasks: svc }),
      globalConfig,
      silentLogger,
      metrics as unknown as MetricsRegistry,
      'abc'
    )

    const code = 'async () => ({ ok: true })'
    await server.handlers[TOOL.API_EXECUTE]!.handler(
      { service: 'tasks', code },
      { correlationId: 'cid', sessionId: 'sid' }
    )
    await server.handlers[TOOL.API_EXECUTE]!.handler(
      { service: 'tasks', code },
      { correlationId: 'cid2', sessionId: 'sid2' }
    )

    expect(runApiInSandbox).toHaveBeenCalledTimes(2)
    const ctxA = vi.mocked(runApiInSandbox).mock.calls[0]![1]
    const ctxB = vi.mocked(runApiInSandbox).mock.calls[1]![1]

    expect(ctxA.auditCollector).toBeInstanceOf(AuditCollector)
    expect(ctxA.progressCollector).toBeInstanceOf(ProgressCollector)
    expect(ctxA.idempotencyKey).toMatch(/^mcp-tasks-[0-9a-f]{12}-[0-9a-f]{16}$/)
    // Same user + same code ⇒ same idempotency key across calls
    expect(ctxA.idempotencyKey).toBe(ctxB.idempotencyKey)

    expect(ctxA.idempotencyKeyTtlMs).toBe(svc.idempotencyKeyTtlMs)
    expect(ctxA.correlationId).toBe('cid')
    expect(ctxA.sessionId).toBe('sid')
    expect(ctxA.tokenPayload).toEqual(goodTokenWithUser)
    expect(ctxA.limits).toEqual(svc.sandboxLimits)
  })

  it('records audit endpoints when the sandbox records them via AuditCollector', async () => {
    const svc = makeResources({ name: 'tasks' })
    vi.mocked(runApiInSandbox).mockImplementation(async (_code, ctx) => {
      ctx.auditCollector.record('GET', '/campaigns')
      ctx.auditCollector.record('PATCH', '/orders/{id}')
      return { done: true }
    })

    registerExecuteApiTool(
      server as unknown as McpServer,
      makeRegistry({ tasks: svc }),
      globalConfig,
      silentLogger,
      metrics as unknown as MetricsRegistry,
      'abc'
    )

    await server.handlers[TOOL.API_EXECUTE]!.handler(
      { service: 'tasks', code: 'async () => {}' },
      { correlationId: 'cid', sessionId: 'sid' }
    )

    const audit = vi.mocked(writeAuditRecord).mock.calls[0]![0]
    expect(audit.outcome).toBe(OUTCOME.SUCCESS)
    expect(audit.apiCallCount).toBe(2)
    expect(audit.endpointsAccessed).toEqual(['GET /campaigns', 'PATCH /orders/{id}'])
  })

  it('hashes the raw access_token when metadata.userId is absent', async () => {
    const svc = makeResources({
      name: 'tasks',
      validate: async () => goodToken
    })
    vi.mocked(runApiInSandbox).mockResolvedValue({})

    registerExecuteApiTool(
      server as unknown as McpServer,
      makeRegistry({ tasks: svc }),
      globalConfig,
      silentLogger,
      metrics as unknown as MetricsRegistry,
      'abc'
    )

    await server.handlers[TOOL.API_EXECUTE]!.handler(
      { service: 'tasks', code: 'async () => 1' },
      { correlationId: 'cid', sessionId: 'sid' }
    )

    const audit = vi.mocked(writeAuditRecord).mock.calls[0]![0]
    const expected = createHash('sha256').update(goodToken.access_token).digest('hex')
    expect(audit.userIdHash).toBe(expected)
  })

  it('PermissionDeniedError ⇒ OUTCOME.PERMISSION_DENIED, audit with userIdHash="unknown", no CB_OPENS, no SANDBOX_ERRORS', async () => {
    const svc = makeResources({ name: 'tasks' })
    vi.mocked(runApiInSandbox).mockRejectedValue(new PermissionDeniedError('/orders', 'POST'))

    registerExecuteApiTool(
      server as unknown as McpServer,
      makeRegistry({ tasks: svc }),
      globalConfig,
      silentLogger,
      metrics as unknown as MetricsRegistry,
      'abc'
    )

    const r = await server.handlers[TOOL.API_EXECUTE]!.handler(
      { service: 'tasks', code: 'async () => api.request({})' },
      { correlationId: 'cid', sessionId: 'sid' }
    )

    expect(r.isError).toBe(true)
    expect(JSON.parse(r.content[0]!.text).code).toBe(ERR.PERMISSION_DENIED)

    expect(metrics.increment).toHaveBeenCalledWith(METRIC.TOOL_CALLS, {
      tool: TOOL.API_EXECUTE,
      service: 'tasks',
      outcome: OUTCOME.PERMISSION_DENIED
    })
    const types = metrics.increment.mock.calls.map((c) => c[0])
    expect(types).not.toContain(METRIC.CB_OPENS)
    expect(types).not.toContain(METRIC.SANDBOX_ERRORS)

    const audit = vi.mocked(writeAuditRecord).mock.calls[0]![0]
    expect(audit.outcome).toBe(OUTCOME.PERMISSION_DENIED)
    expect(audit.userIdHash).toBe('unknown')
    expect(audit.errorCode).toBe(ERR.PERMISSION_DENIED)
    expect(audit.errorType).toBe('PermissionDeniedError')
    expect(audit.apiCallCount).toBe(0)
    expect(audit.endpointsAccessed).toEqual([])
  })

  it('CircuitOpenError ⇒ OUTCOME.CIRCUIT_OPEN + CB_OPENS{endpoint} metric', async () => {
    const svc = makeResources({ name: 'tasks' })
    vi.mocked(runApiInSandbox).mockRejectedValue(new CircuitOpenError('/campaigns', 30_000))

    registerExecuteApiTool(
      server as unknown as McpServer,
      makeRegistry({ tasks: svc }),
      globalConfig,
      silentLogger,
      metrics as unknown as MetricsRegistry,
      'abc'
    )

    const r = await server.handlers[TOOL.API_EXECUTE]!.handler(
      { service: 'tasks', code: 'async () => api.request({})' },
      { correlationId: 'cid', sessionId: 'sid' }
    )

    expect(r.isError).toBe(true)
    const body = JSON.parse(r.content[0]!.text)
    expect(body.code).toBe(ERR.CIRCUIT_OPEN)
    expect(body.retryable).toBe(true)

    expect(metrics.increment).toHaveBeenCalledWith(METRIC.CB_OPENS, { endpoint: '/campaigns' })
    expect(metrics.increment).toHaveBeenCalledWith(METRIC.TOOL_CALLS, {
      tool: TOOL.API_EXECUTE,
      service: 'tasks',
      outcome: OUTCOME.CIRCUIT_OPEN
    })

    const audit = vi.mocked(writeAuditRecord).mock.calls[0]![0]
    expect(audit.outcome).toBe(OUTCOME.CIRCUIT_OPEN)
  })

  it('SandboxCallLimitError ⇒ OUTCOME.CALL_LIMIT_EXCEEDED + SANDBOX_ERRORS metric', async () => {
    const svc = makeResources({ name: 'tasks' })
    vi.mocked(runApiInSandbox).mockRejectedValue(new SandboxCallLimitError(50))

    registerExecuteApiTool(
      server as unknown as McpServer,
      makeRegistry({ tasks: svc }),
      globalConfig,
      silentLogger,
      metrics as unknown as MetricsRegistry,
      'abc'
    )

    const r = await server.handlers[TOOL.API_EXECUTE]!.handler(
      { service: 'tasks', code: 'async () => 1' },
      { correlationId: 'cid', sessionId: 'sid' }
    )

    expect(r.isError).toBe(true)
    expect(JSON.parse(r.content[0]!.text).code).toBe('CALL_LIMIT_EXCEEDED')
    expect(metrics.increment).toHaveBeenCalledWith(METRIC.TOOL_CALLS, {
      tool: TOOL.API_EXECUTE,
      service: 'tasks',
      outcome: OUTCOME.CALL_LIMIT_EXCEEDED
    })
    expect(metrics.increment).toHaveBeenCalledWith(METRIC.SANDBOX_ERRORS, {
      tool: TOOL.API_EXECUTE,
      errorType: 'CALL_LIMIT_EXCEEDED'
    })
    const audit = vi.mocked(writeAuditRecord).mock.calls[0]![0]
    expect(audit.outcome).toBe(OUTCOME.CALL_LIMIT_EXCEEDED)
  })

  it('SandboxConcurrentLimitError ⇒ OUTCOME.CONCURRENT_LIMIT_EXCEEDED + SANDBOX_ERRORS metric', async () => {
    const svc = makeResources({ name: 'tasks' })
    vi.mocked(runApiInSandbox).mockRejectedValue(new SandboxConcurrentLimitError(5))

    registerExecuteApiTool(
      server as unknown as McpServer,
      makeRegistry({ tasks: svc }),
      globalConfig,
      silentLogger,
      metrics as unknown as MetricsRegistry,
      'abc'
    )

    const r = await server.handlers[TOOL.API_EXECUTE]!.handler(
      { service: 'tasks', code: 'async () => 1' },
      { correlationId: 'cid', sessionId: 'sid' }
    )

    expect(r.isError).toBe(true)
    expect(JSON.parse(r.content[0]!.text).code).toBe('CONCURRENT_LIMIT_EXCEEDED')
    expect(metrics.increment).toHaveBeenCalledWith(METRIC.TOOL_CALLS, {
      tool: TOOL.API_EXECUTE,
      service: 'tasks',
      outcome: OUTCOME.CONCURRENT_LIMIT_EXCEEDED
    })
    expect(metrics.increment).toHaveBeenCalledWith(METRIC.SANDBOX_ERRORS, {
      tool: TOOL.API_EXECUTE,
      errorType: 'CONCURRENT_LIMIT_EXCEEDED'
    })
  })

  it('other sandbox errors ⇒ OUTCOME.ERROR + SANDBOX_ERRORS metric', async () => {
    const svc = makeResources({ name: 'tasks' })
    vi.mocked(runApiInSandbox).mockRejectedValue(new SandboxRuntimeError('TypeError'))

    registerExecuteApiTool(
      server as unknown as McpServer,
      makeRegistry({ tasks: svc }),
      globalConfig,
      silentLogger,
      metrics as unknown as MetricsRegistry,
      'abc'
    )

    const r = await server.handlers[TOOL.API_EXECUTE]!.handler(
      { service: 'tasks', code: 'async () => bogus()' },
      { correlationId: 'cid', sessionId: 'sid' }
    )

    expect(r.isError).toBe(true)
    expect(JSON.parse(r.content[0]!.text).code).toBe('SANDBOX_RUNTIME')
    expect(metrics.increment).toHaveBeenCalledWith(METRIC.TOOL_CALLS, {
      tool: TOOL.API_EXECUTE,
      service: 'tasks',
      outcome: OUTCOME.ERROR
    })
    expect(metrics.increment).toHaveBeenCalledWith(METRIC.SANDBOX_ERRORS, {
      tool: TOOL.API_EXECUTE,
      errorType: 'SANDBOX_RUNTIME'
    })
  })

  it('SandboxExecutionError with a cause is recorded in audit but never leaked in the client response', async () => {
    const cause = new Error('pg connection refused')
    const svc = makeResources({ name: 'tasks' })
    vi.mocked(runApiInSandbox).mockRejectedValue(new SandboxExecutionError(cause))

    registerExecuteApiTool(
      server as unknown as McpServer,
      makeRegistry({ tasks: svc }),
      globalConfig,
      silentLogger,
      metrics as unknown as MetricsRegistry,
      'abc'
    )

    const r = await server.handlers[TOOL.API_EXECUTE]!.handler(
      { service: 'tasks', code: 'async () => 1' },
      { correlationId: 'cid', sessionId: 'sid' }
    )

    expect(r.isError).toBe(true)
    const body = JSON.parse(r.content[0]!.text)
    expect(body.code).toBe(ERR.SANDBOX_INTERNAL_ERROR)
    expect(body.retryable).toBe(true)
    expect(body.error).not.toContain('pg connection refused')

    const audit = vi.mocked(writeAuditRecord).mock.calls[0]![0]
    expect(audit.outcome).toBe(OUTCOME.ERROR)
    expect(audit.errorCode).toBe(ERR.SANDBOX_INTERNAL_ERROR)
  })

  it('does NOT write an audit record when globalConfig.observability.enableAudit=false (unit-level: writeAuditRecord is still invoked but returns early)', async () => {
    // This test guards the wiring: the tool calls writeAuditRecord twice (success/failure branches)
    // but the audit backend itself decides whether to persist. We verify the call is made with the
    // tool's outcome, and that the disabled-audit globalConfig is passed through unmodified.
    const svc = makeResources({ name: 'tasks' })
    vi.mocked(runApiInSandbox).mockResolvedValue({ ok: true })

    const disabledAudit: GlobalConfig = {
      ...globalConfig,
      observability: { ...globalConfig.observability, enableAudit: false }
    }

    registerExecuteApiTool(
      server as unknown as McpServer,
      makeRegistry({ tasks: svc }),
      disabledAudit,
      silentLogger,
      metrics as unknown as MetricsRegistry,
      'abc'
    )

    await server.handlers[TOOL.API_EXECUTE]!.handler(
      { service: 'tasks', code: 'async () => 1' },
      { correlationId: 'cid', sessionId: 'sid' }
    )

    expect(writeAuditRecord).toHaveBeenCalledTimes(1)
    const [, , cfg] = vi.mocked(writeAuditRecord).mock.calls[0]!
    expect(cfg.observability.enableAudit).toBe(false)
  })

  it('generates correlationId/sessionId when the extra bag is empty and propagates both to the sandbox context', async () => {
    const svc = makeResources({ name: 'tasks' })
    vi.mocked(runApiInSandbox).mockResolvedValue({ ok: true })

    registerExecuteApiTool(
      server as unknown as McpServer,
      makeRegistry({ tasks: svc }),
      globalConfig,
      silentLogger,
      metrics as unknown as MetricsRegistry,
      'abc'
    )

    await server.handlers[TOOL.API_EXECUTE]!.handler({ service: 'tasks', code: 'async () => 1' }, {})

    const ctx = vi.mocked(runApiInSandbox).mock.calls[0]![1]
    expect(ctx.correlationId).toMatch(/^[0-9a-f-]{36}$/)
    expect(ctx.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(ctx.correlationId).not.toBe(ctx.sessionId)
  })

  it('attaches structured progress to the error payload when the sandbox recorded calls before failing', async () => {
    const svc = makeResources({ name: 'tasks' })
    vi.mocked(runApiInSandbox).mockImplementation(async (_code, ctx) => {
      ctx.progressCollector!.recordSuccess('POST', '/campaigns', 201, true, { campaignId: 'C1' })
      ctx.progressCollector!.recordSuccess('POST', '/placements', 201, true, { placementId: 'P9' })
      ctx.progressCollector!.recordFailure('POST', '/ads', 'Upstream API returned 500', false)
      throw new SandboxRuntimeError('boom')
    })

    registerExecuteApiTool(
      server as unknown as McpServer,
      makeRegistry({ tasks: svc }),
      globalConfig,
      silentLogger,
      metrics as unknown as MetricsRegistry,
      'abc'
    )

    const r = await server.handlers[TOOL.API_EXECUTE]!.handler(
      { service: 'tasks', code: 'async () => bogus()' },
      { correlationId: 'cid', sessionId: 'sid' }
    )

    expect(r.isError).toBe(true)
    const body = JSON.parse(r.content[0]!.text)
    expect(body.code).toBe('SANDBOX_RUNTIME')
    expect(body.error).toContain('boom')
    expect(body.progress).toBeDefined()
    expect(body.progress.completedCalls).toBe(2)
    expect(body.progress.calls).toHaveLength(3)
    expect(body.progress.calls[0]).toEqual({
      i: 1, method: 'POST', endpoint: '/campaigns', status: 201, ok: true, ids: { campaignId: 'C1' }
    })
    expect(body.progress.calls[1].ids).toEqual({ placementId: 'P9' })
    expect(body.progress.calls[2]).toMatchObject({
      method: 'POST', endpoint: '/ads', aborted: false
    })
  })

  it('omits the progress field on errors when no calls were recorded', async () => {
    const svc = makeResources({ name: 'tasks' })
    vi.mocked(runApiInSandbox).mockRejectedValue(new SandboxRuntimeError('compile fail'))

    registerExecuteApiTool(
      server as unknown as McpServer,
      makeRegistry({ tasks: svc }),
      globalConfig,
      silentLogger,
      metrics as unknown as MetricsRegistry,
      'abc'
    )

    const r = await server.handlers[TOOL.API_EXECUTE]!.handler(
      { service: 'tasks', code: 'async () => bogus()' },
      { correlationId: 'cid', sessionId: 'sid' }
    )

    expect(r.isError).toBe(true)
    const body = JSON.parse(r.content[0]!.text)
    expect(body.code).toBe('SANDBOX_RUNTIME')
    expect(body.progress).toBeUndefined()
    // Error message must no longer carry the legacy "Progress before failure"
    // string suffix — that data now lives in the structured progress field.
    expect(body.error).not.toContain('Progress before failure')
  })
})
