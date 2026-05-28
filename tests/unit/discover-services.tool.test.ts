// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import pino from 'pino'
import { registerDiscoverServicesTool } from '../../tools/discover-services.tool.js'
import { TOOL, METRIC, OUTCOME } from '../../core/constants.js'
import type { ServiceRegistry } from '../../runtime/registry/service-registry.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { MetricsRegistry } from '../../runtime/observability/metrics.js'

const silentLogger = pino({ level: 'silent' })

type Handler = (args: unknown, extra: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>

interface FakeServer {
  handlers: Record<string, { def: { description?: string; inputSchema?: unknown }; handler: Handler }>
  registerTool(name: string, def: { description?: string; inputSchema?: unknown }, handler: Handler): void
}

function makeFakeServer(): FakeServer {
  const handlers: FakeServer['handlers'] = {}
  return {
    handlers,
    registerTool(name, def, handler) {
      handlers[name] = { def, handler }
    }
  }
}

function makeRegistry(entries: Array<{ service: string; description: string }>): ServiceRegistry {
  return {
    listServices: () => entries,
    serviceNames: () => entries.map(e => e.service)
  } as unknown as ServiceRegistry
}

function makeMetrics() {
  return { increment: vi.fn(), stop: vi.fn() } as unknown as MetricsRegistry & { increment: ReturnType<typeof vi.fn> }
}

describe('registerDiscoverServicesTool', () => {
  let server: FakeServer
  let metrics: ReturnType<typeof makeMetrics>

  beforeEach(() => {
    server = makeFakeServer()
    metrics = makeMetrics()
  })

  it('registers under TOOL.DISCOVER_SERVICES with a description', () => {
    registerDiscoverServicesTool(
      server as unknown as McpServer,
      makeRegistry([{ service: 'svc', description: 'desc' }]),
      silentLogger,
      metrics as unknown as MetricsRegistry
    )

    expect(server.handlers[TOOL.DISCOVER_SERVICES]).toBeDefined()
    expect(typeof server.handlers[TOOL.DISCOVER_SERVICES]!.def.description).toBe('string')
    expect(server.handlers[TOOL.DISCOVER_SERVICES]!.def.description!.length).toBeGreaterThan(0)
  })

  it('returns the registry service catalog as mcpSuccess JSON', async () => {
    const entries = [
      { service: 'tasks', description: 'Task management' },
      { service: 'billing', description: 'Billing & invoices' }
    ]
    registerDiscoverServicesTool(
      server as unknown as McpServer,
      makeRegistry(entries),
      silentLogger,
      metrics as unknown as MetricsRegistry
    )

    const result = await server.handlers[TOOL.DISCOVER_SERVICES]!.handler({}, {})
    expect(result.isError).toBeUndefined()
    expect(JSON.parse(result.content[0]!.text)).toEqual(entries)
  })

  it('returns an empty array when no services are registered', async () => {
    registerDiscoverServicesTool(
      server as unknown as McpServer,
      makeRegistry([]),
      silentLogger,
      metrics as unknown as MetricsRegistry
    )

    const result = await server.handlers[TOOL.DISCOVER_SERVICES]!.handler({}, {})
    expect(JSON.parse(result.content[0]!.text)).toEqual([])
  })

  it('records TOOL_CALLS success metric (no service label — this tool is the catalog)', async () => {
    registerDiscoverServicesTool(
      server as unknown as McpServer,
      makeRegistry([{ service: 'a', description: 'A' }]),
      silentLogger,
      metrics as unknown as MetricsRegistry
    )

    await server.handlers[TOOL.DISCOVER_SERVICES]!.handler({}, {})
    expect(metrics.increment).toHaveBeenCalledTimes(1)
    expect(metrics.increment).toHaveBeenCalledWith(METRIC.TOOL_CALLS, {
      tool: TOOL.DISCOVER_SERVICES,
      outcome: OUTCOME.SUCCESS
    })
  })

  it('reflects live registry changes on each call', async () => {
    let catalog: Array<{ service: string; description: string }> = [{ service: 'a', description: 'A' }]
    const registry = {
      listServices: () => catalog,
      serviceNames: () => catalog.map(e => e.service)
    } as unknown as ServiceRegistry

    registerDiscoverServicesTool(
      server as unknown as McpServer,
      registry,
      silentLogger,
      metrics as unknown as MetricsRegistry
    )

    const first = await server.handlers[TOOL.DISCOVER_SERVICES]!.handler({}, {})
    expect(JSON.parse(first.content[0]!.text)).toHaveLength(1)

    catalog = [
      { service: 'a', description: 'A' },
      { service: 'b', description: 'B' }
    ]
    const second = await server.handlers[TOOL.DISCOVER_SERVICES]!.handler({}, {})
    expect(JSON.parse(second.content[0]!.text)).toHaveLength(2)
  })
})
