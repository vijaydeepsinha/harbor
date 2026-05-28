// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import pino from 'pino'
import {
  extractCorrelationId,
  extractSessionId,
  resolveService,
  isToolError,
  mcpError,
  mcpSuccess,
  validateAuth,
  runSandboxTool,
  type ToolResponse
} from '../../tools/tool-helpers.js'
import type { ServiceRegistry, ServiceResources } from '../../runtime/registry/service-registry.js'
import { MissingTokenError, SessionExpiredError, type TokenPayload } from '../../core/types/auth.types.js'
import { ERR, METRIC, OUTCOME } from '../../core/constants.js'

const silentLogger = pino({ level: 'silent' })

const testToken: TokenPayload = {
  access_token: 'test',
  token_type: 'bearer',
  expires_in: 3600,
  refresh_token: 'r',
  scope: 'login_mode:self'
}

function makeResources(
  opts: {
    name?: string
    validate?: (auth: string | undefined, correlationId: string) => Promise<TokenPayload>
  } = {}
): ServiceResources {
  const innerValidate = opts.validate ?? (async () => testToken)
  return {
    name: opts.name ?? 'svc',
    authMiddleware: {
      validateRequest: async (auth: string | undefined, cid: string) => ({
        payload: await innerValidate(auth, cid),
        invalidate: async () => {}
      })
    } as unknown as ServiceResources['authMiddleware']
  } as unknown as ServiceResources
}

function makeMetrics() {
  return { increment: vi.fn() } as unknown as ServiceResources['metrics'] & { increment: ReturnType<typeof vi.fn> }
}

describe('tool-helpers extractors', () => {
  it('extractCorrelationId returns the provided id', () => {
    expect(extractCorrelationId({ correlationId: 'abc' })).toBe('abc')
  })

  it('extractCorrelationId falls back to a uuid when absent', () => {
    const id = extractCorrelationId(undefined)
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('extractSessionId returns the provided id', () => {
    expect(extractSessionId({ sessionId: 'sess-1' })).toBe('sess-1')
  })

  it('extractSessionId falls back to a uuid when absent', () => {
    const id = extractSessionId(undefined)
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('tool-helpers responses', () => {
  it('mcpError shapes a text error payload with isError=true', () => {
    const r = mcpError('boom', ERR.AUTH_FAILED, true)
    expect(r.isError).toBe(true)
    const parsed = JSON.parse(r.content[0].text)
    expect(parsed).toEqual({ error: 'boom', code: ERR.AUTH_FAILED, retryable: true })
  })

  it('mcpError merges optional extra fields into the payload', () => {
    const r = mcpError('boom', ERR.API_ERROR, false, { progress: { completedCalls: 2 } })
    const parsed = JSON.parse(r.content[0].text)
    expect(parsed).toEqual({
      progress: { completedCalls: 2 },
      error: 'boom',
      code: ERR.API_ERROR,
      retryable: false
    })
  })

  it('mcpError extra cannot override the reserved error/code/retryable fields', () => {
    const r = mcpError('real', ERR.API_ERROR, true, {
      error: 'spoofed',
      code: 'SPOOFED',
      retryable: false,
      extraField: 1
    } as Record<string, unknown>)
    const parsed = JSON.parse(r.content[0].text)
    expect(parsed.error).toBe('real')
    expect(parsed.code).toBe(ERR.API_ERROR)
    expect(parsed.retryable).toBe(true)
    expect(parsed.extraField).toBe(1)
  })

  it('mcpSuccess stringifies non-string data', () => {
    const r = mcpSuccess({ a: 1 })
    expect(r.isError).toBeUndefined()
    expect(JSON.parse(r.content[0].text)).toEqual({ a: 1 })
  })

  it('mcpSuccess passes strings through unchanged', () => {
    const r = mcpSuccess('hello')
    expect(r.content[0].text).toBe('hello')
  })

  it('isToolError detects error responses', () => {
    expect(isToolError(mcpError('x', 'y'))).toBe(true)
    expect(isToolError(mcpSuccess('x'))).toBe(false)
    expect(isToolError({})).toBe(false)
  })
})

describe('resolveService', () => {
  function makeRegistry(entries: Record<string, ServiceResources>): ServiceRegistry {
    return {
      get: (k: string) => entries[k]
    } as unknown as ServiceRegistry
  }

  it('returns resources when the service is known', () => {
    const svc = makeResources({ name: 'a' })
    const result = resolveService(makeRegistry({ a: svc }), 'a', ['a', 'b'])
    expect(result).toBe(svc)
  })

  it('returns an mcpError with UNKNOWN_SERVICE when the service is missing', () => {
    const result = resolveService(makeRegistry({}), 'missing', ['a', 'b']) as ToolResponse
    expect(isToolError(result)).toBe(true)
    const body = JSON.parse(result.content[0].text)
    expect(body.code).toBe(ERR.UNKNOWN_SERVICE)
    expect(body.retryable).toBe(true)
    expect(body.error).toContain('missing')
    expect(body.error).toContain('a, b')
  })
})

describe('validateAuth', () => {
  it('forwards "Bearer <token>" to the middleware when a client token is present', async () => {
    const validate = vi.fn().mockResolvedValue(testToken)
    const r = await validateAuth(makeResources({ validate }), 'abc', 'cid', silentLogger, 'some_tool')
    expect(isToolError(r)).toBe(false)
    expect((r as { payload: TokenPayload }).payload).toBe(testToken)
    expect(validate).toHaveBeenCalledWith('Bearer abc', 'cid')
  })

  it('forwards undefined (no fallback) when no client token is present', async () => {
    const validate = vi.fn().mockResolvedValue(testToken)
    await validateAuth(makeResources({ validate }), undefined, 'cid', silentLogger, 't')
    expect(validate).toHaveBeenCalledWith(undefined, 'cid')
  })

  it('maps SessionExpiredError to a non-retryable mcpError', async () => {
    const validate = vi.fn().mockRejectedValue(new SessionExpiredError())
    const r = (await validateAuth(makeResources({ validate }), 'abc', 'cid', silentLogger, 't')) as ToolResponse
    expect(isToolError(r)).toBe(true)
    const body = JSON.parse(r.content[0].text)
    expect(body.code).toBe(ERR.SESSION_EXPIRED)
    expect(body.retryable).toBe(false)
  })

  it('maps MissingTokenError to an mcpError preserving its code', async () => {
    const validate = vi.fn().mockRejectedValue(new MissingTokenError())
    const r = (await validateAuth(makeResources({ validate }), undefined, 'cid', silentLogger, 't')) as ToolResponse
    expect(isToolError(r)).toBe(true)
    const body = JSON.parse(r.content[0].text)
    expect(body.code).toBe(ERR.MISSING_TOKEN)
  })
})

describe('runSandboxTool HOF', () => {
  let metrics: ReturnType<typeof makeMetrics>

  beforeEach(() => {
    metrics = makeMetrics()
  })

  it('returns the mcpError early when auth fails and never runs the body', async () => {
    const validate = vi.fn().mockRejectedValue(new MissingTokenError())
    const body = vi.fn()
    const r = await runSandboxTool(
      {
        tool: 'search_code',
        service: 'svc',
        resources: makeResources({ validate }),
        clientToken: undefined,
        correlationId: 'cid',
        logger: silentLogger,
        metrics: metrics as unknown as ServiceResources['metrics']
      },
      body as () => Promise<unknown>
    )
    expect(isToolError(r)).toBe(true)
    expect(body).not.toHaveBeenCalled()
    expect(metrics.increment).not.toHaveBeenCalled()
  })

  it('increments TOOL_CALLS with outcome=success and wraps the body result', async () => {
    const r = await runSandboxTool(
      {
        tool: 'search_code',
        service: 'svc',
        resources: makeResources(),
        clientToken: 'abc',
        correlationId: 'cid',
        logger: silentLogger,
        metrics: metrics as unknown as ServiceResources['metrics']
      },
      async () => ({ hits: 3 })
    )
    expect(isToolError(r)).toBe(false)
    expect(JSON.parse(r.content[0].text)).toEqual({ hits: 3 })
    expect(metrics.increment).toHaveBeenCalledWith(METRIC.TOOL_CALLS, {
      tool: 'search_code',
      service: 'svc',
      outcome: OUTCOME.SUCCESS
    })
  })

  it('emits both TOOL_CALLS(error) and SANDBOX_ERRORS when the body throws', async () => {
    const err = Object.assign(new Error('boom'), { code: 'SANDBOX_TIMEOUT' })
    const r = await runSandboxTool(
      {
        tool: 'search_code',
        service: 'svc',
        resources: makeResources(),
        clientToken: 'abc',
        correlationId: 'cid',
        logger: silentLogger,
        metrics: metrics as unknown as ServiceResources['metrics']
      },
      async () => {
        throw err
      }
    )
    expect(isToolError(r)).toBe(true)
    const body = JSON.parse(r.content[0].text)
    expect(body.code).toBe('SANDBOX_TIMEOUT')
    expect(metrics.increment).toHaveBeenCalledWith(METRIC.TOOL_CALLS, {
      tool: 'search_code',
      service: 'svc',
      outcome: OUTCOME.ERROR
    })
    expect(metrics.increment).toHaveBeenCalledWith(METRIC.SANDBOX_ERRORS, {
      tool: 'search_code',
      errorType: 'SANDBOX_TIMEOUT'
    })
  })
})
