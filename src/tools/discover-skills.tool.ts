// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {McpServer} from '@modelcontextprotocol/server'
import type {ServiceRegistry} from '../runtime/registry/service-registry.js'
import type {Logger} from '../runtime/observability/logger.js'
import type {MetricsCollector} from '../core/types/metrics.types.js'
import {runSkillsSearchInSandbox} from '../runtime/sandbox/skills-search-in-sandbox.js'
import {extractCorrelationId, isToolError, resolveService, runSandboxTool, serviceCodeSchema} from './tool-helpers.js'
import {LOG_PREFIX, TOOL} from '../core/constants.js'

export function registerDiscoverSkillsTool(
    server: McpServer,
    registry: ServiceRegistry,
    logger: Logger,
    metrics: MetricsCollector,
    clientToken?: string
): void {
    const serviceNames = registry.serviceNames()

    const DESCRIPTION = `Searches for high-level business workflows and SOPs within a service
by writing a JavaScript async arrow function. Use it to find the logical "How-To" steps
for a task. Returns Agent Skill names and descriptions.

Not every scenario has a matching skill. Using this tool is OPTIONAL, although RECOMMENDED.
If no relevant skills are found, skip directly to search_code(). Exception: a service
description returned by discover_services() may declare one or more mandatory prerequisite
Skills. For those services, discover and read each required Skill before any other
service-scoped tool call.

REQUIRED: "service" and "code".
Available services: ${serviceNames.join(', ')}

You have access to a 'skills' array — all indexed skill documents for the chosen service.

skills structure:
  skills                             → array of skill objects
  skills[0].name                     → string (e.g. "manage-campaigns")
  skills[0].description              → string (what the skill does and when to use it)
  skills[0].metadata                 → object with string values (optional)
  skills[0].metadata.tags            → comma-separated string tags (optional)
  skills[0].license                  → string (optional)
  skills[0].compatibility            → string (optional)
  skills[0]["allowed-tools"]         → string (optional)
  skills[0].content                  → string (Markdown instruction body)
  skills[0].filename                 → string (e.g. "manage-campaigns.md")

Pattern 1 — find skills by keyword:
async () => {
  return skills
    .filter(s =>
      s.description.toLowerCase().includes('campaign') ||
      s.metadata?.tags?.toLowerCase().includes('campaign') ||
      s.content.toLowerCase().includes('campaign')
    )
    .map(s => ({ skill_name: s.name, description: s.description }))
}

Pattern 2 — find skills mentioning a specific API path:
async () => {
  return skills
    .filter(s => s.content.includes('/api/v1/tasks'))
    .map(s => ({
      skill_name: s.name,
      description: s.description,
      snippet: s.content.split('\\n').filter(l => l.trim()).slice(0, 5).join('\\n')
    }))
}

Pattern 3 — list all skills when the name is unknown:
async () => {
  return skills.map(s => ({ skill_name: s.name, description: s.description }))
}

Skills are discovered by this tool; search_code() does not discover Skills and cannot
provide a skill_name. After finding a relevant Skill, call
get_skill_details({ service, skill_name }) to read its full instructions before
searching or executing its API workflow.`

    server.registerTool(
        TOOL.DISCOVER_SKILLS,
        {description: DESCRIPTION, inputSchema: serviceCodeSchema},
        async ({service, code}, ctx) => {
            const correlationId = extractCorrelationId(ctx)

            logger.info(
                {correlationId, tool: TOOL.DISCOVER_SKILLS, service, codeReceived: code},
                `${LOG_PREFIX.MCP_IN} ${TOOL.DISCOVER_SKILLS} — code received from AI client`
            )

            const svcResources = resolveService(registry, service, serviceNames)
            if (isToolError(svcResources)) return svcResources

            return runSandboxTool(
                {
                    tool: TOOL.DISCOVER_SKILLS,
                    service,
                    resources: svcResources,
                    clientToken,
                    correlationId,
                    logger,
                    metrics
                },
                async () => runSkillsSearchInSandbox(code, svcResources.skillStore.getSkills(), svcResources.sandboxLimits)
            )
        }
    )
}
