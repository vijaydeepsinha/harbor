// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, afterEach, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import { startHttpGateway, type HttpGatewayHandle } from '../../runtime/http/http-gateway.js'
import { ServiceRegistry } from '../../runtime/registry/service-registry.js'
import type { Logger } from '../../runtime/observability/logger.js'
import { MCP_SESSION_HEADER, ERR } from '../../core/constants.js'

/**
 * The gateway is tested end-to-end against a real `node:http` listener on an
 * ephemeral port. Routes that never reach `transport.handleRequest` (health,
 * 404s, and every auth rejection path) can be asserted without any MCP SDK
 * plumbing because the gateway short-circuits before handing off to the
 * transport. The "session creation" case only asserts that auth passed —
 * the SDK's own init handshake is not the gateway's contract to honour.
 */

function makeLogger(): Logger {
  const noop = () => {}
  return {
    info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop,
    child: () => makeLogger()
  } as unknown as Logger
}

interface RecordingLogger extends Logger {
  warnSpy: ReturnType<typeof vi.fn>
  errorSpy: ReturnType<typeof vi.fn>
}

function makeRecordingLogger(): RecordingLogger {
  const warnSpy = vi.fn()
  const errorSpy = vi.fn()
  const logger = {
    info: () => {},
    warn: warnSpy,
    error: errorSpy,
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child: () => logger
  } as unknown as RecordingLogger
  logger.warnSpy = warnSpy
  logger.errorSpy = errorSpy
  return logger
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
    idleTtlMs: 60_000,
    sweepIntervalMs: 60_000,
    createSessionServer: () => {
      throw new Error('createSessionServer not expected to be called in this test')
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
      handle.stopIdleSweep()
      handle.server.close(err => err ? reject(err) : resolve())
    })
  }
}

describe('startHttpGateway', () => {
  let cleanup: (() => Promise<void>) | null = null

  afterEach(async () => {
    if (cleanup) {
      await cleanup()
      cleanup = null
    }
  })

  it('GET /health returns 200 with registry + session snapshot', async () => {
    const registry = new ServiceRegistry()
    const { baseUrl, close } = await startForTest({ registry })
    cleanup = close

    const res = await fetch(`${baseUrl}/health`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json() as { status: string; services: string[]; activeSessions: number }
    expect(body.status).toBe('ok')
    expect(body.services).toEqual([])
    expect(body.activeSessions).toBe(0)
  })

  it('unknown route returns 404 with the gateway error envelope', async () => {
    const { baseUrl, close } = await startForTest()
    cleanup = close

    const res = await fetch(`${baseUrl}/does-not-exist`)
    expect(res.status).toBe(404)
    const body = await res.json() as { error: string; code: string }
    expect(body.code).toBe(ERR.NOT_FOUND)
  })

  it('POST /mcp without Authorization is rejected before creating a session', async () => {
    let createSessionCalled = false
    const { baseUrl, close } = await startForTest({
      createSessionServer: () => {
        createSessionCalled = true
        throw new Error('should not reach createSessionServer')
      }
    })
    cleanup = close

    const res = await fetch(`${baseUrl}/mcp`, { method: 'POST' })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    expect(createSessionCalled).toBe(false)
    const body = await res.json() as { code: string }
    expect(body.code).toBe(ERR.MISSING_TOKEN)
  })

  it('resuming with an unknown mcp-session-id returns 404', async () => {
    const { baseUrl, close } = await startForTest()
    cleanup = close

    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer doesnt-matter',
        [MCP_SESSION_HEADER]: 'no-such-session'
      }
    })
    expect(res.status).toBe(404)
    const body = await res.json() as { code: string }
    expect(body.code).toBe(ERR.UNKNOWN_SESSION)
  })

  it('4xx failures are logged at warn via the top-level funnel with the logContext payload', async () => {
    const logger = makeRecordingLogger()
    const { baseUrl, close } = await startForTest({ logger })
    cleanup = close

    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer doesnt-matter',
        [MCP_SESSION_HEADER]: 'no-such-session'
      }
    })
    expect(res.status).toBe(404)

    expect(logger.warnSpy).toHaveBeenCalledTimes(1)
    const [payload, message] = logger.warnSpy.mock.calls[0]
    expect(message).toBe('Unknown session: no-such-session')
    expect(payload).toMatchObject({
      code: ERR.UNKNOWN_SESSION,
      sessionId: 'no-such-session',
      url: '/mcp',
      method: 'POST'
    })
    expect(logger.errorSpy).not.toHaveBeenCalled()
  })

  it('bearer failures on new-session requests include the reason enum in the response body', async () => {
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
})
