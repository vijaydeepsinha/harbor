// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, afterEach, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { AuthInfo } from '@modelcontextprotocol/server'
import { ERR } from '../../core/constants.js'

const { mockNodeMcpHandler } = vi.hoisted(() => ({
  mockNodeMcpHandler: vi.fn()
}))

vi.mock('@modelcontextprotocol/server', () => ({
  createMcpHandler: vi.fn(() => ({ fetch: vi.fn() }))
}))

vi.mock('@modelcontextprotocol/node', () => ({
  toNodeHandler: vi.fn(() => mockNodeMcpHandler)
}))

import { startHttpGateway, type HttpGatewayHandle } from '../../runtime/http/http-gateway.js'
import { ServiceRegistry } from '../../runtime/registry/service-registry.js'
import type { Logger } from '../../runtime/observability/logger.js'

/**
 * The gateway is tested end-to-end against a real `node:http` listener on an
 * ephemeral port. Routes that never reach the MCP handler (health, 404s, and
 * every auth rejection path) can be asserted without any SDK plumbing because
 * the gateway short-circuits before delegating to `toNodeHandler`.
 */

function makeLogger(): Logger {
  const noop = () => {}
  return {
    info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop,
    child: () => makeLogger()
  } as unknown as Logger
}

async function startForTest(overrides: Partial<Parameters<typeof startHttpGateway>[0]> = {}): Promise<{
  handle: HttpGatewayHandle
  baseUrl: string
  close: () => Promise<void>
}> {
  const registry = overrides.registry ?? new ServiceRegistry()
  const handle = startHttpGateway({
    host: '127.0.0.1',
    port: 0,
    createMcpServer: () => {
      throw new Error('createMcpServer not expected to be called in this test')
    },
    registry,
    logger: makeLogger(),
    ...overrides
  })
  await new Promise<void>(resolve => handle.server.once('listening', () => resolve()))
  const { port } = handle.server.address() as AddressInfo
  return {
    handle,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => {
      handle.server.close(err => err ? reject(err) : resolve())
    })
  }
}

describe('startHttpGateway', () => {
  let cleanup: (() => Promise<void>) | null = null

  afterEach(async () => {
    mockNodeMcpHandler.mockReset()
    if (cleanup) {
      await cleanup()
      cleanup = null
    }
  })

  it('GET /health returns 200 with service registry snapshot', async () => {
    const registry = new ServiceRegistry()
    const { baseUrl, close } = await startForTest({ registry })
    cleanup = close

    const res = await fetch(`${baseUrl}/health`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json() as { status: string; services: string[] }
    expect(body.status).toBe('ok')
    expect(body.services).toEqual([])
  })

  it('unknown route returns 404 with the gateway error envelope', async () => {
    const { baseUrl, close } = await startForTest()
    cleanup = close

    const res = await fetch(`${baseUrl}/does-not-exist`)
    expect(res.status).toBe(404)
    const body = await res.json() as { error: string; code: string }
    expect(body.code).toBe(ERR.NOT_FOUND)
  })

  it('POST /mcp without Authorization is rejected before MCP dispatch', async () => {
    const { baseUrl, close } = await startForTest()
    cleanup = close

    const res = await fetch(`${baseUrl}/mcp`, { method: 'POST' })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    expect(mockNodeMcpHandler).not.toHaveBeenCalled()
    const body = await res.json() as { code: string }
    expect(body.code).toBe(ERR.MISSING_TOKEN)
  })

  it('bearer failures include the reason enum in the response body', async () => {
    const { baseUrl, close } = await startForTest()
    cleanup = close

    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { Authorization: 'Basic not-a-bearer' }
    })
    expect(res.status).toBe(401)
    const body = await res.json() as { code: string; reason: string; error: string }
    expect(body.code).toBe(ERR.MISSING_TOKEN)
    expect(typeof body.reason).toBe('string')
    expect(body.reason.length).toBeGreaterThan(0)
  })

  it('last-resort 500 fires when the handler throws before headers are sent', async () => {
    // Start with a working registry, then swap the method to throw *after* the
    // listen() log line has already run — that way only the request handler's
    // call to serviceNames() blows up, exercising the outer try/catch.
    const registry = new ServiceRegistry()
    const { baseUrl, close } = await startForTest({ registry })
    cleanup = close

    registry.serviceNames = () => { throw new Error('boom') }

    const res = await fetch(`${baseUrl}/health`)
    expect(res.status).toBe(500)
    const body = await res.json() as { code: string }
    expect(body.code).toBe(ERR.INTERNAL)
  })

  it('POST /mcp with valid bearer attaches authInfo and delegates to the MCP handler', async () => {
    mockNodeMcpHandler.mockImplementation(async (req, res) => {
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
    })

    let factoryCalled = false
    const { baseUrl, close } = await startForTest({
      createMcpServer: (ctx) => {
        factoryCalled = true
        expect(ctx.authInfo?.token).toBeDefined()
        return {} as never
      }
    })
    cleanup = close

    const testToken = 'abcdefghijklmnopqrstuvwxyz0123456789AB'
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${testToken}` }
    })

    expect(res.status).toBe(200)
    expect(mockNodeMcpHandler).toHaveBeenCalledTimes(1)

    const [req] = mockNodeMcpHandler.mock.calls[0] as [{ auth?: AuthInfo }]
    expect(req.auth?.token).toBe(testToken)
    // Factory is invoked by createMcpHandler at handler construction time in
    // production; here we only assert auth passthrough on the Node request.
    expect(factoryCalled).toBe(false)
  })
})
