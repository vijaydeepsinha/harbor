// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Logger } from '../observability/logger.js'
import type { ServiceRegistry } from '../registry/service-registry.js'

export interface StdioGatewayOptions {
  /** Pre-authenticated personal access token. In stdio mode auth is established once, out-of-band. */
  clientToken: string
  createMcpServer: (clientToken: string) => McpServer
  registry: ServiceRegistry
  logger: Logger
}

/**
 * Boots the MCP gateway on stdio. Unlike HTTP there is no session map —
 * the process itself *is* the session, and the token is supplied by the
 * launching parent (`MCP_TOKEN` env var).
 */
export async function startStdioGateway(opts: StdioGatewayOptions): Promise<void> {
  const { clientToken, createMcpServer, registry, logger } = opts
  const transport = new StdioServerTransport()
  await createMcpServer(clientToken).connect(transport)
  logger.info({ services: registry.serviceNames() }, 'Harbor ready (stdio)')
}
