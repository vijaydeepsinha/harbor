// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { McpServer, type McpRequestContext } from '@modelcontextprotocol/server'
import type { GlobalConfig } from '../../core/types/config.types.js'
import type { Logger } from '../observability/logger.js'
import type { MetricsCollector } from '../../core/types/metrics.types.js'
import type { ServiceRegistry } from '../registry/service-registry.js'
import { registerDiscoverServicesTool } from '../../tools/discover-services.tool.js'
import { registerDiscoverSkillsTool } from '../../tools/discover-skills.tool.js'
import { registerGetSkillDetailsTool } from '../../tools/get-skill-details.tool.js'
import { registerSearchCodeTool } from '../../tools/search-code.tool.js'
import { registerExecuteApiTool } from '../../tools/execute-api.tool.js'
import { GATEWAY_NAME } from '../../core/constants.js'

/** Factory signature shared by HTTP (`createMcpHandler`) and stdio (`serveStdio`). */
export type McpServerFactory = (ctx: McpRequestContext) => McpServer

export interface BuildMcpServerFactoryOptions {
  registry: ServiceRegistry
  globalConfig: GlobalConfig
  logger: Logger
  metrics: MetricsCollector
  /** Fallback token for stdio transport where `ctx.authInfo` is never set. */
  stdioToken?: string
}

/**
 * Builds a per-request MCP server factory. HTTP mode reads the validated bearer
 * from `ctx.authInfo`; stdio mode falls back to the pre-configured token.
 */
export function buildMcpServerFactory(opts: BuildMcpServerFactoryOptions): McpServerFactory {
  const { registry, globalConfig, logger, metrics, stdioToken = '' } = opts

  return (ctx: McpRequestContext) => {
    const clientToken = ctx.authInfo?.token ?? stdioToken
    const mcpServer = new McpServer({ name: GATEWAY_NAME, version: '1.0.0' })
    registerDiscoverServicesTool(mcpServer, registry, logger, metrics)
    registerDiscoverSkillsTool(mcpServer, registry, logger, metrics, clientToken)
    registerGetSkillDetailsTool(mcpServer, registry, logger, metrics, clientToken)
    registerSearchCodeTool(mcpServer, registry, logger, metrics, clientToken)
    registerExecuteApiTool(mcpServer, registry, globalConfig, logger, metrics, clientToken)
    return mcpServer
  }
}
