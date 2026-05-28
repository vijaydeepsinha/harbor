// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ServiceRegistry } from '../runtime/registry/service-registry.js'
import type { Logger } from '../runtime/observability/logger.js'
import type { MetricsCollector } from '../core/types/metrics.types.js'
import { mcpSuccess } from './tool-helpers.js'
import { TOOL, LOG_PREFIX, METRIC, OUTCOME } from '../core/constants.js'

const DESCRIPTION = `Lists all available service namespaces (e.g., "tasks", "billing", "jira").
Use this FIRST to understand which domain the user is asking about.

Returns an array of objects with the service key and a description of what each service covers.
Pass the "service" value to the other tools: discover_skills, get_skill_details, search_code,
and api_execute.

Recommended flow:
  1. discover_services()                             → pick the right service
  2. discover_skills(service, code)                  → (optional) find business SOPs if available
  3. get_skill_details(service, skill_id)            → (optional) read the full How-To
  4. search_code(service, code)                      → find exact endpoints & payloads
  5. api_execute(service, code)                      → execute against the backend

Not every scenario has a matching skill. If you find relevant skills, read them before
proceeding; otherwise skip directly to search_code().`

export function registerDiscoverServicesTool(
  server: McpServer,
  registry: ServiceRegistry,
  logger: Logger,
  metrics: MetricsCollector
): void {
  server.registerTool(
    TOOL.DISCOVER_SERVICES,
    { description: DESCRIPTION },
    async () => {
      const services = registry.listServices()

      logger.info(
        { tool: TOOL.DISCOVER_SERVICES, serviceCount: services.length },
        `${LOG_PREFIX.MCP_OUT} ${TOOL.DISCOVER_SERVICES} — returning service catalog`
      )

      // No "service" label — this tool is the catalog itself.
      metrics.increment(METRIC.TOOL_CALLS, { tool: TOOL.DISCOVER_SERVICES, outcome: OUTCOME.SUCCESS })
      return mcpSuccess(services)
    }
  )
}
