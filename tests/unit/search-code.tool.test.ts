// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import pino from 'pino'

vi.mock('../../runtime/sandbox/spec-search-in-sandbox.js', () => ({
  runSpecSearchInSandbox: vi.fn()
}))

import { runSpecSearchInSandbox } from '../../runtime/sandbox/spec-search-in-sandbox.js'
import { registerSearchCodeTool } from '../../tools/search-code.tool.js'
import { TOOL, METRIC, OUTCOME, ERR } from '../../core/constants.js'
import type { ServiceRegistry, ServiceResources } from '../../runtime/registry/service-registry.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { MetricsRegistry } from '../../runtime/observability/metrics.js'
import type { TokenPayload } from '../../core/types/auth.types.js'
import { MissingTokenError } from '../../core/types/auth.types.js'
import { SandboxTimeoutError } from '../../core/types/sandbox-error.types.js'

const silentLogger = pino({ level: 'silent' })

type Handler = (args: { service: string; code: string }, extra: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>

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

const rawSpec = { paths: { '/orders': { get: { summary: 'List orders' } } } }
const filteredSpec = { paths: { '/orders': { get: { summary: 'filtered' } } } }

function makeResources(opts: {
  name?: string
  spec?: unknown
  filter?: (spec: unknown, token: TokenPayload) => unknown
  validate?: (auth: string | undefined, cid: string) => Promise<TokenPayload>
} = {}): ServiceResources {
  const innerValidate = opts.validate ?? (async () => goodToken)
  const filterFn = opts.filter ?? ((s: unknown) => s)
  return {
    name: opts.name ?? 'svc',
    authMiddleware: {
      validateRequest: async (auth: string | undefined, cid: string) => ({
        payload: await innerValidate(auth, cid),
        invalidate: async () => {}
      })
    },
    specStore: {
      getSpec: () => opts.spec ?? rawSpec
    },
    permissionGuard: {
      filterSpec: vi.fn(filterFn),
      canExecute: () => true
    },
    sandboxLimits: {
      memoryLimitMb: 64,
      executeTimeoutMs: 8000,
      searchTimeoutMs: 3000,
      maxApiCalls: 50,
      maxConcurrentCalls: 5
    }
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

describe('registerSearchCodeTool', () => {
  let server: FakeServer
  let metrics: ReturnType<typeof makeMetrics>

  beforeEach(() => {
    vi.clearAllMocks()
    server = makeFakeServer()
    metrics = makeMetrics()
  })

  it('registers under TOOL.SEARCH_CODE with service & code input schema and the available services in the description', () => {
    const svc = makeResources({ name: 'tasks' })
    registerSearchCodeTool(
      server as unknown as McpServer,
      makeRegistry({ tasks: svc }),
      silentLogger,
      metrics as unknown as MetricsRegistry,
      'abc'
    )

    const entry = server.handlers[TOOL.SEARCH_CODE]
    expect(entry).toBeDefined()
    expect(entry!.def.description).toContain('tasks')
    const schema = entry!.def.inputSchema as Record<string, unknown>
    expect(Object.keys(schema)).toEqual(expect.arrayContaining(['service', 'code']))
  })

  it('returns UNKNOWN_SERVICE mcpError when the service is not registered', async () => {
    const svc = makeResources({ name: 'tasks' })
    registerSearchCodeTool(
      server as unknown as McpServer,
      makeRegistry({ tasks: svc }),
      silentLogger,
      metrics as unknown as MetricsRegistry,
      'abc'
    )

    const r = await server.handlers[TOOL.SEARCH_CODE]!.handler(
      { service: 'ghost', code: 'async () => spec' },
      { correlationId: 'cid' }
    )
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.content[0]!.text).code).toBe(ERR.UNKNOWN_SERVICE)
    expect(runSpecSearchInSandbox).not.toHaveBeenCalled()
  })

  it('returns an auth mcpError and does NOT load the spec when validation fails', async () => {
    const getSpec = vi.fn().mockReturnValue(rawSpec)
    const svc = makeResources({
      name: 'tasks',
      validate: async () => {
        throw new MissingTokenError()
      }
    })
    // Override specStore so we can observe it not being called
    ;(svc as unknown as { specStore: { getSpec: () => unknown } }).specStore = { getSpec }

    registerSearchCodeTool(
      server as unknown as McpServer,
      makeRegistry({ tasks: svc }),
      silentLogger,
      metrics as unknown as MetricsRegistry,
      undefined
    )

    const r = await server.handlers[TOOL.SEARCH_CODE]!.handler(
      { service: 'tasks', code: 'async () => spec' },
      { correlationId: 'cid' }
    )
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.content[0]!.text).code).toBe(ERR.MISSING_TOKEN)
    expect(getSpec).not.toHaveBeenCalled()
    expect(runSpecSearchInSandbox).not.toHaveBeenCalled()
  })

  it('applies permissionGuard.filterSpec with the token payload before handing the spec to the sandbox', async () => {
    const filter = vi.fn().mockReturnValue(filteredSpec)
    const svc = makeResources({ name: 'tasks', filter })
    vi.mocked(runSpecSearchInSandbox).mockResolvedValue([{ path: '/orders' }])

    registerSearchCodeTool(
      server as unknown as McpServer,
      makeRegistry({ tasks: svc }),
      silentLogger,
      metrics as unknown as MetricsRegistry,
      'abc'
    )

    const r = await server.handlers[TOOL.SEARCH_CODE]!.handler(
      { service: 'tasks', code: 'async () => Object.keys(spec.paths)' },
      { correlationId: 'cid' }
    )

    expect(r.isError).toBeUndefined()
    expect(JSON.parse(r.content[0]!.text)).toEqual([{ path: '/orders' }])

    expect(filter).toHaveBeenCalledTimes(1)
    expect(filter).toHaveBeenCalledWith(rawSpec, goodToken)

    expect(runSpecSearchInSandbox).toHaveBeenCalledWith(
      'async () => Object.keys(spec.paths)',
      filteredSpec,
      svc.sandboxLimits
    )

    expect(metrics.increment).toHaveBeenCalledWith(METRIC.TOOL_CALLS, {
      tool: TOOL.SEARCH_CODE,
      service: 'tasks',
      outcome: OUTCOME.SUCCESS
    })
  })

  it('translates sandbox timeouts into mcpError + TOOL_CALLS(error) + SANDBOX_ERRORS', async () => {
    const svc = makeResources({ name: 'tasks' })
    vi.mocked(runSpecSearchInSandbox).mockRejectedValue(new SandboxTimeoutError(3000))

    registerSearchCodeTool(
      server as unknown as McpServer,
      makeRegistry({ tasks: svc }),
      silentLogger,
      metrics as unknown as MetricsRegistry,
      'abc'
    )

    const r = await server.handlers[TOOL.SEARCH_CODE]!.handler(
      { service: 'tasks', code: 'async () => { while (true) {} }' },
      { correlationId: 'cid' }
    )

    expect(r.isError).toBe(true)
    const body = JSON.parse(r.content[0]!.text)
    expect(body.code).toBe('SANDBOX_TIMEOUT')
    expect(body.retryable).toBe(true)
    expect(metrics.increment).toHaveBeenCalledWith(METRIC.TOOL_CALLS, {
      tool: TOOL.SEARCH_CODE,
      service: 'tasks',
      outcome: OUTCOME.ERROR
    })
    expect(metrics.increment).toHaveBeenCalledWith(METRIC.SANDBOX_ERRORS, {
      tool: TOOL.SEARCH_CODE,
      errorType: 'SANDBOX_TIMEOUT'
    })
  })
})
