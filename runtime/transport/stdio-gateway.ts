// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { serveStdio } from '@modelcontextprotocol/server/stdio'
import type { Logger } from '../observability/logger.js'
import type { ServiceRegistry } from '../registry/service-registry.js'
import type { GatewayMcpServerFactory } from '../http/mcp-server-factory.js'
import { errorMessage } from '../../core/utils/errors.js'

export interface StdioGatewayOptions {
  createMcpServer: GatewayMcpServerFactory
  registry: ServiceRegistry
  logger: Logger
}

/**
 * Boots the MCP gateway on stdio using the SDK v2 `serveStdio` entry
 * (`legacy: 'reject'` — 2026-07-28 only). Unlike HTTP there is no session
 * map — the process itself *is* the connection, and the token is supplied by
 * the launching parent (`MCP_TOKEN` env var) via the factory fallback.
 */
export async function startStdioGateway(opts: StdioGatewayOptions): Promise<void> {
  const { createMcpServer, registry, logger } = opts
  serveStdio(createMcpServer, {
    legacy: 'reject',
    onerror: (error: Error) => logger.error({ error: errorMessage(error) }, 'stdio MCP connection error')
  })
  logger.info({ services: registry.serviceNames() }, 'Harbor ready (stdio, MCP 2026-07-28)')
}
