// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {McpServer} from '@modelcontextprotocol/server'
import type {ServiceRegistry} from '../runtime/registry/service-registry.js'
import type {Logger} from '../runtime/observability/logger.js'
import type {MetricsCollector} from '../core/types/metrics.types.js'
import {mcpSuccess} from './tool-helpers.js'
import {LOG_PREFIX, METRIC, OUTCOME, TOOL} from '../core/constants.js'

const DESCRIPTION = `Lists all registered service namespaces (e.g. "tasks", "billing").
Call this FIRST to identify which service covers the user's request.

Returns: array of { service, description } objects.

Recommended flow:
  1. discover_services()                    → find the right service
  2. discover_skills(service, code)         → (optional) find relevant Agent Skill names
  3. get_skill_details(service, skill_name) → (optional) read the full Skill instructions
  4. search_code(service, code)             → find exact endpoints and payload schemas
  5. api_execute(service, code)             → execute only confirmed API operations

Not every scenario has a matching skill. If you find relevant skills, read them before
proceeding; otherwise skip directly to search_code(). Exception: if the selected service
description says a Skill is a mandatory prerequisite, read that Skill before making any
other service-scoped tool call.`

export function registerDiscoverServicesTool(
    server: McpServer,
    registry: ServiceRegistry,
    logger: Logger,
    metrics: MetricsCollector
): void {
    server.registerTool(
        TOOL.DISCOVER_SERVICES,
        {description: DESCRIPTION},
        async () => {
            const services = registry.listServices()

            logger.info(
                {tool: TOOL.DISCOVER_SERVICES, serviceCount: services.length},
                `${LOG_PREFIX.MCP_OUT} ${TOOL.DISCOVER_SERVICES} — returning service catalog`
            )

            // No "service" label — this tool is the catalog itself.
            metrics.increment(METRIC.TOOL_CALLS, {tool: TOOL.DISCOVER_SERVICES, outcome: OUTCOME.SUCCESS})
            return mcpSuccess(services)
        }
    )
}
