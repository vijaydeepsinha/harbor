// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Logger } from '../../runtime/observability/logger.js'

const { mockServeStdio } = vi.hoisted(() => ({
  mockServeStdio: vi.fn()
}))

vi.mock('@modelcontextprotocol/server/stdio', () => ({
  serveStdio: mockServeStdio
}))

import { startStdioGateway } from '../../runtime/transport/stdio-gateway.js'
import { ServiceRegistry } from '../../runtime/registry/service-registry.js'
import type { GatewayMcpServerFactory } from '../../runtime/http/mcp-server-factory.js'

function makeLogger(): Logger {
  const noop = () => {}
  return {
    info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop,
    child: () => makeLogger()
  } as unknown as Logger
}

const noopFactory: GatewayMcpServerFactory = () => ({} as never)

describe('startStdioGateway', () => {
  beforeEach(() => {
    mockServeStdio.mockReset()
  })

  it('constructs serveStdio with { legacy: "reject" } — the PR\'s headline breaking change (C-1)', async () => {
    await startStdioGateway({
      createMcpServer: noopFactory,
      registry: new ServiceRegistry(),
      logger: makeLogger()
    })

    expect(mockServeStdio).toHaveBeenCalledTimes(1)
    const [factory, options] = mockServeStdio.mock.calls[0] as [unknown, { legacy?: string; onerror?: (error: Error) => void }]
    expect(factory).toBe(noopFactory)
    expect(options).toMatchObject({ legacy: 'reject' })
  })

  it('wires an onerror callback that logs via the errorMessage helper (H-2)', async () => {
    const errorSpy = vi.fn()
    const logger = { ...makeLogger(), error: errorSpy } as unknown as Logger

    await startStdioGateway({
      createMcpServer: noopFactory,
      registry: new ServiceRegistry(),
      logger
    })

    const [, options] = mockServeStdio.mock.calls[0] as [unknown, { onerror?: (error: Error) => void }]
    expect(options.onerror).toBeTypeOf('function')

    const boom = new Error('stdio transport write failure')
    options.onerror?.(boom)

    expect(errorSpy).toHaveBeenCalledWith({ error: 'stdio transport write failure' }, 'stdio MCP connection error')
  })
})
