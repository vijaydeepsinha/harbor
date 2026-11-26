// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {McpServer} from '@modelcontextprotocol/server'
import {z} from 'zod'
import type {ServiceRegistry} from '../runtime/registry/service-registry.js'
import type {Logger} from '../runtime/observability/logger.js'
import type {MetricsCollector} from '../core/types/metrics.types.js'
import {extractCorrelationId, isToolError, mcpError, mcpSuccess, resolveService, validateAuth} from './tool-helpers.js'
import {ERR, LOG_PREFIX, METRIC, OUTCOME, TOOL, UNKNOWN_SERVICE_LABEL} from '../core/constants.js'

const DESCRIPTION = `Returns the Markdown instruction body for a specific Agent Skill name.
Call only after discover_skills() gave you a skill_name. Read this BEFORE search_code() to learn business rules, required fields, and constraints.

REQUIRED: "service" and "skill_name" (obtained from discover_skills() results).

This call is optional for most tasks and most services — if discover_skills() found
no relevant Skill, go directly to search_code(). Exception: some services declare one
or more mandatory prerequisite Skills that must be read before any other service
tool call. Check the service description from discover_services before treating Skill
discovery or reading as optional.
If skill_name is unknown or get_skill_details fails, go back to discover_skills() — search by keyword or list every skill name and description. Do not guess a skill_name, and do not expect the not-found error to provide descriptions.

Returns: complete Markdown with step-by-step instructions, business rules, and constraints.`

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
        {description: DESCRIPTION, inputSchema: z.object({service: z.string(), skill_name: z.string()})},
        async ({service, skill_name: skillName}, ctx) => {
            const correlationId = extractCorrelationId(ctx)

            logger.info(
                {correlationId, tool: TOOL.GET_SKILL_DETAILS, service, skill_name: skillName},
                `${LOG_PREFIX.MCP_IN} ${TOOL.GET_SKILL_DETAILS} — fetching skill SOP`
            )

            const svcResources = resolveService(registry, service, serviceNames)
            if (isToolError(svcResources)) {
                // The name is caller input: labelling metrics with it would mint a new series per made-up name.
                metrics.increment(METRIC.TOOL_CALLS, {
                    tool: TOOL.GET_SKILL_DETAILS,
                    service: UNKNOWN_SERVICE_LABEL,
                    outcome: OUTCOME.ERROR
                })
                return svcResources
            }

            const authResult = await validateAuth(svcResources, clientToken, correlationId, logger, TOOL.GET_SKILL_DETAILS)
            if ('isError' in authResult) {
                metrics.increment(METRIC.TOOL_CALLS, {tool: TOOL.GET_SKILL_DETAILS, service, outcome: OUTCOME.ERROR})
                return authResult
            }

            const skills = svcResources.skillStore.getSkills()
            const skill = skills.find(s => s.name === skillName)
            if (!skill) {
                const available = skills.map(s => s.name).join(', ')
                metrics.increment(METRIC.TOOL_CALLS, {tool: TOOL.GET_SKILL_DETAILS, service, outcome: OUTCOME.ERROR})
                return mcpError(
                    `Skill "${skillName}" not found in service "${service}". Available: ${available || '(none)'}`,
                    ERR.UNKNOWN_SKILL
                )
            }

            logger.info(
                {correlationId, tool: TOOL.GET_SKILL_DETAILS, service, skill_name: skillName, contentLength: skill.content.length},
                `${LOG_PREFIX.MCP_OUT} ${TOOL.GET_SKILL_DETAILS} — full SOP returned`
            )

            metrics.increment(METRIC.TOOL_CALLS, {tool: TOOL.GET_SKILL_DETAILS, service, outcome: OUTCOME.SUCCESS})
            return mcpSuccess(skill.content)
        }
    )
}
