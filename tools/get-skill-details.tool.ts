// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { ServiceRegistry } from '../runtime/registry/service-registry.js'
import type { Logger } from '../runtime/observability/logger.js'
import type { MetricsCollector } from '../core/types/metrics.types.js'
import { mcpError, mcpSuccess, extractCorrelationId, resolveService, isToolError, validateAuth } from './tool-helpers.js'
import { TOOL, LOG_PREFIX, ERR, METRIC, OUTCOME } from '../core/constants.js'

const DESCRIPTION = `Retrieves the full Markdown SOP for a specific skill.
If discover_skills() returned a relevant skill, read it here to understand business rules,
required fields, and constraints BEFORE looking for technical API details with search_code().

Using skills is recommended but not mandatory. If no skills matched, proceed directly
to search_code().

IMPORTANT: You MUST provide both "service" and "skill_id". The skill_id comes from
the results of discover_skills().

Returns the complete Markdown content of the skill document — including step-by-step
instructions, business rules, required fields, and constraints.`

export function registerGetSkillDetailsTool(
  server: McpServer,
  registry: ServiceRegistry,
  logger: Logger,
  metrics: MetricsCollector,
  clientToken?: string
): void {
  const serviceNames = registry.serviceNames()

  server.registerTool(
    TOOL.GET_SKILL_DETAILS,
    { description: DESCRIPTION, inputSchema: { service: z.string(), skill_id: z.string() } },
    async ({ service, skill_id }, extra) => {
      const correlationId = extractCorrelationId(extra)

      logger.info(
        { correlationId, tool: TOOL.GET_SKILL_DETAILS, service, skill_id },
        `${LOG_PREFIX.MCP_IN} ${TOOL.GET_SKILL_DETAILS} — fetching skill SOP`
      )

      const svcResources = resolveService(registry, service, serviceNames)
      if (isToolError(svcResources)) {
        metrics.increment(METRIC.TOOL_CALLS, { tool: TOOL.GET_SKILL_DETAILS, service, outcome: OUTCOME.ERROR })
        return svcResources
      }

      const authResult = await validateAuth(svcResources, clientToken, correlationId, logger, TOOL.GET_SKILL_DETAILS)
      if ('isError' in authResult) {
        metrics.increment(METRIC.TOOL_CALLS, { tool: TOOL.GET_SKILL_DETAILS, service, outcome: OUTCOME.ERROR })
        return authResult
      }

      const skills = svcResources.skillStore.getSkills()
      const skill = skills.find(s => s.id === skill_id)
      if (!skill) {
        const available = skills.map(s => s.id).join(', ')
        metrics.increment(METRIC.TOOL_CALLS, { tool: TOOL.GET_SKILL_DETAILS, service, outcome: OUTCOME.ERROR })
        return mcpError(
          `Skill "${skill_id}" not found in service "${service}". Available: ${available || '(none)'}`,
          ERR.UNKNOWN_SKILL
        )
      }

      logger.info(
        { correlationId, tool: TOOL.GET_SKILL_DETAILS, service, skill_id, contentLength: skill.content.length },
        `${LOG_PREFIX.MCP_OUT} ${TOOL.GET_SKILL_DETAILS} — full SOP returned`
      )

      metrics.increment(METRIC.TOOL_CALLS, { tool: TOOL.GET_SKILL_DETAILS, service, outcome: OUTCOME.SUCCESS })
      return mcpSuccess(skill.content)
    }
  )
}
