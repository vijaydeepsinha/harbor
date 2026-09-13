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
import { GATEWAY_NAME, GATEWAY_VERSION, TOOL } from '../../core/constants.js'
import { errorMessage } from '../../core/utils/errors.js'

/** Options accepted by the `McpServer` constructor's second argument. */
type McpServerOptions = NonNullable<ConstructorParameters<typeof McpServer>[1]>

/**
 * Static MCP server options (spec §15/§16). Pure and side-effect free so it can
 * be unit-tested without booting a transport.
 *
 * - `capabilities`: Harbor exposes ONLY tools — no prompts/resources/logging —
 *   so it advertises exactly `{ tools: {} }`. `server/discover` and `tools/list`
 *   are then answered by the SDK from the registered tool surface. Advertising
 *   nothing Harbor does not implement is an explicit §15 requirement.
 * - `instructions`: the real 5-tool discovery→execute workflow, surfaced through
 *   discovery so clients drive the gateway correctly.
 * - `cacheHints`: conservative and explicit for the two cacheable operations
 *   Harbor actually serves (`tools/list`, `server/discover`). The fixed 5-tool
 *   surface only changes on restart, but the client cannot know that, so the
 *   hint stays at the conservative defaults — private scope, no shared caching,
 *   `ttlMs: 0`. No aggressive TTL is invented (§16).
 */
export function buildMcpServerOptions(): McpServerOptions {
  return {
    capabilities: { tools: {} },
    instructions:
      'Harbor is an MCP gateway to backend services. Workflow: ' +
      '1) discover_services() to list backends; ' +
      '2) discover_skills() + get_skill_details() for business SOPs (optional); ' +
      '3) search_code() to find exact endpoints; ' +
      '4) api_execute() to run an authenticated call against a chosen service. ' +
      'Always pass the "service" parameter to api_execute and use only paths confirmed by search_code().',
    cacheHints: {
      'tools/list': { ttlMs: 0, cacheScope: 'private' },
      'server/discover': { ttlMs: 0, cacheScope: 'private' }
    }
  }
}

/**
 * Factory signature shared by HTTP (`createMcpHandler`) and stdio
 * (`serveStdio`). Named distinctly from the SDK's own exported
 * `McpServerFactory` type (narrower here — synchronous, no `Promise` return)
 * to avoid ambiguity between the two similarly-named types.
 */
export type GatewayMcpServerFactory = (ctx: McpRequestContext) => McpServer

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
export function buildMcpServerFactory(opts: BuildMcpServerFactoryOptions): GatewayMcpServerFactory {
  const { registry, globalConfig, logger, metrics, stdioToken = '' } = opts

  return (ctx: McpRequestContext) => {
    const clientToken = ctx.authInfo?.token ?? stdioToken
    const mcpServer = new McpServer({ name: GATEWAY_NAME, version: GATEWAY_VERSION }, buildMcpServerOptions())

    // Each tool is registered in its own try/catch: a construction-time throw
    // from one tool (e.g. a schema-construction error) must not abort
    // registration of the other four — it degrades to "N of 5 tools
    // available" for this request/connection instead of zero.
    const registrations: Array<[string, () => void]> = [
      [TOOL.DISCOVER_SERVICES, () => registerDiscoverServicesTool(mcpServer, registry, logger, metrics)],
      [TOOL.DISCOVER_SKILLS, () => registerDiscoverSkillsTool(mcpServer, registry, logger, metrics, clientToken)],
      [TOOL.GET_SKILL_DETAILS, () => registerGetSkillDetailsTool(mcpServer, registry, logger, metrics, clientToken)],
      [TOOL.SEARCH_CODE, () => registerSearchCodeTool(mcpServer, registry, logger, metrics, clientToken)],
      [TOOL.API_EXECUTE, () => registerExecuteApiTool(mcpServer, registry, globalConfig, logger, metrics, clientToken)]
    ]

    for (const [toolName, register] of registrations) {
      try {
        register()
      } catch (err) {
        logger.error({ tool: toolName, error: errorMessage(err) }, 'Tool registration failed — continuing with remaining tools')
      }
    }

    return mcpServer
  }
}
