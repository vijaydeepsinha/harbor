// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { ServiceRegistry } from '../runtime/registry/service-registry.js'
import type { Logger } from '../runtime/observability/logger.js'
import type { MetricsCollector } from '../core/types/metrics.types.js'
import { runSkillsSearchInSandbox } from '../runtime/sandbox/skills-search-in-sandbox.js'
import {
  extractCorrelationId,
  resolveService,
  isToolError,
  runSandboxTool
} from './tool-helpers.js'
import { TOOL, LOG_PREFIX } from '../core/constants.js'

export function registerDiscoverSkillsTool(
  server: McpServer,
  registry: ServiceRegistry,
  logger: Logger,
  metrics: MetricsCollector,
  clientToken?: string
): void {
  const serviceNames = registry.serviceNames()

  const DESCRIPTION = `Searches for high-level business workflows and SOPs within a service
by writing a JavaScript async arrow function. Use this to find the logical "How-To" steps
for a task. Returns skill IDs and descriptions.

Not every scenario has a matching skill. Using this tool is RECOMMENDED but NOT MANDATORY.
If no relevant skills are found, you can skip directly to search_code().

IMPORTANT: You MUST provide the "service" parameter.
Available services: ${serviceNames.join(', ')}

You have access to a 'skills' array — all indexed skill documents for the chosen service.

skills structure:
  skills                             → array of skill objects
  skills[0].id                       → string (e.g. "manage-campaigns")
  skills[0].title                    → string (e.g. "Manage Campaigns")
  skills[0].tags                     → array of string tags (e.g. ["marketing", "campaigns"])
  skills[0].content                  → string (full Markdown body)
  skills[0].filename                 → string (e.g. "manage-campaigns.md")

Pattern 1 — find skills by keyword:
async () => {
  return skills
    .filter(s => s.content.toLowerCase().includes('campaign'))
    .map(s => ({ skill_id: s.id, title: s.title }))
}

Pattern 2 — find skills mentioning a specific API path:
async () => {
  return skills
    .filter(s => s.content.includes('/api/v1/tasks'))
    .map(s => ({
      skill_id: s.id,
      title: s.title,
      snippet: s.content.split('\\n').filter(l => l.trim()).slice(0, 5).join('\\n')
    }))
}

Pattern 3 — list all skills with their IDs:
async () => {
  return skills.map(s => ({ skill_id: s.id, title: s.title }))
}

After finding the relevant skill, use get_skill_details() to read the full SOP.`

  server.registerTool(
    TOOL.DISCOVER_SKILLS,
    { description: DESCRIPTION, inputSchema: { service: z.string(), code: z.string() } },
    async ({ service, code }, extra) => {
      const correlationId = extractCorrelationId(extra)

      logger.info(
        { correlationId, tool: TOOL.DISCOVER_SKILLS, service, codeReceived: code },
        `${LOG_PREFIX.MCP_IN} ${TOOL.DISCOVER_SKILLS} — code received from AI client`
      )

      const svcResources = resolveService(registry, service, serviceNames)
      if (isToolError(svcResources)) return svcResources

      return runSandboxTool(
        { tool: TOOL.DISCOVER_SKILLS, service, resources: svcResources, clientToken, correlationId, logger, metrics },
        async () => runSkillsSearchInSandbox(code, svcResources.skillStore.getSkills(), svcResources.sandboxLimits)
      )
    }
  )
}
